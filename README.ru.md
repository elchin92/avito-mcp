# avito-mcp

[![npm version](https://img.shields.io/npm/v/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![npm downloads](https://img.shields.io/npm/dm/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/avito-mcp.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)

> **Дайте вашим AI-агентам руки и ноги в Avito.** Они ведут весь бизнес автономно — отвечают клиентам, управляют объявлениями, запускают продвижение, обрабатывают заказы, анализируют статистику. Без вашего участия. Полностью локально — stdio, ключи никогда не покидают вашу машину.

🇬🇧 **[English version →](./README.md)**

---

## Что это

Локальный **MCP-сервер** (Model Context Protocol) для [Avito API](https://www.avito.ru/professionals/api). Превращает 18 OpenAPI-спецификаций Avito в **139 инструментов** для AI-агентов. Работает с **Claude Desktop, Claude Code, Cursor, Cline, Continue, Windsurf, Zed** и любым MCP-совместимым клиентом.

Сценарий: вы продавец на Авито → подключили MCP к Claude/Cursor → попросили «ответь всем непрочитанным», «подними VIP объявление 12345», «покажи топ-10 объявлений по контактам за неделю» → агент сам выбирает нужные tools, делает запросы, возвращает результат.

## Что нужно

- **Node.js ≥ 20.10** ([скачать](https://nodejs.org/) — установится за минуту).
- **OAuth-доступы Avito API:** `Client_id`, `Client_secret`, `Profile_id`.

### Как получить credentials Avito

1. Зайдите в [личный кабинет API Авито](https://www.avito.ru/professionals/api).
2. Нажмите «Создать приложение» — придумайте название (любое).
3. Скопируйте **Client_id** и **Client_secret** — они появятся после создания.
4. **Profile_id** — ваш ID пользователя на Авито: откройте свой профиль на avito.ru, скопируйте число из URL вида `/user/<hash>/profile` (или зайдите в [настройки → API](https://www.avito.ru/profile/settings/api) — там тоже видно).

## Подключение к AI-клиентам

JSON-конфиг **одинаковый для всех клиентов** — отличается только путь к файлу. Замените `YOUR_CLIENT_ID`, `YOUR_CLIENT_SECRET`, `YOUR_PROFILE_ID` своими значениями.

<details>
<summary><b>Claude Desktop</b> (macOS / Windows / Linux)</summary>

**Путь к конфигу:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Если файла нет — создайте его. Если есть — добавьте секцию `avito` внутрь `mcpServers`.

```json
{
  "mcpServers": {
    "avito": {
      "command": "npx",
      "args": ["-y", "avito-mcp"],
      "env": {
        "Client_id": "YOUR_CLIENT_ID",
        "Client_secret": "YOUR_CLIENT_SECRET",
        "Profile_id": "YOUR_PROFILE_ID"
      }
    }
  }
}
```

После сохранения **полностью закройте и откройте Claude Desktop** (через системный трей — простой Cmd+W не перезапустит сервер). В новом чате появится «🔌 avito» внизу окна.

**Логи** (на случай ошибок): `~/Library/Logs/Claude/mcp-server-avito.log` на macOS.
</details>

<details>
<summary><b>Claude Code</b> (CLI)</summary>

**Способ 1 — через CLI** (рекомендуется):
```bash
claude mcp add avito npx -y avito-mcp \
  -e Client_id=YOUR_CLIENT_ID \
  -e Client_secret=YOUR_CLIENT_SECRET \
  -e Profile_id=YOUR_PROFILE_ID
```

**Способ 2 — вручную:** создайте `.mcp.json` в корне вашего проекта (или `~/.claude.json` для глобального):
```json
{
  "mcpServers": {
    "avito": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "avito-mcp"],
      "env": {
        "Client_id": "YOUR_CLIENT_ID",
        "Client_secret": "YOUR_CLIENT_SECRET",
        "Profile_id": "YOUR_PROFILE_ID"
      }
    }
  }
}
```

**Проверка:** `claude mcp list` — должен показать `avito: ... ✓ Connected`.
</details>

<details>
<summary><b>Cursor</b></summary>

**Путь:** `~/.cursor/mcp.json` (глобально) или `<project>/.cursor/mcp.json` (для проекта).

```json
{
  "mcpServers": {
    "avito": {
      "command": "npx",
      "args": ["-y", "avito-mcp"],
      "env": {
        "Client_id": "YOUR_CLIENT_ID",
        "Client_secret": "YOUR_CLIENT_SECRET",
        "Profile_id": "YOUR_PROFILE_ID"
      }
    }
  }
}
```

После сохранения: `Cmd/Ctrl + Shift + P` → "Reload Window". В правом сайдбаре Cursor появятся MCP-инструменты.
</details>

<details>
<summary><b>Windsurf</b> (Codeium)</summary>

**Путь:** `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "avito": {
      "command": "npx",
      "args": ["-y", "avito-mcp"],
      "env": {
        "Client_id": "YOUR_CLIENT_ID",
        "Client_secret": "YOUR_CLIENT_SECRET",
        "Profile_id": "YOUR_PROFILE_ID"
      }
    }
  }
}
```

Или через UI: Windsurf Settings → Cascade → MCP Servers → Add Server.
</details>

<details>
<summary><b>Cline</b> (расширение для VS Code)</summary>

В VS Code: иконка Cline в сайдбаре → значок шестерёнки (⚙️) → MCP Servers → Edit `cline_mcp_settings.json`.

**Путь к файлу:**
- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- Linux: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

Используйте тот же JSON-snippet. Cline подхватит изменения автоматически без перезагрузки VS Code.
</details>

<details>
<summary><b>Continue</b> (VS Code / JetBrains)</summary>

Откройте `~/.continue/config.json`, добавьте:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "avito-mcp"],
          "env": {
            "Client_id": "YOUR_CLIENT_ID",
            "Client_secret": "YOUR_CLIENT_SECRET",
            "Profile_id": "YOUR_PROFILE_ID"
          }
        }
      }
    ]
  }
}
```
</details>

<details>
<summary><b>Zed</b></summary>

`Cmd+,` (Settings) → найдите блок `context_servers`:

```json
{
  "context_servers": {
    "avito": {
      "command": {
        "path": "npx",
        "args": ["-y", "avito-mcp"],
        "env": {
          "Client_id": "YOUR_CLIENT_ID",
          "Client_secret": "YOUR_CLIENT_SECRET",
          "Profile_id": "YOUR_PROFILE_ID"
        }
      }
    }
  }
}
```
</details>

<details>
<summary><b>Любой другой stdio MCP-клиент</b></summary>

Универсальные параметры:
- `command`: `npx`
- `args`: `["-y", "avito-mcp"]`
- `env`: `{ "Client_id": "...", "Client_secret": "...", "Profile_id": "..." }`
- `transport`: `stdio`
</details>

## Примеры промптов

После подключения просто говорите агенту нормальным языком:

- *«Какой у меня баланс на Авито?»* → `user_get_user_balance`
- *«Покажи 5 последних чатов с непрочитанными сообщениями»* → `messenger_get_chats_v2`
- *«Сколько просмотров и контактов у объявления 1234567890 за последнюю неделю?»* → `items_post_item_stats_shallow`
- *«Покажи все мои активные объявления в категории Электроника»* → `items_get_items_info`
- *«Дай мне статистику расходов за месяц с разбивкой по дням»* → `items_post_account_spendings`
- *«Ответь на все непрочитанные с шаблоном "Здравствуйте, объявление актуально"»* → `messenger_get_messages_v3` + `messenger_post_send_message`
- *«Подними VIP объявление 1234567890»* → `items_put_item_vas` (⚠️ потратит деньги)

Агент сам выбирает нужный tool из 139 доступных, подставляет параметры, обрабатывает ответ. Profile_id подставляется автоматически из `.env` — не нужно его помнить.

## Что поддерживается (139 tools)

| Домен | Tools | Что можно делать |
|---|---|---|
| `items_*` | 11 | Чтение/изменение объявлений, цены, статистика, услуги VAS |
| `messenger_*` | 14 | Чаты, сообщения, отправка картинок, webhooks |
| `orders_*` | 12 | Заказы, переходы статусов, этикетки, возвраты |
| `autoload_*` | 17 | Автозагрузка через XML/YML, отчёты |
| `delivery_*` | 31 | Партнёрская доставка (B2B для СД) |
| `promotion_*` + `cpa_*` + `cpa_target_*` + `cpa_auction_*` | 25 | Продвижение, аукцион, BBIP, управление ставками |
| `user_*` / `stock_*` / `hierarchy_*` / `reviews_*` | 14 | Профиль, баланс, остатки, сотрудники, отзывы |
| `tariffs_*` / `trxpromo_*` / `calltracking_*` / `msg_discounts_*` | 12 | Тарифы, trx-промо, колл-трекинг, рассылки скидок |
| `auth_*` / `meta_*` | 4 | OAuth токены, наблюдаемость rate-limits |

## Что НЕ поддерживается

Для нишевых вертикалей Avito предоставляет **отдельные API** — их swagger-спецификации не входят в этот проект:

| Категория | Где искать |
|---|---|
| 🚗 **Авто** (легковые, грузовые, спецтехника) | [Avito Auto API](https://developers.avito.ru/api-catalog/auto/documentation) |
| 🏠 **Недвижимость** (квартиры, дома, коммерческая) | [Avito Real Estate API](https://developers.avito.ru/api-catalog/realty/documentation) |
| 💼 **Работа / Вакансии** | [Avito Jobs API](https://developers.avito.ru/api-catalog/job/documentation) |

Также **не реализовано** в v0.1.x:
- `authorization_code` OAuth flow (нужен публичный redirect URI — out of scope для локального CLI)
- Приём webhook-уведомлений мессенджера (нужен публичный URL; tool `messenger_post_webhook_v3` лишь регистрирует подписку, callback вы должны принимать сами)
- Avito sandbox-окружение (нет sandbox-credentials — все методы работают только с боевым)

## Безопасность

### Где хранятся credentials

- **Только на вашей машине.** stdio-транспорт = нет проксей, нет remote-эндпоинтов, никакой телеметрии.
- `Client_secret` — в блоке `env` MCP-конфига или в локальном `.env`.
- OAuth-токен кешируется в `$cwd/.avito-token.json` (chmod 600). Удалите файл — следующий запрос автоматически выпишет новый.
- Сервер общается **только** с `api.avito.ru` (хардкод в `src/config.ts`).

### Write-методы влияют на боевой аккаунт

Sandbox-окружения у Avito нет, все 139 tools работают с production API. Мутации:

- `messenger_post_send_*` — реальное сообщение клиенту (видит покупатель)
- `items_update_price` — изменит цену в живом объявлении
- `items_put_item_vas`, `promotion_*`, `cpa_*` — спишет деньги (VAS, продвижение)
- `orders_apply_transition` — изменит статус заказа

Безопасные read-only smoke-tools для проверки:
- `user_get_user_info_self`, `user_get_user_balance`
- `items_get_items_info`, `messenger_get_chats_v2`
- `meta_get_rate_limits`

### Рекомендации

- Используйте отдельный API-аккаунт с минимальными правами, если возможно.
- Перед автономным циклом write-методов — добавьте подтверждение пользователя в системный промпт агента.
- Регулярно ротируйте `Client_secret` в личном кабинете Avito.

## Установка из исходников (альтернатива npx)

Если по какой-то причине npx-вариант не подходит (нет интернета на машине для скачивания пакета, нужны изменения кода и т.д.):

```bash
git clone https://github.com/elchin92/avito-mcp.git
cd avito-mcp
npm install
cp .env.example .env
# отредактируйте .env — внесите Client_id, Client_secret, Profile_id
npm run build
```

Затем укажите в MCP-конфиге **абсолютный путь** к собранному файлу:

```json
{
  "mcpServers": {
    "avito": {
      "command": "node",
      "args": ["/абсолютный/путь/к/avito-mcp/dist/server.js"]
    }
  }
}
```

Шаблон `.mcp.json.example` лежит в репозитории.

## Troubleshooting

| Симптом | Что делать |
|---|---|
| Tool не появился в Claude/Cursor | Полностью перезапустите клиент (через системный трей, не Cmd+W). Проверьте JSON-синтаксис конфига. |
| Ошибка `Invalid .env: Client_id is required` | Заполните credentials в `env`-блоке конфига или в `.env`. Названия чувствительны к регистру: `Client_id`, не `client_id`. |
| 401 при первом запросе | Проверьте credentials в [личном кабинете](https://www.avito.ru/professionals/api). Удалите `.avito-token.json` (он сбросит кеш) и повторите. |
| 403 на конкретном tool | Не все scopes доступны для `client_credentials`-токена. Проверьте описание метода в `swaggers/`. |
| 404 на большинстве `delivery_*` | Это нормально — большая часть `delivery_*` — sandbox для партнёров СД, обычный аккаунт получит 403/404. |
| 429 Rate-limited | Сервер сам делает retry с backoff (1с/2с/4с). `meta_get_rate_limits` покажет текущие лимиты. |
| Бинарные ответы (PDF этикетки, mp3 записи) приходят как строка | Так и должно быть — MCP-text content. Для сохранения файла используйте прямой curl с Bearer-токеном. |
| Где смотреть логи MCP-сервера | stderr процесса. Claude Desktop: `~/Library/Logs/Claude/mcp-server-avito.log` (macOS). Запустите вручную `npx avito-mcp` чтобы видеть логи в терминале. |
| Перевыпустить токен | `rm $(pwd)/.avito-token.json` — следующий запрос автоматически сделает refresh. |
| Auto/Realty/Job методы не работают | Они не входят в этот MCP — см. раздел «Что НЕ поддерживается». |

## Архитектура (для контрибьюторов)

```
swaggers/<имя>.json                    ← OpenAPI Avito (источник правды)
        ↓
src/domains/<имя>.ts                   ← один файл на один swagger, ~10 строк на tool
        ↓
src/meta/domain-registry.ts            ← одна строка регистрации
        ↓
139 MCP tools через stdio
```

Сердце — `src/core/tool-factory.ts`: `defineTool(server, ctx, spec)` превращает декларативную spec (~7 строк) в работающий MCP tool с HTTP, OAuth-токеном, retry, маппингом ошибок и auto-inject `Profile_id`. Никакого `fetch()` внутри handler'ов.

### Как добавить новый swagger (4 шага)

1. Положите файл в `swaggers/<имя>.json`.
2. Создайте `src/domains/<имя>.ts` по образцу `src/domains/user.ts`.
3. Опишите endpoints через `defineTool(...)`.
4. Зарегистрируйте: одна строка в `src/meta/domain-registry.ts`.

Подробнее — [CONTRIBUTING.md](./CONTRIBUTING.md).

## Лицензия

[MIT](./LICENSE). Проект не аффилирован с Avito.ru. «Авито» — товарный знак, принадлежащий его правообладателю. Использование Avito API регулируется [условиями использования Avito](https://www.avito.ru/legal/pro_tools/public-api).
