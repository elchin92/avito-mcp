---
name: Bug report
about: Something does not work as expected
title: '[bug] '
labels: bug
---

<!-- Перед отправкой проверьте существующие issues + раздел Troubleshooting в README.ru.md / Before submitting, check existing issues + the Troubleshooting section in README.md / README.ru.md -->

**MCP client + version / MCP-клиент и его версия**
e.g. Claude Desktop 0.9.2 on macOS 14, Cursor 0.46, Claude Code 1.x

**Node version**
Output of `node --version`

**avito-mcp version**
Output of `npx avito-mcp --version` (or `npm view avito-mcp version` for latest).

**Active env safety / Активная safety-конфигурация**
- AVITO_MCP_MODE = (read_only | guarded | full_access)
- AVITO_MCP_CONFIRMATION_MODE = (off | money_public | all_destructive)
- AVITO_MCP_EXPOSE_AUTH_TOOLS = (0 | 1)
- AVITO_MCP_ALLOWED_UPLOAD_DIRS = (paths or empty)

**Tool name + arguments / Имя tool и аргументы**
The exact tool you called and the arguments you passed. **Redact** real IDs, prices, message texts, customer names.

**What happened / Что произошло**
Error message, stack trace, or unexpected output. The server logs to stderr; in Claude Desktop on macOS that's at `~/Library/Logs/Claude/mcp-server-avito.log`.

**Expected / Ожидаемое поведение**
What you thought would happen.

**Reproduction / Воспроизведение**
Steps or a minimal MCP-client prompt that triggers the bug. If the bug is in confirmation flow or upload guard, please include the relevant env vars exactly.

**Additional context / Дополнительный контекст**
Anything else: was it a fresh `npx -y avito-mcp` run, did this work in a previous version, did Avito rate-limit kick in (`meta_get_rate_limits`), etc.
