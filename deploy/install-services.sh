#!/usr/bin/env bash
# Install an immutable release and hardened systemd units transactionally.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SOURCE_ROOT=${AVITO_MCP_SOURCE_ROOT:-$(dirname "$SCRIPT_DIR")}
INSTALL_ROOT=/opt/avito-mcp
RELEASES_DIR=$INSTALL_ROOT/releases
CURRENT_LINK=$INSTALL_ROOT/current
CONFIG_DIR=/etc/avito-mcp
SERVICE_ENV=$CONFIG_DIR/avito-mcp.env
STATE_DIR=/var/lib/avito-mcp
HEALTH_BASE_URL=${AVITO_MCP_DEPLOY_HEALTH_URL:-}
START_SERVICES=0
STAGING_DIR=
READY_FILE=
BACKUP_DIR=
STATE_CREATED=0
STATE_FROZEN=0
STATE_ORIGINAL_UID=
STATE_ORIGINAL_GID=
STATE_ORIGINAL_MODE=
TRANSACTION_ACTIVE=0
caddy_managed=0

if [[ "${1:-}" == "--start" ]]; then
  START_SERVICES=1
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--start]\n' "$0" >&2
  exit 2
fi

if [[ ${EUID} -ne 0 ]]; then
  printf 'install-services.sh must run as root\n' >&2
  exit 1
fi

# Only one process may stage/switch/rollback the shared release tree at a time.
# Lock the inode of a root-owned private directory: no pathname truncation and no
# pre-planted symlink in the shared /run/lock directory.
LOCK_DIR=/run/lock/avito-mcp
if ! mkdir -m 0700 "$LOCK_DIR" 2>/dev/null; then
  if [[ ! -d "$LOCK_DIR" || -L "$LOCK_DIR" || "$(stat -c %u "$LOCK_DIR")" != 0 ]]; then
    printf 'Unsafe deployment lock directory: %s\n' "$LOCK_DIR" >&2
    exit 1
  fi
  chmod 0700 "$LOCK_DIR"
fi
exec 9<"$LOCK_DIR"
if ! flock -n 9; then
  printf 'Another avito-mcp deployment is already running\n' >&2
  exit 1
fi

for path in \
  "$SOURCE_ROOT/.env" \
  "$SOURCE_ROOT/.remote.env" \
  "$SOURCE_ROOT/package.json" \
  "$SOURCE_ROOT/package-lock.json" \
  "$SOURCE_ROOT/dist/server.js"; do
  if [[ ! -e "$path" ]]; then
    printf 'Required release file is missing: %s\n' "$path" >&2
    exit 1
  fi
done

version=$(node -p "require(process.argv[1]).version" "$SOURCE_ROOT/package.json")
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  printf 'Refusing unsafe package version: %s\n' "$version" >&2
  exit 1
fi
release_dir=$RELEASES_DIR/$version

cleanup() {
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then
    rm -rf -- "$STAGING_DIR"
  fi
  if [[ -n "$READY_FILE" ]]; then
    rm -f -- "$READY_FILE"
  fi
  if [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]]; then
    rm -rf -- "$BACKUP_DIR"
  fi
}

ensure_user() {
  local user=$1
  local home=$2
  if ! getent group "$user" >/dev/null; then
    groupadd --system "$user"
  fi
  if ! id -u "$user" >/dev/null 2>&1; then
    useradd --system --gid "$user" --home-dir "$home" --shell /usr/sbin/nologin "$user"
  fi
}

prepare_private_home() {
  local user=$1
  local home=$2
  if [[ -L "$home" || ( -e "$home" && ! -d "$home" ) ]]; then
    printf 'Unsafe service home: %s\n' "$home" >&2
    return 1
  fi
  install -d -o "$user" -g "$user" -m 0700 "$home"
}

validate_private_state() {
  local user=$1
  local state_dir=$2
  local allow_root=$3
  local app_uid app_gid entries state_dev path dev mode links uid gid type

  app_uid=$(id -u "$user")
  app_gid=$(id -g "$user")
  state_dev=$(stat -c %d -- "$state_dir")
  entries=$BACKUP_DIR/state.entries
  find -P "$state_dir" -xdev -print0 >"$entries"
  while IFS= read -r -d '' path; do
    IFS=: read -r dev mode links uid gid < <(stat -c '%d:%f:%h:%u:%g' -- "$path")
    type=$((16#$mode & 0170000))
    if [[ "$dev" != "$state_dev" ]]; then
      printf 'Application state has a foreign device\n' >&2
      return 1
    fi
    if [[ $allow_root -eq 1 ]]; then
      if [[ ! ( "$uid" == 0 || "$uid" == "$app_uid" ) || \
        ! ( "$gid" == 0 || "$gid" == "$app_gid" ) ]]; then
        printf 'Application state has a foreign owner\n' >&2
        return 1
      fi
    elif [[ "$uid" != "$app_uid" || "$gid" != "$app_gid" ]]; then
      printf 'Application state ownership migration is incomplete\n' >&2
      return 1
    fi
    case "$type" in
      16384) ;;
      32768)
        if [[ "$links" != 1 ]]; then
          printf 'Application state contains a hard-linked file\n' >&2
          return 1
        fi
        ;;
      *)
        printf 'Application state contains a symlink or special file\n' >&2
        return 1
        ;;
    esac
  done <"$entries"
}

