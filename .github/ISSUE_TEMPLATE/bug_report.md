---
name: Bug report
about: Something does not work as expected
title: '[bug] '
labels: bug
---

<!-- Before submitting, check existing issues and docs/troubleshooting.md. Перед отправкой проверьте существующие issues и docs/troubleshooting.md. Never include secrets or customer data. -->

**MCP client + version / MCP-клиент и его версия**
e.g. Claude Desktop 0.9.2 on macOS 14, Cursor 0.46, Claude Code 1.x

**Node version**
Output of `node --version`

**avito-mcp version**
The version actually run by your MCP client. `npm view avito-mcp version` shows the latest published version and may differ.

**Connection / Подключение**

- Transport = (stdio | http | both)
- AVITO_MCP_PROTOCOL_ERA = (legacy | dual | modern)
- Operating system / ОС =

**Active env safety / Активная safety-конфигурация**

- AVITO_MCP_MODE = (read_only | guarded | full_access)
- AVITO_MCP_CONFIRMATION_MODE = (off | money_public | all_destructive)
- AVITO_MCP_EXPOSE_AUTH_TOOLS = (0 | 1)
- AVITO_MCP_ALLOW_TOOLS / AVITO_MCP_DENY_TOOLS = (tool names or empty)
- AVITO_MCP_ALLOWED_UPLOAD_DIRS = (enabled / disabled; redact private paths)

**Tool name + arguments / Имя tool и аргументы**
The exact tool you called and the arguments you passed. **Redact** real IDs, prices, message texts, customer names.

**What happened / Что произошло**
Error message, stack trace, or unexpected output. The server logs to stderr; in Claude Desktop on macOS that's at `~/Library/Logs/Claude/mcp-server-avito.log`.

**Expected / Ожидаемое поведение**
What you thought would happen.

**Reproduction / Воспроизведение**
Steps or a minimal MCP-client prompt that triggers the bug. If the bug is in confirmation flow or upload guard, include relevant non-secret env settings; never include Client_secret, tokens, confirmation secrets or webhook URLs containing secrets.

**Additional context / Дополнительный контекст**
Anything else: was it a fresh `npx -y avito-mcp` run, did this work in a previous version, did Avito rate-limit kick in (`meta_get_rate_limits`), etc.
