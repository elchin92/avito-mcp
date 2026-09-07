# Connect your AI client

[README](../README.md) · [Русская версия](clients.ru.md)

Choose your client, copy its example, and replace the three credential placeholders locally. All examples use Node.js 22.12+, `avito-mcp@2`, and `AVITO_MCP_MODE=read_only`. They connect to **your real Avito account**; they do not use demo data. To try fictional data first, run `npx -y avito-mcp@2 --demo` in a terminal.

| Client                                                | Example                                                        | Config format            |
| ----------------------------------------------------- | -------------------------------------------------------------- | ------------------------ |
| [Claude Desktop](#claude-desktop)                     | [claude-desktop.json](../examples/clients/claude-desktop.json) | `mcpServers` JSON        |
| [Cursor](#cursor)                                     | [cursor.json](../examples/clients/cursor.json)                 | `mcpServers` JSON        |
| [VS Code](#vs-code)                                   | [vscode.json](../examples/clients/vscode.json)                 | `servers` JSON           |
| [Zed](#zed)                                           | [zed.json](../examples/clients/zed.json)                       | `context_servers` JSON   |
| [Codex / ChatGPT desktop](#codex-and-chatgpt-desktop) | [codex.toml](../examples/clients/codex.toml)                   | TOML or desktop settings |
| [ChatGPT web](#chatgpt-web)                           | Remote integration                                             | Hosted plugin            |

Merge the `avito` entry into your existing configuration, preserving other servers. `YOUR_CLIENT_ID`, `YOUR_CLIENT_SECRET`, and `YOUR_PROFILE_ID` come from your Avito API account. Filled configurations contain credentials: use a personal config or your client's secret inputs, and keep them out of Git. `avito-mcp@2` receives updates within major version 2; use an exact published version when you control updates yourself.

The formats below were checked against linked primary documentation in September 2026. This is a configuration reference, not a live compatibility certification for every client version.

## Claude Desktop

Open **Settings → Developer → Edit Config** and merge [claude-desktop.json](../examples/clients/claude-desktop.json). Standard config locations are `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Fully quit and reopen the app after saving. On another platform, use the config path shown by the application. [Official local-server guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## Cursor

Merge [cursor.json](../examples/clients/cursor.json) into personal `~/.cursor/mcp.json`, then restart the server from Cursor. Project configurations live at `.cursor/mcp.json`; do not commit filled credential placeholders. [Cursor MCP configuration](https://cursor.com/docs/mcp).

## VS Code

Use [vscode.json](../examples/clients/vscode.json). Its top-level key is **`servers`**. Run **MCP: Open User Configuration** to configure your personal profile, or create `.vscode/mcp.json` for a workspace. Start the server from the configuration editor. For a shared workspace, replace credential literals with VS Code secret input variables. [VS Code configuration guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## Zed

Merge [zed.json](../examples/clients/zed.json) into Zed's settings file, opened with **zed: open settings file**. Its top-level key is **`context_servers`**; `command` is a string, with `args` and `env` alongside it. You can also use **Settings → AI → MCP Servers → Add Server → Add Local Server**. [Zed MCP guide](https://zed.dev/docs/ai/mcp).

<a id="codex-and-chatgpt-desktop"></a>

## Codex and ChatGPT desktop

Merge [codex.toml](../examples/clients/codex.toml) into `~/.codex/config.toml`. Codex CLI, the IDE extension and ChatGPT desktop share MCP configuration on the same Codex host. The example allows 60 seconds for the first npm download. Restart the server after changing it.

In **ChatGPT desktop**, use **Settings → MCP servers → Add server → STDIO**, with command `npx`, arguments `-y` and `avito-mcp@2`, and the four environment variables from the example. Save and select **Restart**. `/mcp` shows connections.

In **Codex CLI**, `codex mcp list` lists configured servers. For an HTTP deployment, add its `/mcp` URL and run `codex mcp login avito` to authorize. The Avito credentials stay on the server in that setup. [Official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

## ChatGPT web

Hosted ChatGPT Work uses remote MCP tools supplied by installed plugins. It does not read your local Codex TOML or start `npx` on your laptop. This repository ships a server, not an installed ChatGPT plugin: a plugin integration and reachable authenticated deployment are separate setup steps. Workspace administrators may control availability. [Official web MCP guidance](https://learn.chatgpt.com/docs/extend/mcp).

For local use, start with the desktop configuration above. For an integration you operate, read [HTTP deployment](operations.md#remote-mcp-over-http-oauth-21).

## Choose a smaller tool set

The [analytics](../examples/profiles/analytics.env.json), [messenger](../examples/profiles/messenger.env.json), and [seller](../examples/profiles/seller.env.json) files are **environment-variable maps**, not complete client configs and not automatically loaded presets. Copy the entries into the server's `env` object; for TOML add them to `[mcp_servers.avito.env]`. Preserve your three credentials. Replace existing values with those from the selected profile and restart the server.

| Profile   | Tools                                                | Changes allowed                                        |
| --------- | ---------------------------------------------------- | ------------------------------------------------------ |
| analytics | Account, listings, activity and spending reports     | None                                                   |
| messenger | Chat lists/history, listing context and text replies | Text replies, through the confirmation flow            |
| seller    | Listing details, prices and stock                    | Price and stock changes, through the confirmation flow |

`messenger` excludes marking chats read, image uploads and subscription changes. `seller` excludes messaging and paid promotion. Both profiles that allow changes use `all_destructive` confirmation. The AI client can call the confirmation tool itself; configure [separate approval controls](safety.md) if a person must approve each change.

Each profile uses `AVITO_MCP_ALLOW_TOOLS`: only the named tools are exposed, so newly added tools do not appear automatically. Existing denylist or opt-in settings still apply. Check the effective configuration with `meta_capabilities` and your client's tool list.

## Verify the first connection

Ask: “Use Avito to show my account balance and the first page of active listings. Do not change anything.” Start with the default read-only client example or the analytics profile. Expect calls to `user_get_user_balance` and `items_get_items_info`. If your account has no listings, an empty list is a valid response.

A connected status confirms the MCP connection. A successful read also checks Avito authentication and permission for that endpoint. `meta_health` checks only the local server.

Next, try a [morning report](workflows.md#morning-report) or [unread-chat review](workflows.md#unread-chat-triage). If the first call fails, use the [troubleshooting guide](troubleshooting.md).
