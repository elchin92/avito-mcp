---
name: Bug report / Ошибка
about: Report a reproducible server or tool error / Ошибка сервера или инструмента
labels: bug
---

<!-- Check existing issues and docs/troubleshooting.md first. English or Russian is welcome. -->
<!-- Сначала проверьте существующие issues и docs/troubleshooting.ru.md. Можно писать по-русски. -->
<!-- This issue is public. Remove secrets, account IDs, buyer messages and private conversation exports. -->
<!-- Это публичный issue. Удалите ключи, ID аккаунтов, сообщения покупателей и экспорты личных разговоров. -->

## What happened / Что произошло

Describe the error and what you expected instead.
Опишите ошибку и ожидаемый результат.

## Reproduce / Как воспроизвести

1. Client prompt or exact tool name / Запрос клиенту или точное имя инструмента:
2. Arguments with private values replaced / Аргументы с заменой частных значений:
3. Result or structured error / Результат или структурированная ошибка:

If this involved a change, did it reach Avito? Include a redacted confirmation or idempotency status if known.
Если запрос менял данные, выполнилось ли действие в Avito? Если известно, приложите статус подтверждения или идемпотентности без частных данных.

## Environment / Окружение

- Installed `avito-mcp` version / Установленная версия:
- MCP client and version / Клиент и версия:
- OS / ОС:
- Node version (`node --version`):
- Transport: `stdio` / `http` / `both`
- `AVITO_MCP_PROTOCOL_ERA`: `legacy` / `dual` / `modern`
- Profile or `AVITO_MCP_MODE` / Профиль или режим:

Use the running server's `meta_health` result for its version. `npm view avito-mcp version` shows the latest published release and may differ.
Версию работающего сервера смотрите в `meta_health`. `npm view avito-mcp version` показывает последний опубликованный релиз и может отличаться.

## Relevant configuration and logs / Настройки и журнал

Include only settings that affect the issue: tool allowlist/denylist, confirmation mode, upload enabled/disabled, or HTTP auth mode. Paste the relevant error with secrets removed. Do not attach a filled `.env`, access tokens, confirmation secrets or secret-bearing webhook URLs.
Приложите только настройки, связанные с ошибкой: списки инструментов, режим подтверждений, включена ли загрузка, режим HTTP-авторизации. Приведите нужный фрагмент ошибки без секретов. Не прикладывайте заполненный `.env`, токены, секрет подтверждения или webhook-URL с секретом.