migrate_private_state() {
  local user=$1
  local state_dir=$2
  local app_uid app_gid mount_match

  if [[ -L "$state_dir" || ( -e "$state_dir" && ! -d "$state_dir" ) ]]; then
    printf 'Unsafe application state path: %s\n' "$state_dir" >&2
    return 1
  fi
  if [[ ! -e "$state_dir" ]]; then
    STATE_CREATED=1
    install -d -o root -g root -m 0700 "$state_dir"
  fi

  # Recursive ownership must never cross an exact/nested mount or touch an
  # inode outside the dedicated state filesystem.
  if ! mount_match=$(awk -v root="$state_dir" \
    '$5 == root || index($5, root "/") == 1 { print "mounted"; exit }' \
    /proc/self/mountinfo); then
    printf 'Unable to validate application state mounts\n' >&2
    return 1
  fi
  if [[ -n "$mount_match" ]]; then
    printf 'Application state tree contains a mount: %s\n' "$state_dir" >&2
    return 1
  fi

  app_uid=$(id -u "$user")
  app_gid=$(id -g "$user")
  STATE_ORIGINAL_UID=$(stat -c %u -- "$state_dir")
  STATE_ORIGINAL_GID=$(stat -c %g -- "$state_dir")
  STATE_ORIGINAL_MODE=$(stat -c %a -- "$state_dir")
  if [[ ! ( "$STATE_ORIGINAL_UID" == 0 || "$STATE_ORIGINAL_UID" == "$app_uid" ) || \
    ! ( "$STATE_ORIGINAL_GID" == 0 || "$STATE_ORIGINAL_GID" == "$app_gid" ) ]]; then
    printf 'Application state has a foreign owner\n' >&2
    return 1
  fi

  # systemctl stop quiesces the service cgroup. Freezing the top directory before
  # the recursive scan also blocks new pathname access; processes outside that
  # cgroup with a pre-opened dirfd are outside the deployment trust boundary.
  STATE_FROZEN=1
  chown root:root "$state_dir"
  chmod 0700 "$state_dir"
  validate_private_state "$user" "$state_dir" 1

  find -P "$state_dir" -xdev -mindepth 1 \
    -exec chown --no-dereference "$app_uid:$app_gid" {} +
  find -P "$state_dir" -xdev -mindepth 1 -type d -exec chmod 0700 {} +
  find -P "$state_dir" -xdev -mindepth 1 -type f -exec chmod 0600 {} +

  # Change the top directory last. A crash before this point leaves root as the
  # owner, so StateDirectory= completes any partial recursive migration on boot.
  chown "$app_uid:$app_gid" "$state_dir"
  chmod 0700 "$state_dir"
  validate_private_state "$user" "$state_dir" 0

  # Ownership-only migration is compatible with both the legacy root unit and
  # the hardened service user, so content is never rolled back or replaced.
  STATE_FROZEN=0
  STATE_CREATED=0
}

restore_file() {
  local existed=$1
  local backup=$2
  local destination=$3
  rm -rf -- "$destination"
  if [[ $existed -eq 1 ]]; then
    cp -a -- "$backup" "$destination"
  fi
}

