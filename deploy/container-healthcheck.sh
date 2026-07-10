#!/bin/sh
set -eu

cmdline=$(tr '\000' ' ' </proc/1/cmdline)
if [ -n "${AVITO_MCP_TRANSPORT:-}" ]; then
  transport=$(printf '%s' "$AVITO_MCP_TRANSPORT" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
else
  case " $cmdline " in
    *' --http '* | *' --both '*) transport=http ;;
    *) transport=stdio ;;
  esac
fi
webhook_http=0
enabled=$(printf '%s' "${AVITO_MCP_WEBHOOK_ENABLED:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
secret=$(printf '%s' "${AVITO_MCP_WEBHOOK_SECRET:-}" | tr -d '[:space:]')
case "$enabled" in
  0 | false | no | off) ;;
  *)
    if [ -n "$secret" ]; then webhook_http=1; fi
    ;;
esac

if [ "$transport" = http ] || [ "$transport" = both ] || [ "$webhook_http" = 1 ]; then
  probe_host=${AVITO_MCP_HTTP_HOST:-127.0.0.1}
  case "$probe_host" in
    0.0.0.0) probe_host=127.0.0.1 ;;
    ::) probe_host=::1 ;;
  esac
  case "$probe_host" in
    *:*) probe_host="[$probe_host]" ;;
  esac
  wget -q -T 2 -O - "http://${probe_host}:${AVITO_MCP_HTTP_PORT:-3000}/readyz" |
    grep -q '"ok":true'
else
  kill -0 1
  state=$(cut -d ' ' -f 3 /proc/1/stat)
  case "$state" in T | t | Z | X | x) exit 1 ;; esac
  printf '%s' "$cmdline" | grep -q 'node dist/server.js'
fi
