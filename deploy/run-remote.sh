#!/usr/bin/env bash
# Launch avito-mcp in remote HTTP mode using the test env in .remote.env.
# Avito creds come from .env (loaded by the app); HTTP/OAuth/webhook come from
# .remote.env. Runs in the foreground — use tmux/screen or `&` to background it.
set -euo pipefail
cd /srv/avito_mcp
set -a
# shellcheck disable=SC1091
source /srv/avito_mcp/.remote.env
set +a
exec node dist/server.js
