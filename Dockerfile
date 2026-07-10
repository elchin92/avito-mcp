# avito-mcp — container image for the MCP server (stdio by default, optional HTTP).
#
# Used by registry indexers (e.g. Glama) to start the server and run introspection
# (tools/list) WITHOUT credentials — see v0.7.4. Also usable for self-hosting.
#
# stdio (default) — no ports needed; the client speaks over stdin/stdout:
#   docker build -t avito-mcp .
#   docker run --rm -i \
#     -e Client_id=... -e Client_secret=... -e Profile_id=... \
#     avito-mcp
#
# Remote MCP over HTTP (v0.9.0) — serve the tools over the network and publish
# port 3000 (Streamable HTTP MCP + OAuth 2.1 + webhook receiver):
#   docker run --rm \
#     -e Client_id=... -e Client_secret=... -e Profile_id=... \
#     -e AVITO_MCP_TRANSPORT=http \
#     -e AVITO_MCP_HTTP_HOST=0.0.0.0 \
#     -e AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com \
#     -e AVITO_MCP_OAUTH_OWNER_PASSWORD=... \
#     -p 127.0.0.1:3000:3000 \
#     avito-mcp
# Inside the container the app binds 0.0.0.0 so Docker's bridge can reach it;
# host-side publishing stays loopback-only. Terminate TLS with a reverse proxy.
#
# Credentials are optional at startup: without them the server still serves
# tools/list / resources / prompts; API calls fail with CONFIG_ERROR until set.

# ---- build stage -------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# Install full deps (incl. dev) for the TypeScript build.
COPY package.json package-lock.json ./
RUN npm ci

# Build the distribution + tool manifest.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.scripts.json ./
RUN npm run build && npm run generate:manifest

# Drop dev dependencies for a lean runtime node_modules.
RUN npm prune --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/node \
    XDG_STATE_HOME=/home/node/.local/state

# Runtime artifacts. node_modules + dist (incl. generated manifest.json) come from
# the build stage; swaggers/ and docs/ are static and copied straight from context
# (they back the MCP resources). package.json is read by version.ts.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY swaggers ./swaggers
COPY docs ./docs
COPY deploy/container-healthcheck.sh /usr/local/bin/avito-mcp-healthcheck

RUN mkdir -p /home/node/.local/state/avito-mcp && \
    chown -R node:node /home/node/.local && \
    chmod 0555 /usr/local/bin/avito-mcp-healthcheck && \
    chmod -R a-w /app/node_modules /app/dist /app/swaggers /app/docs /app/package.json

# Default transport is stdio (stdin/stdout) — no port needed. When run with
# AVITO_MCP_TRANSPORT=http (or both) the server also listens on this port for the
# Streamable HTTP MCP endpoint / OAuth flow / webhook receiver; publish it with
# `-p 127.0.0.1:3000:3000`. Override the port via AVITO_MCP_HTTP_PORT.
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/avito-mcp-healthcheck"]
ENTRYPOINT ["node", "dist/server.js"]
