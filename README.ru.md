# avito-mcp

[![npm version](https://img.shields.io/npm/v/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![npm downloads](https://img.shields.io/npm/dm/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/avito-mcp.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![Avito API snapshot](https://img.shields.io/badge/Avito_API_snapshot-2026--05--25-orange)](./swaggers)

> **Дайте вашим AI-агентам руки и ноги в Avito.**
> Локальный MCP-сервер, через который Claude, Cursor, Cline и любой другой AI-ассистент **делает реальную работу на Avito за вас** — отвечает клиентам, ведёт объявления, запускает продвижение, обрабатывает заказы, анализирует статистику. **139 инструментов** из **18 официальных API Avito**. Установка одной командой.

🇬🇧 **[English version →](./README.md)**

---

## Что это

Avito — крупнейший classifieds-маркетплейс России (~250M посетителей в месяц). Продажи там — это десятки повторяющихся операций каждый день: ответить в чате, обновить объявление, поднять VIP, выписать этикетку, посмотреть статистику.

`avito-mcp` отдаёт каждый публичный метод Avito API как инструмент, который ваш AI-агент может вызвать. Подключаете к любому MCP-клиенту — и агент ведёт вашу витрину на Avito автономно, по обычному диалогу.

- 🔌 **Универсальный** — работает с 15+ MCP-клиентами (Claude Desktop, Cursor, Cline, Continue, Windsurf, Zed, ChatGPT и др.)
- 🔒 **Локально** — stdio-транспорт, ключи никогда не покидают вашу машину
- 🤖 **Под автономию** — естественно стыкуется с multi-agent-фреймворками и cron-шедулерами для работы 24/7
- ⚡ **Без установки** — `npx -y avito-mcp`, без git clone, без сборки, без Docker

---

## Быстрый старт (≈90 секунд)

**1.** Получите OAuth-доступы в [личном кабинете Avito API](https://www.avito.ru/professionals/api): `Client_id`, `Client_secret` и `Profile_id` (числовой ID аккаунта — виден на той же странице).

**2.** Добавьте JSON в конфиг вашего MCP-клиента (**одинаковый для всех клиентов** — отличается только путь к файлу, см. следующий раздел):

```json
{
  "mcpServers": {
    "avito": {
      "command": "npx",
      "args": ["-y", "avito-mcp"],
      "env": {
        "Client_id": "ВАШ_CLIENT_ID",
        "Client_secret": "ВАШ_CLIENT_SECRET",
        "Profile_id": "ВАШ_PROFILE_ID"
      }
    }
  }
}
```

**3.** Перезапустите клиент. Спросите агента:

> *«Какой у меня баланс на Авито и сколько непрочитанных чатов?»*

Готово. Два API-вызова — реальный ответ.

---

## Для автономных сценариев

Большинство MCP-серверов рассчитаны на ручной вызов из окна чата. `avito-mcp` рассчитан на то, чтобы **работать сам** — его подхватывают multi-agent-runtime'ы и шедулеры, которые выполняются без вашего участия.

Типичные паттерны:

- **Реактивный агент** — Claude/Cursor открыт постоянно, мониторит новые чаты и отвечает клиентам в вашем стиле.
- **Cron-агент** — runtime поднимает агента каждые N минут: разобрать новые заказы, пополнить бюджеты продвижения, обновить статистику.
- **Multi-agent swarm** — отдельные агенты под «поддержку», «продвижение», «логистику» с разными наборами tools каждый.

stdio-транспорт оставляет credentials и ответы API на вашей машине. Никаких прокси. Никакого SaaS посередине.

→ Полный список совместимых runtime'ов — [modelcontextprotocol.io/clients](https://modelcontextprotocol.io/clients).

---

## Что включено — 139 инструментов

Каждый публичный endpoint из 18 OpenAPI-спецификаций Avito. Раскрывайте любую группу.

> **Дата снимка Avito API: 25 мая 2026.** Swagger-файлы в `./swaggers/` отражают публичный API Avito на эту дату. Avito периодически добавляет новые endpoints или меняет старые — если заметили рассинхрон (404 на известном методе, новый метод не покрыт), заведите issue и мы обновим снимок.

<details>
<summary>📋 <b>Объявления</b> — 11 инструментов (items_*)</summary>

- `items_get_items_info` — список ваших объявлений (фильтры по статусу, категории, пагинация)
- `items_get_item_info` — детали одного объявления
- `items_post_calls_stats` — статистика звонков по объявлениям в разрезе дней
- `items_post_vas_prices` — цены услуг продвижения для заданных объявлений
- `items_post_item_stats_shallow` — базовая статистика (просмотры/контакты/звонки) за период
- `items_post_item_analytics` — расширенная аналитика с группировкой и сортировкой
- `items_post_account_spendings` — разбивка расходов по типам услуг
- `items_update_price` ⚠️ — изменение цены объявления
- `items_put_item_vas` ⚠️ — применение одной платной услуги VAS
- `items_put_item_vas_package_v2` ⚠️ — применение пакета услуг VAS
- `items_apply_vas` ⚠️ — применение нескольких VAS-slug разом
</details>

<details>
<summary>💬 <b>Мессенджер</b> — 13 инструментов (messenger_*)</summary>

- `messenger_get_chats_v2` — список чатов (фильтры: непрочитанные, item_ids, типы чатов)
- `messenger_get_chat_by_id_v2` — детали одного чата
- `messenger_get_messages_v3` — история сообщений (пагинация)
- `messenger_get_voice_files` — URL аудиофайлов голосовых сообщений
- `messenger_get_subscriptions` — текущие webhook-подписки
- `messenger_post_send_message` ⚠️ — отправка реального сообщения клиенту
- `messenger_post_send_image_message` ⚠️ — отправка изображения (нужен upload)
- `messenger_upload_images` — multipart-загрузка, возвращает image_ids
- `messenger_delete_message` ⚠️ — удаление сообщения
- `messenger_chat_read` — отметить чат как прочитанный
- `messenger_post_blacklist_v2` ⚠️ — блокировка пользователей (с кодами причины)
- `messenger_post_webhook_v3` ⚠️ — подписка на push (нужен публичный URL)
- `messenger_post_webhook_unsubscribe` — отписка
</details>

<details>
<summary>📦 <b>Заказы</b> — 12 инструментов (orders_*)</summary>

- `orders_get_orders` — список заказов с фильтрами
- `orders_get_courier_delivery_range` — доступные слоты курьера
- `orders_download_label` — PDF-этикетка по taskID
- `orders_markings` ⚠️ — передача «Честного знака» (маркировка товара)
- `orders_accept_return_order` ⚠️ — отделение Почты России для возврата
- `orders_apply_transition` ⚠️ — изменение статуса (подтвердить/отгрузить/отменить)
- `orders_check_confirmation_code` — проверка кода подтверждения выдачи
- `orders_cnc_set_details` ⚠️ — детали click-and-collect заказа
- `orders_set_courier_delivery_range` ⚠️ — выбор слота курьера
- `orders_set_tracking_number` ⚠️ — установка трек-номера
- `orders_generate_labels` — генерация этикеток (≤100 заказов)
- `orders_generate_labels_extended` — генерация этикеток (≤1000)
</details>

<details>
<summary>🔄 <b>Автозагрузка</b> — 17 инструментов (autoload_*)</summary>

Загрузка XML/YML/CSV-фидов, отчёты, маппинг ID, справочник категорий. Включает v1 (deprecated, для совместимости) и v2/v3.

- `autoload_upload` ⚠️ — запуск выгрузки (лимит: 1 раз в час)
- `autoload_get_profile_v2`, `autoload_create_or_update_profile_v2` ⚠️ — управление профилем фидов
- `autoload_get_reports_v2` — список отчётов с пагинацией
- `autoload_get_report_by_id_v3`, `autoload_get_last_completed_report_v3` — детали отчётов
- `autoload_get_report_items_by_id`, `autoload_get_report_items_fees_by_id` — пер-айтемные результаты
- `autoload_get_ad_ids_by_avito_ids`, `autoload_get_avito_ids_by_ad_ids` — маппинг ID
- `autoload_user_docs_tree`, `autoload_user_docs_node_fields` — справочник категорий
- + 6 deprecated v1-эндпоинтов под их исходными именами
</details>

<details>
<summary>🚚 <b>Доставка</b> — 31 инструмент (delivery_*) <i>· партнёрский 3PL API</i></summary>

Партнёрский API логистики Avito для служб доставки. Обычным продавцам эти методы почти не нужны — они для СД-партнёров, интегрирующих свою систему с Avito Delivery. Включает production-эндпоинты и sandbox для тестирования. Полный список — в коде: [`src/domains/delivery.ts`](./src/domains/delivery.ts).
</details>

<details>
<summary>📈 <b>Продвижение и CPA</b> — 25 инструментов</summary>

- **BBIP-продвижение** (7) — `promotion_get_bbip_forecasts_by_items_v1`, `promotion_create_bbip_order_for_items_v1` ⚠️, `promotion_get_order_status_v1`, …
- **CPA** (11) — чаты/звонки по времени, баланс v2/v3, жалобы, телефоны из чатов — `cpa_*`
- **CPA настройка цены** (5) — `cpa_target_get_bids`, `cpa_target_save_auto_bid` ⚠️, `cpa_target_save_manual_bid` ⚠️, …
- **CPA-аукцион** (2) — `cpa_auction_get_user_bids`, `cpa_auction_save_item_bids` ⚠️
</details>

<details>
<summary>👤 <b>Профиль, Остатки, Иерархия, Отзывы</b> — 14 инструментов</summary>

- **Пользователь** (3) — `user_get_user_info_self`, `user_get_user_balance`, `user_post_operations_history`
- **Остатки** (2) — `stock_get_stocks_info`, `stock_update_stocks` ⚠️
- **Иерархия** (5) — суб-аккаунты, сотрудники, привязка объявлений (для сетей)
- **Отзывы** (4) — `reviews_get_reviews_v1`, `reviews_create_review_answer_v1` ⚠️, `reviews_remove_review_answer_v1` ⚠️, `reviews_get_ratings_info_v1`
</details>

<details>
<summary>🛠️ <b>Прочее</b> — 12 инструментов</summary>

- **Тарифы** (1) — справочник тарифов в категории Транспорт
- **TrxPromo** (3) — транзакционное продвижение: commissions / apply / cancel
- **CallTracking** (3) — записи и аудио звонков
- **Рассылка скидок** (5, beta) — массовые рассылки скидок в мессенджере
</details>

<details>
<summary>🔐 <b>Auth и Meta</b> — 4 инструмента</summary>

- **Auth** (3) — `auth_get_access_token` (для отладки; сервер сам управляет токенами), `auth_get_access_token_authorization_code`, `auth_refresh_access_token_authorization_code`
- **Meta** (1) — `meta_get_rate_limits` — отслеживание X-RateLimit-* по всем доменам
</details>

> ⚠️ — методы которые **тратят деньги или меняют боевые данные** (цены, платные услуги, сообщения клиентам, блокировки). Безопасные read-only методы для первого знакомства: `user_get_user_balance`, `items_get_items_info`, `messenger_get_chats_v2`, `meta_get_rate_limits`.

---

## Подключение к AI-клиентам

JSON из «Быстрого старта» подходит **любому** MCP-совместимому клиенту — отличается только путь к конфигу. Выбирайте свой:

<details>
<summary><b>Claude Desktop</b> (macOS / Windows / Linux)</summary>

| ОС | Путь |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Если файла нет — создайте; если есть — добавьте секцию `avito` в `mcpServers`. **Полностью закройте** Claude Desktop (через системный трей) и откройте заново — внизу чата появится индикатор «🔌 avito».

Логи: `~/Library/Logs/Claude/mcp-server-avito.log` (macOS).
</details>

<details>
<summary><b>Claude Code</b> (CLI)</summary>

Самый простой способ — одна команда:

```bash
claude mcp add avito npx -y avito-mcp \
  -e Client_id=ВАШ_CLIENT_ID \
  -e Client_secret=ВАШ_CLIENT_SECRET \
  -e Profile_id=ВАШ_PROFILE_ID
```

Или добавьте `.mcp.json` в корень проекта (JSON из Quick Start плюс `"type": "stdio"`). Проверка: `claude mcp list`.
</details>

<details>
<summary><b>Cursor</b></summary>

Путь: `~/.cursor/mcp.json` (глобально) или `<project>/.cursor/mcp.json` (per-project). JSON из Quick Start. После сохранения — `Cmd/Ctrl + Shift + P` → «Reload Window».
</details>

<details>
<summary><b>ChatGPT Desktop</b> (Connectors / MCP)</summary>

OpenAI добавил поддержку MCP в Desktop через Connectors. Settings → Connectors → Add custom MCP server → заполните:
- Name: `Avito`
- Type: `stdio`
- Command: `npx`
- Arguments: `-y avito-mcp`
- Environment variables: `Client_id`, `Client_secret`, `Profile_id`
</details>

<details>
<summary><b>Windsurf</b> (Codeium)</summary>

Путь: `~/.codeium/windsurf/mcp_config.json`. JSON из Quick Start. Альтернативно через UI: Settings → Cascade → MCP Servers → Add Server.
</details>

<details>
<summary><b>Cline</b> (расширение VS Code)</summary>

В VS Code: иконка Cline → ⚙️ → MCP Servers → Edit `cline_mcp_settings.json`.

| ОС | Путь |
|---|---|
| macOS | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |
| Linux | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |

JSON из Quick Start. Cline подхватывает изменения без перезагрузки VS Code.
</details>

<details>
<summary><b>Continue</b> (VS Code / JetBrains)</summary>

Добавьте в `~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "avito-mcp"],
          "env": { "Client_id": "...", "Client_secret": "...", "Profile_id": "..." }
        }
      }
    ]
  }
}
```
</details>

<details>
<summary><b>Zed</b></summary>

Settings (`Cmd+,`), найдите блок `context_servers`:

```json
{
  "context_servers": {
    "avito": {
      "command": {
        "path": "npx",
        "args": ["-y", "avito-mcp"],
        "env": { "Client_id": "...", "Client_secret": "...", "Profile_id": "..." }
      }
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b> (GitHub Copilot Chat с MCP)</summary>

Microsoft добавил поддержку MCP в Copilot Chat в 2025. Создайте `.vscode/mcp.json` в workspace или используйте Command Palette → «MCP: Add Server». Тот же JSON из Quick Start.
</details>

<details>
<summary><b>Codex CLI</b> (OpenAI)</summary>

CLI-ассистент OpenAI поддерживает MCP через `~/.codex/config.toml`:

```toml
[mcp_servers.avito]
command = "npx"
args = ["-y", "avito-mcp"]
env = { Client_id = "...", Client_secret = "...", Profile_id = "..." }
```
</details>

<details>
<summary><b>JetBrains AI Assistant</b></summary>

Settings → Tools → AI Assistant → MCP → Add server. Те же поля (command `npx`, args `-y avito-mcp`, env). Работает в IntelliJ IDEA, PyCharm, WebStorm, GoLand, Rider.
</details>

<details>
<summary><b>Goose</b> (Block)</summary>

Open-source CLI-агент от Block. `goose configure` → MCP server → вставьте JSON из Quick Start. Конфиг живёт в `~/.config/goose/config.yaml`.
</details>

<details>
<summary><b>Roo Code / Kilo Code</b> (форки Cline)</summary>

Это форки Cline с теми же путями конфигов — замените `saoudrizwan.claude-dev` в пути на ID расширения (`rooveterinaryinc.roo-cline` или `kilocode.kilo-code`). JSON идентичен.
</details>

<details>
<summary><b>LibreChat</b> (self-hosted ChatGPT-альтернатива)</summary>

Отредактируйте `librechat.yaml`:

```yaml
mcpServers:
  avito:
    type: stdio
    command: npx
    args: ["-y", "avito-mcp"]
    env:
      Client_id: "..."
      Client_secret: "..."
      Profile_id: "..."
```
</details>

<details>
<summary><b>Cherry Studio</b></summary>

Settings → MCP Servers → Add. Поля UI: name `avito`, command `npx`, args `-y avito-mcp`, env-переменные те же.
</details>

<details>
<summary><b>Любой другой MCP-клиент</b></summary>

Сервер говорит на стандартном stdio MCP. Универсальные параметры:
- `command`: `npx`
- `args`: `["-y", "avito-mcp"]`
- `env`: `{ Client_id, Client_secret, Profile_id }`
- `transport`: `stdio`

Свежий список клиентов — [MCP clients directory](https://modelcontextprotocol.io/clients).
</details>

---

## Примеры промптов

Скопируйте в свой AI-клиент чтобы увидеть на что он способен:

**📊 Анализ**
- *«Какой у меня баланс на Авито и сколько потратил на продвижение в этом месяце?»*
- *«Топ-10 объявлений по контактам за неделю — таблицей с просмотрами/контактами/конверсией.»*
- *«Найди объявления у которых звонки упали на 50%+ по сравнению с прошлой неделей.»*

**💬 Коммуникация**
- *«Покажи непрочитанные чаты за последние сутки и ответь каждому: "Здравствуйте! Да, актуально, куда вам удобнее доставку?"»*
- *«Прочитай полностью переписку в чате X и предложи лучший ответ в моём стиле.»*

**💰 Продвижение**
- *«Сделай прогноз BBIP на 1000₽ для объявления 12345 — выгодно?»*
- *«Установи ручную CPA-ставку 500₽ на топ-10 объявлений в категории "Электроника".»*

**📦 Заказы**
- *«Покажи все заказы со статусом `ready_to_ship` и сгенерируй этикетки одним PDF.»*
- *«Для заказа ABCD найди доступный слот курьера на завтрашнее утро.»*

**🤖 Автоматизация**
- *«Каждый будний день в 9:00 присылай в Telegram: баланс, число новых заказов, число непрочитанных чатов, топ расходов на продвижение.»*
- *«Если какой-то чат непрочитан 6+ часов — подготовь ответ и попроси меня подтвердить.»*

---

## Что НЕ поддерживается

Для следующих вертикалей Avito предоставляет **отдельные API** — их swagger-спецификации не входят в этот проект:

| Категория | Где искать |
|---|---|
| 🏷️ Аукцион | [Avito Auction API](https://developers.avito.ru/api-catalog/auction/documentation) |
| 🤖 Автостратегии (автоматическое управление ставками) | [Avito Autostrategy API](https://developers.avito.ru/api-catalog/autostrategy/documentation) |
| 🚗 Автотека (отчёты по истории автомобилей) | [Avito Autoteka API](https://developers.avito.ru/api-catalog/autoteka/documentation) |
| 💼 Работа / Вакансии | [Avito Jobs API](https://developers.avito.ru/api-catalog/job/documentation) |
| 📊 Отчёты по недвижимости | [Avito Realty Reports API](https://developers.avito.ru/api-catalog/realty-reports/documentation) |
| 🏠 Краткосрочная аренда (квартиры посуточно) | [Avito STR API](https://developers.avito.ru/api-catalog/str/documentation#ApiDescriptionBlock) |

Также вне scope: `authorization_code` OAuth flow (нужен публичный redirect URI), приём webhook-уведомлений (нужен публичный URL), Avito sandbox (нет sandbox-credentials).

---

## Безопасность

- **Только локальное stdio** — никаких прокси, remote-эндпоинтов, телеметрии.
- Credentials живут в блоке `env` MCP-клиента или в локальном `.env`. Никуда не отправляются кроме `api.avito.ru`.
- OAuth-токены кешируются в `$cwd/.avito-token.json` (chmod 600). Удалите файл — следующий запрос автоматически выпишет новый.
- **Все 139 tools работают с production** — sandbox у Avito нет. Write-методы тратят деньги или видны клиентам. Безопасные read-only для первого знакомства: `user_get_user_balance`, `items_get_items_info`, `messenger_get_chats_v2`, `meta_get_rate_limits`.
- **Нашли уязвимость?** Приватный канал — [SECURITY.md](./SECURITY.md). Не открывайте публичный issue.

---

## Сообщество и поддержка

- **Баг?** [Создайте issue](https://github.com/elchin92/avito-mcp/issues/new/choose).
- **Вопрос или идея?** [Откройте discussion](https://github.com/elchin92/avito-mcp/discussions).
- **Нужна помощь по выбору tool'а или настройке клиента?** Смотрите [SUPPORT.md](./SUPPORT.md).
- **Хотите помочь?** Добавить новый swagger Avito — это ~10 минут работы, см. [CONTRIBUTING.md](./CONTRIBUTING.md).
- **Нравится проект?** Поставьте звезду и расскажите другому продавцу с Avito, который использует AI.

---

## Установка из исходников

Для разработки, air-gapped установки или если хотите изменить tool:

```bash
git clone https://github.com/elchin92/avito-mcp.git
cd avito-mcp
npm install
cp .env.example .env       # заполните credentials
npm run build
```

Затем укажите в MCP-конфиге:
```json
{ "command": "node", "args": ["/абсолютный/путь/к/avito-mcp/dist/server.js"] }
```

Шаблон конфига — в [.mcp.json.example](./.mcp.json.example).

---

## Troubleshooting

| Проблема | Решение |
|---|---|
| Tool не появился в Claude/Cursor | Полностью перезапустите клиент (через системный трей). Проверьте JSON-синтаксис конфига. |
| `Invalid .env: Client_id is required` | Заполните credentials. Названия чувствительны к регистру: `Client_id`, не `client_id`. |
| 401 при первом запросе | Проверьте credentials в [личном кабинете API](https://www.avito.ru/professionals/api). Удалите `.avito-token.json` и повторите. |
| 403 на конкретном tool | Не все scopes доступны для `client_credentials`-токена. Смотрите описание метода в `swaggers/`. |
| 404 на большинстве `delivery_*` | Это нормально — большая часть `delivery_*` — для партнёров служб доставки, обычный аккаунт получит 403/404. |
| 429 Rate-limited | Сервер сам retry с backoff (1с/2с/4с). `meta_get_rate_limits` покажет лимиты. |
| Где логи | stderr. Claude Desktop: `~/Library/Logs/Claude/mcp-server-avito.log` (macOS). |
| Сбросить токен | `rm $(pwd)/.avito-token.json` — следующий запрос сделает refresh. |

---

## Архитектура (для контрибьюторов)

```
swaggers/<имя>.json                 ← OpenAPI Avito (источник правды)
        ↓
src/domains/<имя>.ts                ← один файл = один swagger, ~10 строк на tool
        ↓
src/meta/domain-registry.ts         ← одна строка регистрации
        ↓
139 MCP tools через stdio
```

Сердце — `src/core/tool-factory.ts`: `defineTool(server, ctx, spec)` превращает декларативную spec в работающий MCP tool с HTTP, OAuth-токеном, retry, маппингом ошибок и автоподстановкой `Profile_id`. Никаких `fetch()` внутри handler'ов.

**Добавить новый swagger (4 шага):** см. [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Лицензия

[MIT](./LICENSE). Проект не аффилирован с Avito.ru. «Авито» — товарный знак, принадлежащий его правообладателю. Использование Avito API регулируется [условиями использования Avito](https://www.avito.ru/legal/pro_tools/public-api).
