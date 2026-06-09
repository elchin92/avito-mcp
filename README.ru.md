# avito-mcp

[![npm version](https://img.shields.io/npm/v/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![npm downloads](https://img.shields.io/npm/dm/avito-mcp.svg)](https://www.npmjs.com/package/avito-mcp)
[![CI](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/elchin92/avito-mcp/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-141_passing-brightgreen)](./test)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](./tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/avito-mcp.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![GitHub stars](https://img.shields.io/github/stars/elchin92/avito-mcp?style=social)](https://github.com/elchin92/avito-mcp/stargazers)
[![Avito API snapshot](https://img.shields.io/badge/Avito_API_snapshot-2026--05--25-orange)](./swaggers)

> **Дайте вашим AI-агентам руки и ноги в Avito.**
> Локальный MCP-сервер, через который Claude, Cursor, Cline и любой другой AI-ассистент **делает реальную работу на Avito за вас** — отвечает клиентам, ведёт объявления, запускает продвижение, обрабатывает заказы, анализирует статистику. **141 Avito API tools** + **7 локальных meta-tools** = до **148 MCP tools** из **18 официальных API Avito**. Установка одной командой.

🇬🇧 **[English version →](./README.md)**

> **Новое в v0.9.0** — **удалённый MCP по HTTP** (Streamable HTTP, защита через OAuth 2.1) и **приёмник webhook Avito** (события чатов в реальном времени + 3 новых tools). stdio остаётся режимом по умолчанию. См. [Удалённый MCP](#удалённый-mcp-по-http-oauth-21-v090) · [Webhook](#приёмник-webhook-avito-v090) · полная история — в [CHANGELOG](./CHANGELOG.md).

---

## Что это

Avito — крупнейший classifieds-маркетплейс России (~250M посетителей в месяц). Продажи там — это десятки повторяющихся операций каждый день: ответить в чате, обновить объявление, поднять VIP, выписать этикетку, посмотреть статистику.

`avito-mcp` отдаёт каждый публичный метод Avito API как инструмент, который ваш AI-агент может вызвать. Подключаете к любому MCP-клиенту — и агент ведёт вашу витрину на Avito автономно, по обычному диалогу.

- 🔌 **Универсальный** — работает с 15+ MCP-клиентами (Claude Desktop, Cursor, Cline, Continue, Windsurf, Zed, ChatGPT и др.)
- 🔒 **Локально по умолчанию** — stdio-транспорт, ключи никогда не покидают вашу машину (опционально — [удалённый HTTP-режим](#удалённый-mcp-по-http-oauth-21-v090) для командных/общих развёртываний)
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

## Что включено — до 148 инструментов

| Конфигурация | Видимо tools |
|---|---|
| По умолчанию (`AVITO_MCP_MODE=full_access`, без opt-in) | **144** |
| + `AVITO_MCP_EXPOSE_AUTH_TOOLS=1` | 147 (+3 auth) |
| + `AVITO_MCP_ALLOWED_UPLOAD_DIRS=…` | 145 (+1 upload) |
| + Оба opt-in | **148** |
| `AVITO_MCP_CONFIRMATION_MODE=off` | −3 (скрывает meta_*_action) |
| `AVITO_MCP_MODE=read_only` | ~82 (только `risk=read`) |
| `AVITO_MCP_MODE=guarded` | ~125 (добавляет `write`, скрывает `money`/`public`) |

141 — обёртки над эндпойнтами Avito API; 7 — локальные meta-tools: `meta_get_rate_limits`, три `meta_*_action` для confirmation flow (когда включён), плюс `meta_health`, `meta_auth_status`, `meta_capabilities` (v0.7.0). Avito-счётчик вырос на 3 в v0.9.0 — новые `messenger_get_webhook_events`, `messenger_get_webhook_status` и `messenger_register_webhook` (см. [Webhook](#приёмник-webhook-avito-v090)). Полный реестр — в `dist/manifest.json` (`npm run generate:manifest`).

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
<summary>💬 <b>Мессенджер</b> — 16 инструментов (messenger_*)</summary>

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
- `messenger_get_webhook_events` — забрать события встроенного [приёмника webhook](#приёмник-webhook-avito-v090) (v0.9.0)
- `messenger_get_webhook_status` — статистика приёмника: хранится / всего принято / последнее событие (v0.9.0)
- `messenger_register_webhook` ⚠️ — подписать настроенный публичный URL у Avito одним вызовом (v0.9.0)
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

## MCP-ресурсы и промпты (v0.6.0)

Кроме tool-ов сервер теперь отдаёт MCP **resources** (данные, доступные агенту без вызова API) и **prompts** (готовые сценарии, которые сами оркестрируют нужные tool-ы в нужном порядке).

### Resources

| URI | Тип | Что внутри |
|---|---|---|
| `avito://docs/safety` | `text/markdown` | Гайд по safety-режимам + confirmation |
| `avito://manifest` | `application/json` | Live-реестр tools (risk / domain / title / annotations) |
| `avito://state/config` | `application/json` | Снимок активного config — секреты redacted |
| `avito://state/rate-limits` | `application/json` | Последние `X-RateLimit-*` по доменам Avito |
| `avito://state/pending-actions` | `application/json` | Pending-confirmations — **subscribable**, шлёт `notifications/resources/updated` |
| `avito://webhook/events` | `application/json` | Буфер событий [webhook](#приёмник-webhook-avito-v090) Avito — **subscribable** (v0.9.0) |
| `avito://swaggers/{slug}` | `application/json` | По одному resource на каждый файл из `swaggers/` (с автодополнением через `complete`) |

Подписавшись на `avito://state/pending-actions`, клиент видит каждое создание/подтверждение/отмену/истечение в реальном времени — идеально для UI с индикатором «жду подтверждения». Подписка на `avito://webhook/events` уведомляет клиента в момент, когда Avito доставляет новое событие чата.

### Prompts

| Имя | Аргументы | Что делает |
|---|---|---|
| `avito_daily_overview` | `days?` (default 7) | Баланс + активные объявления + расходы (read-only, без confirmation) |
| `avito_check_unread_chats` | `limit?` (default 20) | Резюме непрочитанных чатов; явный guard "не отправлять / не блокировать" |
| `avito_safety_report` | — | Самоописание через `state/config` + `manifest` + `docs/safety` |
| `avito_explain_tool` | `tool_name` | Развёрнутое описание одного tool: запись в manifest + соответствующий swagger |
| `avito_promote_item` | `item_id` | Собрать всё нужное перед платной VAS-покупкой; явный guard «не покупай» |

### Структурированный вывод tool-ов

Каждый tool теперь возвращает `structuredContent` параллельно с текстовым блоком — клиенты могут парсить Avito-ответы как JSON без regex:

- Объекты → `{ status, ...data }`
- Массивы → `{ status, items, count }`
- Бинарные (PDF этикетки, аудио) → `{ status, mimeType, sizeBytes, base64 }`
- Ошибки → `{ error_kind, status?, request, body? }` с `isError: true`

### MCP-logging

Избранные pino-события (смена режима, скрытые tools, lifecycle confirmation, warning-и rate-limit) дублируются клиенту как `notifications/message` с `logger: "avito-mcp"`. Клиенты, регулирующие уровень через `logging/setLevel`, работают как ожидается. Pino → stderr сохраняется.

---

## Универсальные safety-примитивы (v0.7.0)

Opt-in примитивы, чтобы пакет безопасно жил в **любом** автоматическом контексте — ручной чат, cron, multi-agent, серверная ферма — без привязки к конкретному оркестратору или backend-у.

### Dry-run

Каждый destructive tool (`risk: write | money | public`) принимает опциональный `dryRun: boolean`. При `true` возвращается preview HTTP-запроса, который сервер бы сделал — без обращения к Avito. Полезно и для человека («что агент хочет сделать?»), и для агента, который хочет «подумать перед действием».

```json
{
  "name": "items_update_price",
  "arguments": { "item_id": 12345, "price": 1400, "dryRun": true }
}
```

→ `structuredContent: { dryRun: true, operation: { tool, method, path, ... }, request_preview: { ... } }`, `fetch` не вызывается.

Дефолт можно перевернуть глобально: `AVITO_MCP_DRY_RUN_DEFAULT=true` или флаг `--dry-run`. Тогда любой destructive tool сначала отдаёт preview, пока агент явно не передаст `dryRun: false`.

### Idempotency

Каждый destructive tool принимает опциональный `idempotencyKey: string`. Сервер хранит in-memory ledger по `(tool, key, hash(args))`:

- Первый вызов: исполнение, кеш результата.
- Повтор с тем же ключом и теми же args в течение TTL: возвращается кеш с пометкой `structuredContent.idempotent_replay: true`. Второй HTTP-вызов НЕ делается.
- Повтор с тем же ключом и ДРУГИМИ args: structured-ошибка `IdempotencyConflictError` (нарушен контракт дедупа).

Простейшая надёжная защита от дублей при retries, crashes, race conditions между параллельными агентами. TTL — `AVITO_MCP_IDEMPOTENCY_TTL_SEC` (default 1 час).

### Структурированная таксономия ошибок

Все ошибки возвращают и текст, и машинный envelope:

```json
{
  "isError": true,
  "structuredContent": {
    "error": {
      "type": "AVITO_RATE_LIMIT",
      "message": "Avito API 429 for POST ...",
      "retryable": true,
      "retryAfter": 60,
      "httpStatus": 429
    }
  }
}
```

`type` ∈ `AVITO_BAD_REQUEST | AVITO_UNAUTHORIZED | AVITO_FORBIDDEN | AVITO_NOT_FOUND | AVITO_RATE_LIMIT | AVITO_SERVER_ERROR | AVITO_API_ERROR | NETWORK_ERROR | TIMEOUT | INTERNAL_ERROR`.

Агент решает по `retryable` и `retryAfter` программно — без regex по тексту.

### Health / auth / capabilities meta-tools

| Tool | Что возвращает |
|---|---|
| `meta_health` | Снимок здоровья: версия, uptime, capabilities, safety mode, счётчики (pending actions, idempotency entries, rate-limit snapshots) |
| `meta_auth_status` | Только МЕТАДАННЫЕ OAuth токена — `tokenPresent`, `expiresInSec`, last error. Сам токен НЕ отдаётся НИКОГДА. С `probe: true` попробует refresh. |
| `meta_capabilities` | Машинно-читаемый config: mode, allow/deny counts, feature flags (`dryRun`, `idempotency`, `confirmation`, `hardConfirmation`, `fileUploads`, `sensitiveAuthTools`) |

У всех трёх — строгий `outputSchema` (zod), клиенты могут валидировать.

### Cross-process token lock

Если запущено несколько процессов avito-mcp на одном tokenFile (cron + chat + CLI), они больше не идут параллельно в Avito `/token`. Первый берёт `{tokenFile}.lock`, рефрешит; остальные ждут и читают свежий токен с диска. Stale locks (мёртвый PID, древний timestamp) снимаются автоматически. Tunable: `AVITO_MCP_TOKEN_LOCK_TIMEOUT_MS` (default 30s).

### CLI флаги

Sugar над env-переменными (env побеждает если задано и то и то):

```bash
avito-mcp --readonly             # AVITO_MCP_MODE=read_only
avito-mcp --guarded              # AVITO_MCP_MODE=guarded
avito-mcp --dry-run              # AVITO_MCP_DRY_RUN_DEFAULT=true
avito-mcp --no-confirmation      # AVITO_MCP_CONFIRMATION_MODE=off
avito-mcp --health               # печатает JSON health-snapshot и выходит
```

`--health` не открывает stdio transport — годится для Docker / Kubernetes / supervisord healthcheck-ов:

```yaml
healthcheck:
  test: ["CMD", "avito-mcp", "--health"]
  interval: 30s
```

---

## Удалённый MCP по HTTP (OAuth 2.1) (v0.9.0)

По умолчанию `avito-mcp` говорит по **stdio** — идеально для локального клиента. В v0.9.0 добавлен опциональный **удалённый** режим: отдавать те же 148 tools по сети как **Streamable HTTP** MCP-сервер, чтобы хостовый агент, команда или клиент с телефона подключались к одному общему инстансу. Доступ закрыт **OAuth 2.1** (authorization-code + PKCE + Dynamic Client Registration) с экраном согласия и участием человека.

### Включение

```bash
AVITO_MCP_TRANSPORT=http            # stdio (default) | http | both   (CLI: --http)
AVITO_MCP_HTTP_HOST=127.0.0.1       # Node всегда слушает loopback; TLS — задача прокси
AVITO_MCP_HTTP_PORT=3000
AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com   # ваш публичный TLS-домен, БЕЗ завершающего слэша
AVITO_MCP_HTTP_AUTH=oauth           # oauth (default) | bearer | none
AVITO_MCP_OAUTH_OWNER_PASSWORD=…    # ОБЯЗАТЕЛЬНО в режиме oauth — единственный, кто может выпустить токен
# Client_id / Client_secret / Profile_id как обычно (Avito-доступы, от имени которых работает сервер)
```

`both` поднимает stdio **и** HTTP одновременно — удобно, когда один процесс обслуживает локального и удалённого клиента сразу.

### Как работает OAuth-flow

1. Клиент обращается к `/.well-known/oauth-protected-resource` на `/mcp`, находит authorization server и читает `/.well-known/oauth-authorization-server`.
2. Клиент **сам регистрируется** через Dynamic Client Registration (`POST /register`) — без ручной настройки клиента.
3. Запускает **authorization-code + PKCE**: открывает `/authorize` в браузере.
4. **Человек подтверждает** на `/authorize`, вводя `AVITO_MCP_OAUTH_OWNER_PASSWORD`. Это и есть барьер — без owner-пароля токен не выпускается никогда.
5. Клиент обменивает код на `/token` на bearer-токен (TTL `AVITO_MCP_OAUTH_TOKEN_TTL_SEC`, default 3600с), и этот токен защищает каждый запрос к `/mcp`.

| Endpoint | Назначение |
|---|---|
| `/mcp` | Streamable HTTP MCP-транспорт (сами tools) |
| `/.well-known/oauth-authorization-server` | Метаданные OAuth 2.1 AS |
| `/.well-known/oauth-protected-resource` | Метаданные resource-server для `/mcp` |
| `/authorize` | Экран согласия — человек вводит owner-пароль |
| `/token` | Обмен authorization-code → bearer-токен |
| `/register` | Dynamic Client Registration (DCR) |
| `/healthz` | Liveness-проба (без auth) |

### Все env-переменные HTTP / OAuth

| Переменная | Default | Смысл |
|---|---|---|
| `AVITO_MCP_TRANSPORT` | `stdio` | `stdio` \| `http` \| `both` (CLI-флаг `--http`) |
| `AVITO_MCP_HTTP_HOST` | `127.0.0.1` | Bind-адрес — держите loopback за прокси |
| `AVITO_MCP_HTTP_PORT` | `3000` | Порт прослушивания |
| `AVITO_MCP_HTTP_PUBLIC_URL` | — | Публичный TLS-базис для построения OAuth issuer / resource metadata. **Без завершающего слэша.** |
| `AVITO_MCP_HTTP_AUTH` | `oauth` | `oauth` \| `bearer` \| `none` |
| `AVITO_MCP_OAUTH_OWNER_PASSWORD` | — | **Обязательно в режиме `oauth`.** Закрывает `/authorize` — единственный секрет, выпускающий токен. |
| `AVITO_MCP_OAUTH_TOKEN_TTL_SEC` | `3600` | Время жизни выпущенного bearer-токена |
| `AVITO_MCP_OAUTH_STORE_FILE` | — | Опциональный файл для персиста токенов/клиентов между рестартами |
| `AVITO_MCP_HTTP_AUTH_TOKEN` | — | Режим `bearer`: общий секрет(ы), через запятую |
| `AVITO_MCP_HTTP_ALLOW_NO_AUTH` | `0` | Разрешить `auth=none` на не-loopback хосте (**не рекомендуется**) |
| `AVITO_MCP_HTTP_ALLOWED_HOSTS` | — | CSV — защита от DNS-rebinding (допустимые значения `Host`) |
| `AVITO_MCP_HTTP_ALLOWED_ORIGINS` | — | CSV — защита от DNS-rebinding (допустимые значения `Origin`) |

> **Модель безопасности.** Node слушает `127.0.0.1` и говорит по обычному HTTP. **TLS терминирует reverse-proxy** (nginx / Caddy) на вашем домене, проксируя на `http://127.0.0.1:3000`. Никогда не выставляйте порт 3000 напрямую в интернет. `auth=none` на публичном хосте отклоняется, пока не задано `AVITO_MCP_HTTP_ALLOW_NO_AUTH=1`.

### Сниппеты reverse-proxy (терминируют TLS для `https://mcp.example.com`)

Оба проксируют MCP-endpoint, OAuth discovery/flow-эндпоинты и путь webhook, и **сохраняют заголовок `Host`** (OAuth-метаданные строятся из него).

<details open>
<summary><b>nginx</b></summary>

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    # MCP-транспорт + OAuth (discovery, authorize, token, register) + приёмник webhook.
    location ~ ^/(mcp|\.well-known/oauth-authorization-server|\.well-known/oauth-protected-resource|authorize|token|register|avito/webhook) {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header   Host              $host;          # сохраняем Host — от него зависят OAuth-метаданные
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;

        # Streamable HTTP держит долгоживущие ответы открытыми:
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
```
</details>

<details>
<summary><b>Caddy</b></summary>

```caddyfile
mcp.example.com {
    # Caddy сам получает и обновляет TLS-сертификат.
    # Caddy по умолчанию сохраняет заголовок Host (header_up не нужен).
    reverse_proxy /mcp* http://127.0.0.1:3000
    reverse_proxy /.well-known/oauth-authorization-server http://127.0.0.1:3000
    reverse_proxy /.well-known/oauth-protected-resource   http://127.0.0.1:3000
    reverse_proxy /authorize* http://127.0.0.1:3000
    reverse_proxy /token*     http://127.0.0.1:3000
    reverse_proxy /register*  http://127.0.0.1:3000
    reverse_proxy /avito/webhook* http://127.0.0.1:3000
}
```
</details>

### Проще: режим bearer

Если вы контролируете оба конца и полный OAuth-танец не нужен — задайте `AVITO_MCP_HTTP_AUTH=bearer` и общий секрет:

```bash
AVITO_MCP_TRANSPORT=http
AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com
AVITO_MCP_HTTP_AUTH=bearer
AVITO_MCP_HTTP_AUTH_TOKEN=long-random-secret,another-secret   # один или несколько, через запятую
```

Клиенты тогда шлют `Authorization: Bearer long-random-secret` на `/mcp`. Та же конфигурация reverse-proxy применима.

---

## Приёмник webhook Avito (v0.9.0)

Поллинг `messenger_get_chats_v2` работает, но для **реакций в реальном времени** (ответить в момент, когда клиент написал) Avito может **пушить** события вам. В v0.9.0 встроен приёмник: укажите Avito секретный URL — и сервер буферизует каждое событие для вашего агента.

Работает **даже в чистом stdio-режиме** — Avito нужен лишь публичный URL для POST'а; ваш MCP-клиент его не касается. (Если `AVITO_MCP_TRANSPORT=stdio` и задан webhook-секрет, сервер всё равно поднимает крошечный HTTP-listener только для приёмника.)

### Включение

```bash
AVITO_MCP_WEBHOOK_SECRET=…                              # включает приёмник; становится секретным сегментом пути
AVITO_MCP_WEBHOOK_PUBLIC_URL=https://mcp.example.com    # публичный базис, куда POST'ит Avito (default — HTTP public URL)
# AVITO_MCP_WEBHOOK_PATH=/avito/webhook                 # default
# AVITO_MCP_WEBHOOK_BUFFER=100                          # размер ring-буфера (событий в памяти)
# AVITO_MCP_WEBHOOK_LOG_FILE=/var/log/avito-webhook.jsonl   # опциональный JSONL-аудитлог
```

Avito доставляет на:

```
POST {AVITO_MCP_WEBHOOK_PUBLIC_URL}{AVITO_MCP_WEBHOOK_PATH}/{AVITO_MCP_WEBHOOK_SECRET}
  → 200 {"ok":true}      (отвечается заметно быстрее 2-секундного дедлайна Avito)
```

Секрет — часть пути, поэтому URL неугадываем; это и есть авторизация. Подпишите URL у Avito через кабинет или одним вызовом нового tool `messenger_register_webhook`.

| Переменная | Default | Смысл |
|---|---|---|
| `AVITO_MCP_WEBHOOK_SECRET` | — | Включает приёмник; неугадываемый сегмент пути, куда бьёт Avito |
| `AVITO_MCP_WEBHOOK_ENABLED` | `0` | Альтернативный тумблер (секрет + этот флаг, если нужен явный переключатель) |
| `AVITO_MCP_WEBHOOK_PUBLIC_URL` | (HTTP public URL) | Публичный базис, куда POST'ит Avito |
| `AVITO_MCP_WEBHOOK_PATH` | `/avito/webhook` | Префикс пути перед секретным сегментом |
| `AVITO_MCP_WEBHOOK_BUFFER` | `100` | Размер in-memory ring-буфера |
| `AVITO_MCP_WEBHOOK_LOG_FILE` | — | Опциональный JSONL — каждое сырое событие дописывается для аудита/реплея |

### Чтение событий

| Поверхность | Что даёт |
|---|---|
| `messenger_get_webhook_events` (tool, read) | Забрать буфер событий — фильтры `chat_id`, `since`, `limit` |
| `messenger_get_webhook_status` (tool, read) | Статистика приёмника: хранится / всего принято / последнее событие / размер буфера |
| `messenger_register_webhook` (tool, ⚠️ write) | Подписать настроенный публичный URL у Avito |
| `avito://webhook/events` (resource, **subscribable**) | Те же события как MCP-resource; `resources/subscribe` для live-пуша в клиент |

Типичный цикл: подписаться на `avito://webhook/events`, на каждый `notifications/resources/updated` прочитать новое событие, составить ответ и (после подтверждения) отправить через `messenger_post_send_message`.

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

Также вне scope: `authorization_code` OAuth flow (нужен публичный redirect URI) и Avito sandbox (нет sandbox-credentials). **Приём webhook-уведомлений** поддерживается с v0.9.0 — см. раздел [Webhook](#приёмник-webhook-avito-v090).

---

## Безопасность

- **Локальное stdio по умолчанию** — никаких прокси, remote-эндпоинтов, телеметрии. Опциональный [удалённый HTTP-режим](#удалённый-mcp-по-http-oauth-21-v090) — opt-in (`AVITO_MCP_TRANSPORT=http`), слушает loopback и закрыт OAuth 2.1 (или bearer-секретом) за вашим собственным TLS-прокси.
- Credentials живут в блоке `env` MCP-клиента или в локальном `.env`. Никуда не отправляются кроме `api.avito.ru`.
- OAuth-токены кешируются в персональной директории (chmod 600):
  - Linux: `$XDG_STATE_HOME/avito-mcp/token.json` (≈ `~/.local/state/avito-mcp/token.json`)
  - macOS: `~/Library/Application Support/avito-mcp/token.json`
  - Windows: `%APPDATA%\avito-mcp\token.json`
  - Изменить путь — через `AVITO_TOKEN_FILE`. Удалите файл — следующий запрос автоматически выпишет новый.
- **Три слоя безопасности** (каждый opt-in через env vars; defaults сохраняют v0.1.x для тривиальных вызовов, но харднят всё destructive):
  - **`AVITO_MCP_MODE`** (`read_only` / `guarded` / `full_access`) — фильтр на регистрации. Скрытые tools не появляются в `tools/list`. `read_only` ≈ 82 tools, `guarded` добавляет writes (~125), `full_access` — все 141 Avito + 7 meta (+ opt-in расширения).
  - **`AVITO_MCP_ALLOW_TOOLS` / `AVITO_MCP_DENY_TOOLS`** — per-tool фильтр. Deny всегда побеждает allow.
  - **`AVITO_MCP_CONFIRMATION_MODE`** (`off` / `money_public` (default) / `all_destructive`) — runtime gate. Destructive tools возвращают `{requires_confirmation: true, confirmation_id: ...}`; агент должен вызвать `meta_confirm_action` чтобы выполнить. Pending хранится in-memory, с TTL (default 15 мин), одноразовый.
  - **`AVITO_MCP_EXPOSE_AUTH_TOOLS`** (default: `0`) — `auth_*` tools возвращают OAuth токены; помечены как `sensitive` и скрыты по default даже в `full_access`.
  - **`AVITO_MCP_ALLOWED_UPLOAD_DIRS`** — `messenger_upload_images` читает файлы с диска; без явного списка директорий tool вообще не регистрируется. Валидация пути через `realpath` (защита от symlink escape), allowlist расширений (jpg/jpeg/png/webp), лимит размера (`AVITO_MCP_MAX_UPLOAD_MB`, default 15), magic-byte sniff с cross-check на extension.
- Каждый tool помечен одной из пяти категорий риска (`sensitive` / `read` / `write` / `money` / `public`), отдаётся клиенту как MCP `ToolAnnotations` (`readOnlyHint`, `destructiveHint`) и как `_meta.risk`, плюс перечислен в [`dist/manifest.json`](./dist/manifest.json). Поведенческие MCP-клиенты предупредят перед деструктивным вызовом.
- Готовые конфигурации в [`docs/safety.md`](./docs/safety.md) (analytics-only, customer-support с confirmation, listings-only, full admin) + честный разбор что есть и чего нет в confirmation flow (server-side two-step + audit layer, а НЕ криптографический human-approval).
- **Все 141 Avito tools работают с production** — sandbox у Avito нет. Write-методы тратят деньги или видны клиентам. Безопасные read-only для первого знакомства: `user_get_user_balance`, `items_get_items_info`, `messenger_get_chats_v2`, `meta_get_rate_limits`.
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

### CLI-флаги

```bash
npx avito-mcp --version    # вывести текущую версию
npx avito-mcp --help       # показать env-переменные и usage
```

Других флагов сознательно нет — все настройки через env (см. вывод `--help`).

---

## Troubleshooting

| Проблема | Решение |
|---|---|
| Tool не появился в Claude/Cursor | Полностью перезапустите клиент (через системный трей). Проверьте JSON-синтаксис конфига. |
| `Invalid .env: Client_id is required` | Заполните credentials. Названия чувствительны к регистру: `Client_id`, не `client_id`. |
| 401 при первом запросе | Проверьте credentials в [личном кабинете API](https://www.avito.ru/professionals/api). Удалите OAuth-кэш (см. "Сбросить токен" ниже) и повторите. |
| 403 на конкретном tool | Не все scopes доступны для `client_credentials`-токена. Смотрите описание метода в `swaggers/`. |
| 404 на большинстве `delivery_*` | Это нормально — большая часть `delivery_*` — для партнёров служб доставки, обычный аккаунт получит 403/404. |
| 429 Rate-limited | Сервер сам retry с backoff (1с/2с/4с). `meta_get_rate_limits` покажет лимиты. |
| Где логи | stderr. Claude Desktop: `~/Library/Logs/Claude/mcp-server-avito.log` (macOS). |
| Tool заблокирован — `AVITO_SAFE_MODE=read-only` | Read-only режим включён. Уберите env-переменную или установите её в другое значение (см. секцию "Безопасность" про safe mode). |
| Сбросить токен | Удалите OAuth-кэш по дефолтному пути: Linux — `rm ~/.local/state/avito-mcp/token.json`, macOS — `rm "$HOME/Library/Application Support/avito-mcp/token.json"`, Windows — `del %APPDATA%\avito-mcp\token.json`. Если задан `AVITO_TOKEN_FILE` — удалите файл по этому пути. |

---

## Архитектура (для контрибьюторов)

```
swaggers/<name>.json                ← OpenAPI Avito (источник правды; файлы названы по-английски: messenger.json, items.json …)
        ↓
src/domains/<name>.ts               ← один файл = один swagger, ~10 строк на tool
        ↓
src/meta/domain-registry.ts         ← одна строка регистрации
        ↓
141 Avito + 7 local meta tools (stdio или удалённый HTTP)
```

Сердце — `src/core/tool-factory.ts`: `defineTool(server, ctx, spec)` превращает декларативную spec в работающий MCP tool с HTTP, OAuth-токеном, retry, маппингом ошибок и автоподстановкой `Profile_id`. Никаких `fetch()` внутри handler'ов.

**Добавить новый swagger (4 шага):** см. [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Лицензия

[MIT](./LICENSE). Проект не аффилирован с Avito.ru. «Авито» — товарный знак, принадлежащий его правообладателю. Использование Avito API регулируется [условиями использования Avito](https://www.avito.ru/legal/pro_tools/public-api).
