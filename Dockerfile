# avito-mcp — container image for the stdio MCP server.
#
# Used by registry indexers (e.g. Glama) to start the server and run introspection
# (tools/list) WITHOUT credentials — see v0.7.4. Also usable for self-hosting:
#   docker build -t avito-mcp .
#   docker run --rm -i \
#     -e Client_id=... -e Client_secret=... -e Profile_id=... \
#     avito-mcp
#
# Credentials are optional at startup: without them the server still serves
# tools/list / resources / prompts; API calls fail with CONFIG_ERROR until set.

# ---- build stage -------------------------------------------------------------
FROM node:20-alpine AS build
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
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Runtime artifacts. node_modules + dist (incl. generated manifest.json) come from
# the build stage; swaggers/ and docs/ are static and copied straight from context
# (they back the MCP resources). package.json is read by version.ts.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY swaggers ./swaggers
COPY docs ./docs

# stdio transport on stdin/stdout — no ports exposed.
ENTRYPOINT ["node", "dist/server.js"]
