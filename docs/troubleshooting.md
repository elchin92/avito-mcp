# Troubleshooting

[Documentation](README.md) · [Русская версия](troubleshooting.ru.md) · [Client setup](clients.md)

Find the stage that failed: startup, an Avito read, a change, or HTTP authorization. The structured error's `type` and the server log are the most useful evidence. Remove credentials and customer data before sharing either.

## The server does not start

| Symptom                             | What to do                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server missing or `ENOENT`          | Run `node --version` and `npx --version` in a terminal. Node must be 22.12+. A desktop app can have a different PATH; use an absolute executable path if needed, then restart the client. |
| Config saves, but no server appears | Check the [client's format](clients.md): Claude/Cursor use `mcpServers`, VS Code uses `servers`, Zed uses `context_servers`, Codex uses TOML. Merge the entry into the correct file.      |
| First start times out               | Run `npx -y avito-mcp@2 --version` once to download the package. Increase the client's startup timeout if needed; the Codex example allows 60 seconds.                                    |
| Startup reports a config error      | Compare names and values with [`.env.example`](../.env.example). `Client_id`, `Client_secret`, and `Profile_id` are case-sensitive; the profile ID must be numeric.                       |

Run the isolated demo to check that the installed package starts:

```bash
npx -y avito-mcp@2 --demo
```

It uses fictional data and never contacts Avito. A successful demo does **not** validate your account credentials or access to Avito.

## Connected, but a read fails

| Symptom                     | What to do                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avito returns 401           | Verify that the client ID, secret and profile belong to the intended account. Use `meta_auth_status` with `probe: true` to test token refresh; it returns metadata, not the token.            |
| Avito returns 403           | The account may be authenticated but lack permission for that method. Check the endpoint's account requirements with [Avito API support](https://developers.avito.ru/).                       |
| A tool is missing           | Check `AVITO_MCP_MODE`, allowlist and denylist, then restart. `meta_capabilities` reports the effective configuration. Token-returning tools and local image upload require separate opt-ins. |
| Avito returns 429           | Check `retryAfter` and `meta_get_rate_limits`; wait and reduce concurrency.                                                                                                                   |
| The list or report is empty | Check the account, filters, dates and pagination. `items_get_items_info` does not return employees' listings; consult its description before treating an empty list as an error.              |

A connected status checks MCP. A successful Avito read also checks authentication and permission for that endpoint. `meta_health` and `avito-mcp --health` describe local server health; neither proves Avito is reachable.

## A change is waiting or its result is unclear

| Response                      | Meaning and next step                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dryRun: true` preview        | No business request was sent and no pending action was created. After approval, submit a separate call with `dryRun: false`.                                                 |
| `requires_confirmation: true` | The action has not executed. Review it, then use `meta_confirm_action` under your approval policy, or `meta_cancel_action` to decline it.                                    |
| `OUTCOME_UNKNOWN`             | The mutation was dispatched, but its response was lost. It may have succeeded. Check the real order, message or listing before another attempt.                              |
| `IDEMPOTENCY_HELD`            | The key is held because an earlier result is uncertain. Reconcile that operation before releasing the key. A new key can duplicate the original operation.                   |
| `TIMEOUT` or `NETWORK_ERROR`  | Read the full error and its `retryable` field. For a failed change, establish whether it reached Avito before retrying; the error alone does not prove that nothing changed. |

Follow [recovery after a lost response](safety.md#lost-responses-after-a-mutation-v21) and [the held-key procedure](safety.md#lifting-a-held-idempotency-key). Keep the same idempotency key for the same intended operation; do not change keys to bypass uncertainty.

## Remote HTTP authorization fails

Use the deployment's HTTPS `/mcp` URL. Check `AVITO_MCP_HTTP_PUBLIC_URL`, the proxy's preserved `Host`, and the [OAuth configuration](operations.md#remote-mcp-over-http-oauth-21). Changing the public issuer URL requires client registration again. On the running deployment, `/readyz` reports readiness and `/healthz` identifies the process.

ChatGPT web does not load a local Codex TOML file or start a local `npx` process. Follow the [web integration instructions](clients.md#chatgpt-web).

## Send a useful bug report

Use the [bug report template](https://github.com/elchin92/avito-mcp/issues/new?template=bug_report.md) and include:

- Installed server version, AI client and version, operating system, and Node version.
- Transport, `AVITO_MCP_PROTOCOL_ERA`, and selected profile or allowlist.
- Exact tool name, arguments with private values replaced, expected result, and structured error.
- Minimal reproduction steps, including whether a mutation might already have executed.

`npm view avito-mcp version` shows the latest published version, which can differ from the version your client runs. The connected server's `meta_health` output identifies its version.

Claude Desktop logs are under `~/Library/Logs/Claude/` on macOS or `%APPDATA%\Claude\logs` on Windows; this server's log is `mcp-server-avito.log`. Other clients provide an MCP output or log view. See the [official local-server diagnostics](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

Do not attach filled `.env` files, access tokens, real buyer messages, account identifiers or private conversation exports. Report vulnerabilities through the [private security channel](../SECURITY.md#how-to-report). Conduct reports use the channel in the [Code of Conduct](../CODE_OF_CONDUCT.md#enforcement).
