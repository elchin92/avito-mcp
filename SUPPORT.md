# Support / Поддержка

## English

| You have… | Go here |
|---|---|
| A bug in `avito-mcp` (tool crashes, wrong response, etc.) | [Open an issue](https://github.com/elchin92/avito-mcp/issues/new/choose) |
| A question or idea ("how do I…?", "what about…?") | [GitHub Discussions](https://github.com/elchin92/avito-mcp/discussions) |
| A security vulnerability | See [SECURITY.md](SECURITY.md) — **do not** open a public issue |
| A problem with the Avito API itself (rate limits, missing endpoint, wrong response from `api.avito.ru`) | [Avito API support](https://developers.avito.ru/) — we can't fix Avito's side |
| A problem with your MCP client (Claude Desktop, Cursor, etc.) | Report it to that project — we don't maintain the clients |

**Before opening an issue:** check existing [issues](https://github.com/elchin92/avito-mcp/issues?q=is%3Aissue) and the [README](README.md) — most setup questions are answered in the [Connect your AI client](README.md#connect-your-ai-client) and [Security](README.md#security) sections.

**When you do open an issue, include:**
- MCP client + version (e.g. "Claude Desktop 0.9.2 on macOS 14")
- Node version (`node --version`)
- `avito-mcp` version (`npm view avito-mcp version` for latest, your installed one)
- Exact tool name + arguments you called
- Full error message from stderr (with secrets redacted)

## Русский

| У вас… | Куда |
|---|---|
| Баг в `avito-mcp` (tool падает, неверный ответ и т.п.) | [Открыть issue](https://github.com/elchin92/avito-mcp/issues/new/choose) |
| Вопрос или идея («как сделать…?», «а что если…?») | [GitHub Discussions](https://github.com/elchin92/avito-mcp/discussions) |
| Уязвимость в безопасности | Читайте [SECURITY.md](SECURITY.md) — **не открывайте** публичный issue |
| Проблема с самим Avito API (rate limits, недостающий метод, странный ответ `api.avito.ru`) | [Поддержка Avito API](https://developers.avito.ru/) — мы не правим сторону Avito |
| Проблема с вашим MCP-клиентом (Claude Desktop, Cursor и т.д.) | Пишите в тот проект — клиенты не наши |

**Перед открытием issue:** посмотрите [существующие issues](https://github.com/elchin92/avito-mcp/issues?q=is%3Aissue).

**В issue приложите:**
- Какой MCP-клиент и его версия (например, «Claude Desktop 0.9.2 на macOS 14»)
- Версия Node (`node --version`)
- Версия `avito-mcp` (ваша установленная)
- Точное имя tool'а и аргументы которые передали
- Полный текст ошибки из stderr (без секретов)
