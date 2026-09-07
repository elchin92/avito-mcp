# Troubleshooting / Решение проблем

[README](../README.md) · [README на русском](../README.ru.md) · [Client configurations](clients.md)

Start with the server log and the structured error's `type`. Remove secrets and customer data before sharing a log.

| Symptom / Симптом                                           | Check / Что проверить                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server missing or `ENOENT`                                  | Run `node --version` and `npx --version` in a terminal. Node must be 22.12+. GUI apps may have a different PATH: set an absolute executable path if necessary. Restart the client.                                                            |
| JSON accepted but no server appears                         | Check the [client-specific format](clients.md): Claude/Cursor use `mcpServers`, VS Code uses `servers`, Zed uses `context_servers`, Codex uses TOML. Merge the entry into the correct file.                                                   |
| First start times out                                       | npm may need to download the package. Run `npx -y avito-mcp@2 --version` once; increase the client's startup timeout if needed. The Codex example uses 60 seconds.                                                                            |
| Startup config error                                        | Check environment-variable names and values against [`.env.example`](../.env.example). `Client_id`, `Client_secret`, and `Profile_id` are case-sensitive; profile ID must be numeric.                                                         |
| Connected, but Avito returns 401                            | Verify the credentials belong together and to the intended account. Call `meta_auth_status` with `probe: true` to check token refresh; it returns metadata, not the token.                                                                    |
| Avito returns 403                                           | Authentication may have succeeded while this endpoint is unavailable to the account. Check that method's Avito permissions with [Avito API support](https://developers.avito.ru/). Installing more tools does not grant access.               |
| A tool is absent                                            | Check `AVITO_MCP_MODE`, allowlist and denylist, then restart. `meta_capabilities` shows effective settings. Auth-token tools and local image upload have separate opt-ins.                                                                    |
| `requires_confirmation: true`                               | The action has not executed. Review the pending action; call `meta_confirm_action` only under the configured approval policy, or `meta_cancel_action` to decline.                                                                             |
| Preview does not change anything                            | `dryRun: true` only shows the request. An authorized action needs a separate call with `dryRun: false`, then confirmation when required.                                                                                                      |
| Avito returns 429                                           | Inspect `retryAfter` and `meta_get_rate_limits`; wait and reduce concurrency. Repeated manual retries increase pressure.                                                                                                                      |
| TIMEOUT, NETWORK_ERROR or `IDEMPOTENCY_HELD` after a change | The upstream result may be unknown. Check the actual order, message or listing in Avito before another attempt. Do not switch idempotency keys to work around uncertainty. See [recovery guidance](safety.md#lifting-a-held-idempotency-key). |
| Empty list or report                                        | Check filters, date range, account and pagination. An empty page is not a server crash. Listing lists do not include employees' listings; consult the tool description.                                                                       |
| HTTP authorization fails                                    | Use the deployment's HTTPS `/mcp` URL. Check public URL, preserved proxy Host, and the [OAuth setup](operations.md#remote-mcp-over-http-oauth-21). Changing the public issuer URL requires client registration again.                         |
| ChatGPT web ignores local TOML                              | Local host config applies to desktop/CLI/IDE. Hosted web tools use plugin integrations; see [client setup](clients.md#chatgpt-web).                                                                                                           |

## Collect a useful report

Include the installed server version, client/version, OS, Node version, transport, `AVITO_MCP_PROTOCOL_ERA`, profile or allowlist, exact tool name, redacted arguments, expected result and structured error. `npm view avito-mcp version` shows the latest published version, not necessarily the version your client runs.

Claude Desktop logs are under `~/Library/Logs/Claude/` on macOS or `%APPDATA%\Claude\logs` on Windows; the Avito server log is `mcp-server-avito.log`. [Official log locations](https://modelcontextprotocol.io/docs/develop/connect-local-servers). In other clients use their MCP server output/log view.

`meta_health` and `avito-mcp --health` are local diagnostics; they do not prove that Avito is reachable. For a running HTTP deployment, `/readyz` reports readiness and `/healthz` identifies the process. [Operations reference](operations.md#operating-it).

**По-русски:** приложите версии сервера, клиента, ОС и Node, транспорт, ревизию протокола, выбранный профиль, имя инструмента и ошибку без секретов. После таймаута изменения сначала проверьте результат в Avito: сообщение об ошибке не доказывает, что действие не выполнилось.

[Open a bug report](https://github.com/elchin92/avito-mcp/issues/new?template=bug_report.md). For vulnerabilities or private conduct reports use the [private reporting channel](../SECURITY.md#how-to-report), not a public issue.
