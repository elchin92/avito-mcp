# Подключение AI-клиента

[README](../README.ru.md) · [English](clients.md)

Выберите клиент, скопируйте его пример и замените три заглушки своими ключами локально. Все примеры используют Node.js 22.12+, `avito-mcp@2` и режим `AVITO_MCP_MODE=read_only`. Они подключаются к **вашему рабочему аккаунту Avito**. Чтобы сначала попробовать вымышленные данные, выполните в терминале `npx -y avito-mcp@2 --demo`.

| Клиент                                                | Пример                                                         | Формат настройки              |
| ----------------------------------------------------- | -------------------------------------------------------------- | ----------------------------- |
| [Claude Desktop](#claude-desktop)                     | [claude-desktop.json](../examples/clients/claude-desktop.json) | JSON с `mcpServers`           |
| [Cursor](#cursor)                                     | [cursor.json](../examples/clients/cursor.json)                 | JSON с `mcpServers`           |
| [VS Code](#vs-code)                                   | [vscode.json](../examples/clients/vscode.json)                 | JSON с `servers`              |
| [Zed](#zed)                                           | [zed.json](../examples/clients/zed.json)                       | JSON с `context_servers`      |
| [Codex / ChatGPT desktop](#codex-and-chatgpt-desktop) | [codex.toml](../examples/clients/codex.toml)                   | TOML или настройки приложения |
| [ChatGPT web](#chatgpt-web)                           | Удалённая интеграция                                           | Плагин облачного сервиса      |

Добавьте запись `avito` к существующей конфигурации, сохранив остальные серверы. Значения для `YOUR_CLIENT_ID`, `YOUR_CLIENT_SECRET` и `YOUR_PROFILE_ID` возьмите из API-аккаунта Avito. Заполненный файл содержит секреты: храните его в личной конфигурации или используйте защищённый ввод клиента; не добавляйте ключи в Git. `avito-mcp@2` получает обновления в пределах основной версии 2. Если обновлениями управляете вы, укажите точную опубликованную версию.

Форматы сверены с указанными первоисточниками в сентябре 2026 года. Это справочник настроек, а не подтверждение проверки каждой версии клиента на реальном Avito.

## Claude Desktop

Откройте **Settings → Developer → Edit Config** и добавьте [claude-desktop.json](../examples/clients/claude-desktop.json). Стандартные пути: macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows — `%APPDATA%\Claude\claude_desktop_config.json`. Полностью закройте и заново откройте приложение. На другой платформе используйте путь, который показывает приложение. [Официальная инструкция](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## Cursor

Добавьте [cursor.json](../examples/clients/cursor.json) в личный `~/.cursor/mcp.json`, затем перезапустите сервер в Cursor. Проектный файл — `.cursor/mcp.json`; заполненные секреты в нём не коммитьте. [Документация Cursor](https://cursor.com/docs/mcp).

## VS Code

Используйте [vscode.json](../examples/clients/vscode.json): верхний ключ здесь **`servers`**. Команда **MCP: Open User Configuration** открывает личную конфигурацию; для проекта используется `.vscode/mcp.json`. Запустите сервер из редактора конфигурации. В общих проектах замените секреты на защищённые input-переменные VS Code. [Документация VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## Zed

Добавьте [zed.json](../examples/clients/zed.json) в настройки, открываемые командой **zed: open settings file**. Верхний ключ — **`context_servers`**, `command` — строка, а `args` и `env` находятся рядом. Альтернатива: **Settings → AI → MCP Servers → Add Server → Add Local Server**. [Документация Zed](https://zed.dev/docs/ai/mcp).

<a id="codex-and-chatgpt-desktop"></a>

## Codex и ChatGPT desktop

Добавьте [codex.toml](../examples/clients/codex.toml) в `~/.codex/config.toml`. Codex CLI, расширение IDE и ChatGPT desktop используют общие настройки MCP на одном Codex-хосте. Пример даёт 60 секунд на первоначальную загрузку npm. После правок перезапустите сервер.

В **ChatGPT desktop** откройте **Settings → MCP servers → Add server → STDIO**, укажите команду `npx`, аргументы `-y` и `avito-mcp@2`, а также четыре переменные окружения из примера. Сохраните и нажмите **Restart**. Команда `/mcp` показывает подключения.

В **Codex CLI** команда `codex mcp list` перечисляет серверы. Для HTTP-развёртывания добавьте его URL `/mcp` и выполните `codex mcp login avito`. В этом варианте доступы Avito хранятся на сервере. [Официальная документация OpenAI](https://learn.chatgpt.com/docs/extend/mcp).

<a id="chatgpt-web"></a>

## ChatGPT web

В облачном ChatGPT Work удалённые MCP-инструменты предоставляются установленными плагинами. Веб-версия не читает ваш локальный TOML и не запускает `npx` на ноутбуке. Этот репозиторий поставляет сервер; интеграцию плагина и доступное защищённое развёртывание нужно настроить отдельно. Доступность может ограничиваться администратором рабочего пространства. [Официальное описание](https://learn.chatgpt.com/docs/extend/mcp).

Для локальной работы начните с desktop-конфигурации выше. Для своей интеграции прочитайте [настройку HTTP](operations.ru.md#удалённый-mcp-по-http-oauth-21).

## Профили под задачу

[analytics](../examples/profiles/analytics.env.json), [messenger](../examples/profiles/messenger.env.json) и [seller](../examples/profiles/seller.env.json) — **наборы переменных окружения**, а не полные конфиги и не автоматически загружаемые пресеты. Перенесите записи в `env` своего сервера; в TOML — в `[mcp_servers.avito.env]`. Сохраните три доступа Avito, замените старые значения настройками выбранного профиля и перезапустите сервер.

| Профиль   | Инструменты                                           | Какие изменения доступны                      |
| --------- | ----------------------------------------------------- | --------------------------------------------- |
| analytics | Аккаунт, объявления, активность и расходы             | Никакие                                       |
| messenger | Чаты, история, контекст объявления и текстовые ответы | Отправка текста через подтверждение           |
| seller    | Объявления, цены и остатки                            | Изменение цены и остатков через подтверждение |

В messenger нет отметки «прочитано», загрузки картинок и смены подписок. В seller нет переписки и платного продвижения. Оба профиля с изменениями используют подтверждение `all_destructive`. AI-клиент способен сам вызвать инструмент подтверждения: если каждое изменение должен одобрять человек, настройте [отдельное подтверждение](safety.md).

Каждый профиль задаёт `AVITO_MCP_ALLOW_TOOLS` — список разрешённых инструментов. Новые инструменты в него автоматически не попадают. Список запрещённых инструментов и настройки явного включения продолжают действовать. Проверьте итог через `meta_capabilities` и список инструментов клиента.

## Проверка подключения

В стандартном read-only примере или профиле analytics спросите: «Через Avito покажи мой баланс и первую страницу активных объявлений. Ничего не меняй». Ожидаемые инструменты — `user_get_user_balance` и `items_get_items_info`. Пустой список допустим, если объявлений нет.

Статус connected подтверждает связь по MCP. Успешное чтение дополнительно проверяет авторизацию и доступ к методу Avito. `meta_health` проверяет только локальный сервер.

Дальше попробуйте [утренний отчёт](workflows.ru.md#morning-report) или [разбор непрочитанных чатов](workflows.ru.md#unread-chat-triage). Если первый запрос не удался, откройте [диагностику](troubleshooting.ru.md).
