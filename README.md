# avito-mcp

[![npm](https://img.shields.io/npm/v/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![downloads](https://img.shields.io/npm/dm/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![tests](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/avito-mcp.svg)](package.json)
[![Glama](https://glama.ai/mcp/servers/elchin92/avito-mcp/badges/score.svg)](https://glama.ai/mcp/servers/elchin92/avito-mcp)
[![MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Connect your AI client to your Avito account: read chats and statistics, prepare replies, and manage listings and orders.**

An open-source MCP server with **148 tools across 18 official Avito APIs**. Runs locally with Node.js or on your own server over authenticated HTTP. Your chosen AI client supplies the model and decides which tools to call. Scheduled jobs and automatic replies require a separately configured agent or scheduler.

**[Русская версия →](README.ru.md)** · [Client setup](docs/clients.md) · [Workflows](docs/workflows.md) · [Troubleshooting](docs/troubleshooting.md)

> **New in v2.1.0:** a credential-free local demo, focused setup profiles, and clearer recovery when an upstream result is unknown.

## Try without Avito credentials

```bash
npx -y avito-mcp@2 --demo
```

The demo runs real MCP calls against fictional Avito data on loopback: report, unread chats, price preview, confirmation and an idempotent retry. It uses no Avito credentials and sends no requests to Avito. The first `npx` run downloads the npm package. From source, use `npm run demo`.

![Local demo output: 53 fictional listings, 2 unread chats, and one confirmed price change despite a retry](docs/assets/demo.svg)

## What you can do

| Task                              | Start here                                                                                                                       | Result                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Check how your listings are doing | [Morning report](docs/workflows.md#morning-report), [analytics profile](examples/profiles/analytics.env.json)                    | Balance, listing activity and spending, with dates and source IDs           |
| Work through buyer messages       | [Unread-chat triage](docs/workflows.md#unread-chat-triage), [messenger profile](examples/profiles/messenger.env.json)            | Prioritised chats and draft replies; sending is a separate confirmed action |
| Change a listing price            | [Preview and confirm](docs/workflows.md#preview-and-confirm-a-price-change), [seller profile](examples/profiles/seller.env.json) | Exact request preview, pending action, then a verified result               |

Profiles use existing environment variables to expose a focused tool set. The recipes explain what to ask, which tools are involved, and how to check the result.

## Quick start

You need **Node.js 22.12+**, an MCP-capable AI client, and Avito API credentials for your account. Obtain `Client_id`, `Client_secret`, and numeric `Profile_id` through [Avito's API account page](https://www.avito.ru/professionals/api). Available methods depend on your account's API access; installing this server does not grant additional Avito permissions.

For **Claude Desktop**, merge this into its MCP config using Settings → Developer → Edit Config. For **Cursor**, use your personal `~/.cursor/mcp.json`. Replace the three placeholders locally and keep the filled config out of Git.

```json
{
  "mcpServers": {
    "avito": {
      "command": "npx",
      "args": ["-y", "avito-mcp@2"],
      "env": {
        "Client_id": "YOUR_CLIENT_ID",
        "Client_secret": "YOUR_CLIENT_SECRET",
        "Profile_id": "YOUR_PROFILE_ID",
        "AVITO_MCP_MODE": "read_only"
      }
    }
  }
}
```

Restart the client and ask: **“Use Avito to show my account balance and the first page of active listings. Do not change anything.”** The example starts in `read_only`; without this setting the server's default remains `full_access`.

**VS Code, Zed, Codex and ChatGPT use their own setup formats.** Copy the [client-specific config](docs/clients.md), then try a [workflow](docs/workflows.md). The examples pin major version 2; pin an exact published version for controlled deployments.

## Connect your AI client

| Client                    | Ready-to-copy config                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Claude Desktop            | [JSON + setup](docs/clients.md#claude-desktop)                                     |
| Cursor                    | [JSON + setup](docs/clients.md#cursor)                                             |
| VS Code / Copilot         | [`servers` JSON](docs/clients.md#vs-code)                                          |
| Zed                       | [`context_servers` JSON](docs/clients.md#zed)                                      |
| Codex CLI / IDE extension | [TOML](docs/clients.md#codex-and-chatgpt-desktop)                                  |
| ChatGPT desktop           | [Settings → MCP servers or shared TOML](docs/clients.md#codex-and-chatgpt-desktop) |
| ChatGPT web               | [Remote plugin setup and limits](docs/clients.md#chatgpt-web)                      |

These are documented configurations, not a claim that every client/version has been tested against a live Avito account. Report compatibility results with the client version and operating system.

## API coverage

| Domain                  | Examples                                                     |
| ----------------------- | ------------------------------------------------------------ |
| Messenger               | Chats, messages, images, subscriptions and webhook events    |
| Listings and statistics | Listing details, prices, views, contacts and spending        |
| Orders and stock        | Delivery statuses, tracking, labels, marking codes and stock |
| Promotion               | VAS, CPA bids, forecasts and promotion orders                |
| Autoload                | Feed uploads, reports and ID mapping                         |
| Account and other APIs  | Balance, reviews, staff, tariffs and calls                   |
| Logistics partners      | 3PL delivery endpoints; most sellers do not need these       |

The bundled API snapshot covers 138 Swagger operations plus local and meta tools. The full manifest has 148 tools; default registration exposes 144, because token-returning tools and local image uploads require separate opt-ins. `read_only` exposes 80 before allowlist filtering. Inspect `avito://manifest` or build `dist/manifest.json` for exact names, schemas and risks.

Resources include the tool manifest, active configuration, rate limits, pending confirmations and webhook events. Five built-in prompts cover a daily overview, unread chats, promotion preparation, tool explanations and a safety report. [Resource and prompt reference](docs/operations.md#resources-and-prompts).

## Safety and retries

- `read_only`, `guarded`, and `full_access`, plus `AVITO_MCP_ALLOW_TOOLS` / `AVITO_MCP_DENY_TOOLS`, control which tools are available.
- `dryRun: true` previews a destructive request without sending it. It does not reserve an action or validate the live account's permission to execute it.
- Money and customer-visible actions use a two-call confirmation flow by default. The agent can make both calls: this is **not proof of human approval**. Use client-side approvals or the separate approval controls described in [safety configuration](docs/safety.md).
- An `idempotencyKey` deduplicates the same tool and arguments within the configured retention period. Reuse the same key for the same intended operation. If the outcome is uncertain, reconcile with Avito before retrying or choosing a new key.
- Credentials go directly to Avito; there is no project-operated proxy or telemetry. Tool results are visible to your AI client and may be sent to its model provider under that client's settings.

Business calls use the real Avito account. Start with reads and previews. [Ready-to-use safety configurations](docs/safety.md) describe stronger approval controls, upload boundaries and recovery.

## Remote MCP over HTTP (OAuth 2.1)

For a hosted agent or several clients, use Streamable HTTP on your own HTTPS domain. Set `AVITO_MCP_TRANSPORT=http`, `AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com`, and a strong `AVITO_MCP_OAUTH_OWNER_PASSWORD`, together with the Avito credentials.

[Deployment, OAuth, Caddy and nginx configuration](docs/operations.md#remote-mcp-over-http-oauth-21). `bearer` and `none` modes do not claim conformance with the MCP authorization specification; use OAuth for clients that discover authorization automatically.

## Avito webhook receiver

The optional receiver buffers incoming Avito events and exposes them through a tool and a subscribable resource. An external agent must consume those events and decide whether to respond. [Receiver setup](docs/operations.md#avito-webhook-receiver).

## Protocol and compatibility

### Protocol revisions

`AVITO_MCP_PROTOCOL_ERA` selects `legacy` (default, MCP 2025-11-25), `dual` (both revisions), or `modern` (MCP 2026-07-28). A default stdio installation keeps serving the legacy revision; enabling the newer revision is explicit.

`AVITO_MCP_HTTP_MAX_SESSIONS` and `AVITO_MCP_HTTP_SESSION_IDLE_SEC` apply to legacy 2025-11-25 only. Modern HTTP uses `AVITO_MCP_HTTP_MAX_INFLIGHT` and `AVITO_MCP_HTTP_MAX_STREAMS` instead. [Protocol details and limits](docs/operations.md#protocol-and-compatibility).

Public tool names, documented valid arguments, environment variables, resource URIs and prompt names follow SemVer. See [versioning details](docs/operations.md#versioning), [migration from 1.3.x](MIGRATION.md), and [CHANGELOG](CHANGELOG.md).

## Security

Token-returning tools and image uploads stay hidden until explicitly enabled. Tokens and runtime state are stored locally with restricted file permissions. [Safety configuration](docs/safety.md), [security policy and private reporting](SECURITY.md), and [operational diagnostics](docs/troubleshooting.md) describe the boundaries.

## Install from source

```bash
git clone https://github.com/elchin92/avito-mcp.git
cd avito-mcp
npm ci
cp .env.example .env
# Fill in your credentials locally.
npm run build:release
```

Configure your client to run `node /absolute/path/to/dist/server.js`. Pass credentials through its `env`, or set `AVITO_ENV_FILE` to the absolute path of your filled `.env` file. [Dockerfile](Dockerfile) and [systemd installer](deploy/install-services.sh) are included; read [operations](docs/operations.md) and `.env.example` before deploying.

Contributors: [CONTRIBUTING](CONTRIBUTING.md) explains the shared tool factory and validation. Run `npm run verify:release` before a code PR. CI checks types, tests, coverage, package installation and deployment behavior; live Avito smoke tests are a separate, explicit check.

## Not covered here

The Auction, Autostrategy, Autoteka, Jobs, Realty reports and Short-term rent API specifications are not bundled. This project also does not provide a model, a hosted agent service, or a scheduler. See the [roadmap](ROADMAP.md) for concrete contribution opportunities.

Questions and bug reports: [GitHub Issues](https://github.com/elchin92/avito-mcp/issues/new/choose) · [Support](SUPPORT.md). Share a reproducible use case or improve a recipe through a pull request.

[MIT](LICENSE). Independent project; not affiliated with Avito. See [NOTICE](NOTICE) for the trademark and API-terms notice.