rollback_release() {
  [[ $TRANSACTION_ACTIVE -eq 1 ]] || return 0
  TRANSACTION_ACTIVE=0
  set +e

  # Stop the new process before restoring unit files/current release.
  systemctl stop avito-mcp.service >/dev/null 2>&1
  if [[ $STATE_CREATED -eq 1 ]]; then
    rm -rf --one-file-system -- "$STATE_DIR"
    STATE_CREATED=0
  fi
  if [[ $STATE_FROZEN -eq 1 && -d "$STATE_DIR" ]]; then
    chown "$STATE_ORIGINAL_UID:$STATE_ORIGINAL_GID" "$STATE_DIR"
    chmod "$STATE_ORIGINAL_MODE" "$STATE_DIR"
    STATE_FROZEN=0
  fi

  restore_file "$had_app_unit" "$BACKUP_DIR/avito-mcp.service" \
    /etc/systemd/system/avito-mcp.service
  restore_file "$had_service_env" "$BACKUP_DIR/avito-mcp.env" "$SERVICE_ENV"
  if [[ $caddy_managed -eq 1 ]]; then
    restore_file "$had_caddy_unit" "$BACKUP_DIR/caddy.service" \
      /etc/systemd/system/caddy.service
    restore_file "$had_caddy_config" "$BACKUP_DIR/avito-mcp.Caddyfile" \
      /etc/caddy/avito-mcp.Caddyfile
  fi

  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    local rollback_link=$INSTALL_ROOT/.rollback.$$
    rm -f -- "$rollback_link"
    ln -s "$previous_release" "$rollback_link"
    mv -Tf "$rollback_link" "$CURRENT_LINK"
  else
    rm -f -- "$CURRENT_LINK"
  fi

  systemctl daemon-reload
  if [[ $app_was_enabled -eq 0 ]]; then systemctl disable avito-mcp.service >/dev/null 2>&1; fi
  if [[ $app_was_active -eq 1 ]]; then
    systemctl restart avito-mcp.service
  else
    systemctl stop avito-mcp.service >/dev/null 2>&1
  fi
  if [[ $caddy_managed -eq 1 ]]; then
    if [[ $caddy_was_enabled -eq 0 ]]; then systemctl disable caddy.service >/dev/null 2>&1; fi
    if [[ $caddy_was_active -eq 1 ]]; then
      systemctl restart caddy.service
    else
      systemctl stop caddy.service >/dev/null 2>&1
    fi
  fi
  set -e
}

on_error() {
  local status=$?
  trap - ERR HUP INT TERM
  rollback_release
  exit "$status"
}

on_signal() {
  local status=$1
  trap - ERR HUP INT TERM
  rollback_release
  exit "$status"
}

trap cleanup EXIT
trap on_error ERR
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

ensure_user avito-mcp "$STATE_DIR"
install -d -o root -g root -m 0755 "$INSTALL_ROOT" "$RELEASES_DIR"

# A version is immutable once installed. Re-running the installer reuses the
# same artifact; changed code must carry a new package version.
if [[ ! -d "$release_dir" ]]; then
  STAGING_DIR=$(mktemp -d "$RELEASES_DIR/.${version}.XXXXXX")
  install -o root -g root -m 0644 \
    "$SOURCE_ROOT/package.json" "$SOURCE_ROOT/package-lock.json" "$STAGING_DIR/"
  cp -a "$SOURCE_ROOT/dist" "$SOURCE_ROOT/docs" "$SOURCE_ROOT/swaggers" "$STAGING_DIR/"
  npm ci --prefix "$STAGING_DIR" --omit=dev --ignore-scripts --no-audit --no-fund
  chown -R root:root "$STAGING_DIR"
  # npm and mktemp inherit umask 077. Grant the service account read/traverse
  # access while keeping every release artifact root-owned and immutable.
  chmod -R a+rX,a-w "$STAGING_DIR"
  mv "$STAGING_DIR" "$release_dir"
  STAGING_DIR=
fi

previous_release=
if [[ -L "$CURRENT_LINK" ]]; then
  previous_release=$(readlink -f "$CURRENT_LINK")
elif [[ -e "$CURRENT_LINK" ]]; then
  printf '%s exists and is not a symlink; refusing atomic switch\n' "$CURRENT_LINK" >&2
  exit 1
fi

app_was_active=0
app_was_enabled=0
caddy_was_active=0
caddy_was_enabled=0
if systemctl is-active --quiet avito-mcp.service; then app_was_active=1; fi
if systemctl is-enabled --quiet avito-mcp.service; then app_was_enabled=1; fi
if systemctl is-active --quiet caddy.service; then caddy_was_active=1; fi
if systemctl is-enabled --quiet caddy.service; then caddy_was_enabled=1; fi

BACKUP_DIR=$(mktemp -d /var/tmp/avito-mcp-deploy.XXXXXX)
had_app_unit=0
had_service_env=0
had_caddy_unit=0
had_caddy_config=0
if [[ -e /etc/systemd/system/avito-mcp.service ]]; then
  cp -a /etc/systemd/system/avito-mcp.service "$BACKUP_DIR/avito-mcp.service"
  had_app_unit=1
fi
if [[ -e "$SERVICE_ENV" ]]; then
  cp -a "$SERVICE_ENV" "$BACKUP_DIR/avito-mcp.env"
  had_service_env=1
fi
if [[ -e /etc/systemd/system/caddy.service ]]; then
  cp -a /etc/systemd/system/caddy.service "$BACKUP_DIR/caddy.service"
  had_caddy_unit=1
fi
if [[ -e /etc/caddy/avito-mcp.Caddyfile ]]; then
  cp -a /etc/caddy/avito-mcp.Caddyfile "$BACKUP_DIR/avito-mcp.Caddyfile"
  had_caddy_config=1
fi

TRANSACTION_ACTIVE=1
install -d -o root -g root -m 0700 "$CONFIG_DIR"
filtered_env=$BACKUP_DIR/new-avito-mcp.env
rendered_health_url=$(node "$SOURCE_ROOT/deploy/render-service-env.mjs" \
  "$release_dir/package.json" "$SOURCE_ROOT/.env" "$SOURCE_ROOT/.remote.env" "$filtered_env")
if [[ -z "$HEALTH_BASE_URL" ]]; then HEALTH_BASE_URL=$rendered_health_url; fi
install -o root -g root -m 0600 "$filtered_env" "$SERVICE_ENV"
install -o root -g root -m 0644 \
  "$SOURCE_ROOT/deploy/avito-mcp.service" /etc/systemd/system/avito-mcp.service

if [[ -x /usr/local/bin/caddy && -f "$SOURCE_ROOT/deploy/Caddyfile" ]]; then
  caddy_managed=1
  ensure_user caddy /var/lib/caddy
  prepare_private_home caddy /var/lib/caddy
  if [[ -d /root/.local/share/caddy && ! -e /var/lib/caddy/.local/share/caddy ]]; then
    install -d -o caddy -g caddy -m 0700 /var/lib/caddy/.local/share
    cp -a /root/.local/share/caddy /var/lib/caddy/.local/share/caddy
    chown -R caddy:caddy /var/lib/caddy
  fi
  install -d -o root -g root -m 0755 /etc/caddy
  install -o root -g root -m 0644 \
    "$SOURCE_ROOT/deploy/Caddyfile" /etc/caddy/avito-mcp.Caddyfile
  install -o root -g root -m 0644 \
    "$SOURCE_ROOT/deploy/caddy.service" /etc/systemd/system/caddy.service
fi

systemd-analyze verify /etc/systemd/system/avito-mcp.service
if [[ $caddy_managed -eq 1 ]]; then
  systemd-analyze verify /etc/systemd/system/caddy.service
  /usr/local/bin/caddy validate --config /etc/caddy/avito-mcp.Caddyfile --adapter caddyfile
fi

# Freeze the legacy writer before validating and migrating its state ownership.
# systemctl still has the old unit definition because daemon-reload happens below.
if [[ $app_was_active -eq 1 ]]; then
  systemctl stop avito-mcp.service
fi
migrate_private_state avito-mcp "$STATE_DIR"
systemctl daemon-reload

# Switch only after config, units, and release layout pass static validation.
next_link=$INSTALL_ROOT/.current.$$
rm -f -- "$next_link"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$CURRENT_LINK"

start_app=$START_SERVICES
if [[ $app_was_active -eq 1 ]]; then start_app=1; fi
if [[ $start_app -eq 1 ]]; then
  if [[ $START_SERVICES -eq 1 ]]; then systemctl enable avito-mcp.service; fi
  systemctl restart avito-mcp.service

  READY_FILE=$(mktemp)
  ready=0
  for _ in $(seq 1 30); do
    if curl --fail --silent --connect-timeout 1 --max-time 2 \
      "$HEALTH_BASE_URL/readyz" >"$READY_FILE"; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ $ready -ne 1 ]]; then
    printf 'Post-deploy readiness check failed\n' >&2
    systemctl --no-pager --full status avito-mcp.service >&2 || true
    false
  fi

  curl --fail --silent --show-error --connect-timeout 1 --max-time 3 \
    "$HEALTH_BASE_URL/healthz" >"$READY_FILE"
  actual_version=$(node -e \
    "const fs=require('node:fs');const h=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(h.version??''))" \
    "$READY_FILE")
  if [[ "$actual_version" != "$version" ]]; then
    printf 'Post-deploy version mismatch: expected %s, got %s\n' "$version" "$actual_version" >&2
    false
  fi

  if [[ $caddy_managed -eq 1 && ( $START_SERVICES -eq 1 || $caddy_was_active -eq 1 ) ]]; then
    if [[ $START_SERVICES -eq 1 ]]; then systemctl enable caddy.service; fi
    systemctl restart caddy.service
  fi
fi

TRANSACTION_ACTIVE=0
STATE_CREATED=0
STATE_FROZEN=0
printf 'Immutable release %s installed at %s (start=%s)\n' \
  "$version" "$release_dir" "$START_SERVICES"
