# Соответствие ревизии MCP 2026-07-28

Этот документ — **исполняемое доказательство**, а не декларация. Каждая строка таблицы связывает
нормативное требование ревизии 2026-07-28 с конкретным документом исследовательского корпуса и с
конкретным тестом, который это требование проверяет.

Проверяется сам документ: `test/conformance/conformance-doc.test.ts` разбирает таблицы ниже и падает,
если хотя бы одна строка со статусом «покрыто» ссылается на несуществующий файл теста или на
название теста, которого в этом файле нет; если строка не «покрыто» и при этом не содержит
обоснования; если сослались на документ, которого в корпусе нет; или если пропущен любой из
шестнадцати пунктов раздела 1.2.A плана. То есть строку нельзя написать «на всякий случай» — она
либо резолвится в репозитории, либо ломает сборку.

- **Критерий**: раздел 1.2 [`MIGRATION_PLAN.md`](../MIGRATION_PLAN.md), блоки A–F.
- **Корпус ревизии**: `docs/mcp-2026-07-28/` (65 документов, untracked — держится вне npm-пакета и
  образа по M0.5; ссылки ниже относительны каталогу `docs/`).
- **Эра по умолчанию**: `AVITO_MCP_PROTOCOL_ERA=legacy`. Требования блока A адресованы
  **modern-соединению** и проверяются на эрах `dual` и `modern`.

## Как прогнать

```bash
npm test                       # весь набор, включая test/conformance/
npx vitest run test/conformance # только conformance-набор
npm run verify                 # lint + три typecheck + покрытие с порогами 74/65/70/75
```

## Легенда статусов

| Статус | Что означает |
| --- | --- |
| покрыто | Есть автоматический тест; он перечислен в строке и существует в репозитории. |
| не покрыто | Требование признано, теста нет. В той же ячейке — почему и куда это отнесено. |
| неприменимо | Требование не адресовано этому серверу либо касается функциональности, сознательно не входящей в объём (раздел 1.3 плана). Причина — в той же ячейке. |

---

## Блок A. Нормативное соответствие ревизии

### A1. `server/discover`

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A1a | `server/discover` реализован и отвечает до любого другого запроса («Servers **MUST** implement it») | [`server-discovery.md`](mcp-2026-07-28/server-discovery.md) | `test/modern-conformance.test.ts` › `answers as the very first request of a connection, before anything else` | покрыто |
| A1b | Результат несёт `resultType: "complete"`, непустой `supportedVersions`, `capabilities`, `instructions`, `ttlMs >= 0`, `cacheScope` | [`server-discovery.md`](mcp-2026-07-28/server-discovery.md) | `test/modern-conformance.test.ts` › `carries resultType, supportedVersions, capabilities, instructions, ttlMs, cacheScope` | покрыто |
| A1c | Идентичность сервера — в `_meta["io.modelcontextprotocol/serverInfo"]`; поля `serverInfo` верхнего уровня нет | [`server-discovery.md`](mcp-2026-07-28/server-discovery.md), [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-conformance.test.ts` › `identifies itself in _meta and NOT in a top-level serverInfo field` | покрыто |
| A1d | Требование безусловно по транспорту: `server/discover` отвечает и на stdio | [`server-discovery.md`](mcp-2026-07-28/server-discovery.md) | `test/modern-conformance.test.ts` › `answers server/discover over stdio too, as the first line of the connection` | покрыто |
| A1e | `instructions` остаются единственным носителем safety-брифинга после удаления `initialize` | [`server-discovery.md`](mcp-2026-07-28/server-discovery.md) | `test/modern-conformance.test.ts` › `is the ONLY carrier left for the safety instructions, and carries them intact` | покрыто |
| A1f | Независимая проверка: официальный клиент v2 с `versionNegotiation: { pin: '2026-07-28' }` завершает connect | [`sdk-typescript-2.md`](mcp-2026-07-28/sdk-typescript-2.md) | `test/conformance/sdk-client.test.ts` › `completes the modern connect sequence against a dual server` | покрыто |

### A2. `resultType` на каждом результате

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A2a | «The `result` **MUST** include a `resultType` field» — на всех результатах modern-эры | [`spec-core.md`](mcp-2026-07-28/spec-core.md) (C4), [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) | `test/modern-conformance.test.ts` › `stamps resultType:"complete" on every modern result` | покрыто |
| A2b | На эре 2025 поля быть не должно (клиент 2025 его не ждёт) | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) | `test/modern-conformance.test.ts` › `does not leak resultType onto the legacy wire`<br>`test/conformance/dual-matrix.test.ts` › `lists tools with the era-appropriate result envelope` | покрыто |

### A3. Кэш-хинты `ttlMs` / `cacheScope`

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A3a | Шесть операций (`server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`) несут `ttlMs` (целое ≥ 0) и `cacheScope` | [`utilities-1.md`](mcp-2026-07-28/utilities-1.md), [`server-discovery.md`](mcp-2026-07-28/server-discovery.md) | `test/caching-hints.test.ts` › `carries an integer ttlMs and a cacheScope on every cacheable result` | покрыто |
| A3b | Ни один account-scoped URI не помечен `"public"` («responses with a `"public"` `cacheScope` may be shared between callers even if the Result is coming from an authenticated endpoint») | [`utilities-1.md`](mcp-2026-07-28/utilities-1.md) (K-24, K-25) | `test/caching-hints.test.ts` › `never hands an account-scoped body a public scope on the wire`<br>`test/caching-hints.test.ts` › `marks no account-scoped URI as public` | покрыто |
| A3c | `cacheScope` одинаков на всех страницах одного списочного запроса | [`utilities-1.md`](mcp-2026-07-28/utilities-1.md) (K-24) | `test/caching-hints.test.ts` › `keeps cacheScope identical across every page of one list request` | покрыто |
| A3d | `ttlMs` — неотрицательное целое | [`utilities-1.md`](mcp-2026-07-28/utilities-1.md) | `test/caching-hints.test.ts` › `uses non-negative safe integers for every ttlMs` | покрыто |
| A3e | Кэш-хинты не протекают на провод 2025 | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) | `test/caching-hints.test.ts` › `never emits cache fields on the 2025 wire` | покрыто |
| A3f | Результаты MRTR-ретраев (с `inputResponses` / `requestState`) не кэшируются | [`utilities-1.md`](mcp-2026-07-28/utilities-1.md), [`patterns.md`](mcp-2026-07-28/patterns.md) | — | неприменимо — MRTR сознательно не внедряется (раздел 1.3 плана: подтверждение остаётся на `confirmation_id` + `meta_confirm_action`), сервер не выдаёт ни одного `resultType: "input_required"`, поэтому кэшируемого MRTR-ретрая не существует; гард на появление `inputRequired` — `test/modern-hardening.test.ts` |

### A4. Per-request `_meta`-конверт

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A4a | Отсутствие `io.modelcontextprotocol/protocolVersion` → `-32602` + HTTP 400 | [`basic.md`](mcp-2026-07-28/basic.md) (п. 54) | `test/modern-conformance.test.ts` › `rejects a missing protocolVersion key with -32602 + HTTP 400` | покрыто |
| A4b | Отсутствие `io.modelcontextprotocol/clientCapabilities` → `-32602` + HTTP 400 | [`basic.md`](mcp-2026-07-28/basic.md) (п. 54) | `test/modern-conformance.test.ts` › `rejects a missing clientCapabilities key with -32602 + HTTP 400` | покрыто |
| A4c | Отсутствие `clientInfo` запрос НЕ отклоняет (демотирован до SHOULD) | [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-conformance.test.ts` › `does NOT reject a missing clientInfo — it was demoted to SHOULD` | покрыто |
| A4d | Capabilities читаются на каждый запрос, а не наследуются от предыдущего | [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-conformance.test.ts` › `reads capabilities per request, never from a previous one` | покрыто |
| A4e | Конверт неверного ТИПА — это `-32602` (невалидные параметры), а не `-32022` | [`basic.md`](mcp-2026-07-28/basic.md) | `test/conformance/errors.test.ts` › `answers -32602, not -32022, when the envelope carries the wrong TYPE` | покрыто |
| A4f | Неизвестные ключи `_meta` игнорируются | [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-conformance.test.ts` › `ignores unknown _meta keys` | покрыто |

### A5. Неизвестная версия протокола

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A5a | Неизвестная версия → `-32022` с `data.supported` и `data.requested` + HTTP 400 | [`basic.md`](mcp-2026-07-28/basic.md), [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/modern-conformance.test.ts` › `answers -32022 with data.supported and data.requested + HTTP 400` | покрыто |
| A5b | Матрица версий: до-MCP-шная дата, будущая дата, соседняя дата, не-дата, `latest` | [`basic.md`](mcp-2026-07-28/basic.md) | `test/conformance/errors.test.ts` › `answers -32022 with data.supported and data.requested for %s` | покрыто |
| A5c | `data.supported` перечисляет только то, что эта нога действительно обслуживает | [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/conformance/errors.test.ts` › `advertises exactly the revisions the modern leg serves, never the legacy one` | покрыто |
| A5d | Handshake 2025 на modern-only эндпоинте → `-32022`, а не 404 | [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/modern-conformance.test.ts` › `answers a 2025 handshake on a modern-only endpoint with -32022, not a 404` | покрыто |
| A5e | На закреплённом modern stdio-соединении версия перепроверяется на каждом сообщении | [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/modern-hardening.test.ts` › `answers -32022 for an unsupported revision on a LATER message` | покрыто |
| A5f | Независимая проверка: клиент v2, закреплённый на неподдерживаемой ревизии, получает типизированный `-32022` | [`sdk-typescript-2.md`](mcp-2026-07-28/sdk-typescript-2.md) | `test/conformance/sdk-client.test.ts` › `is refused with a typed -32022 when it pins a revision we do not serve` | покрыто |

### A6. Стандартные заголовки SEP-2243

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A6a | Отсутствие `MCP-Protocol-Version` → `-32020` + 400 | [`transports.md`](mcp-2026-07-28/transports.md), [`seps-3.md`](mcp-2026-07-28/seps-3.md) | `test/modern-conformance.test.ts` › `rejects a request with no MCP-Protocol-Version header` | покрыто |
| A6b | Отсутствие `Mcp-Method` → `-32020` + 400 | [`transports.md`](mcp-2026-07-28/transports.md) | `test/modern-conformance.test.ts` › `rejects a missing Mcp-Method header` | покрыто |
| A6c | Отсутствие `Mcp-Name` там, где тело несёт `name`/`uri` → `-32020` + 400 | [`transports.md`](mcp-2026-07-28/transports.md) | `test/modern-conformance.test.ts` › `rejects a missing Mcp-Name on tools/call, prompts/get and resources/read` | покрыто |
| A6d | Расхождение значения с телом → `-32020` | [`transports.md`](mcp-2026-07-28/transports.md) | `test/modern-conformance.test.ts` › `rejects a value that disagrees with the body` | покрыто |
| A6e | Регистр ЗНАЧЕНИЯ значим (сверка не lowercase) | [`seps-3.md`](mcp-2026-07-28/seps-3.md) | `test/modern-conformance.test.ts` › `rejects a value whose CASE differs from the body` | покрыто |
| A6f | Регистр ИМЕНИ заголовка не значим (RFC 9110) | [`transports.md`](mcp-2026-07-28/transports.md) | `test/modern-conformance.test.ts` › `treats header NAMES case-insensitively` | покрыто |
| A6g | Опциональные пробелы RFC 9110 срезаются до сверки | [`seps-3.md`](mcp-2026-07-28/seps-3.md) | `test/modern-conformance.test.ts` › `strips RFC 9110 optional whitespace before comparing` | покрыто |
| A6h | Sentinel-форма `=?base64?…?=` декодируется до сверки; сломанный sentinel — расхождение | [`seps-3.md`](mcp-2026-07-28/seps-3.md) | `test/modern-conformance.test.ts` › `decodes the =?base64?…?= sentinel form before comparing` | покрыто |
| A6i | Пустое значение — это ПРИСУТСТВУЮЩЕЕ значение, расходящееся с телом | [`seps-3.md`](mcp-2026-07-28/seps-3.md) | `test/conformance/errors.test.ts` › `answers -32020 for an empty mirrored value rather than treating it as absent` | покрыто |
| A6j | Недопустимые символы в значении (управляющий символ, попытка инъекции через LF) не доходят до зеркала | [`seps-3.md`](mcp-2026-07-28/seps-3.md) | `test/conformance/errors.test.ts` › `refuses a control character in a mirrored value at the transport, serving nothing`<br>`test/conformance/errors.test.ts` › `refuses a bare LF used to smuggle a second header` | покрыто |
| A6k | Не-ASCII значение, похожее на значение тела, — расхождение | [`seps-3.md`](mcp-2026-07-28/seps-3.md) | `test/conformance/errors.test.ts` › `answers -32020 for a non-ASCII value that resembles the body value` | покрыто |
| A6l | На notification-POST требования к заголовкам ревизией не определены — не форсируем | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) | `test/modern-conformance.test.ts` › `does not enforce the headers on a modern notification POST` | покрыто |

### A7. Требуемая, но не объявленная клиентская capability

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A7a | При нехватке capability — `-32021` с `data.requiredCapabilities` + HTTP 400 | [`basic.md`](mcp-2026-07-28/basic.md) (п. 57) | `test/modern-conformance.test.ts` › `answers -32021 + HTTP 400 with data.requiredCapabilities when a handler needs one` | покрыто |
| A7b | «A server **MUST NOT** rely on capabilities the client has not declared»: ни один production-метод capability не требует | [`basic.md`](mcp-2026-07-28/basic.md) (п. 57) | `test/modern-conformance.test.ts` › `serves every production request method without requiring a client capability`<br>`test/modern-hardening.test.ts` › `no primitive on this surface requires a client capability` | покрыто |
| A7c | Решение «ни один примитив не требует capability» зафиксировано явно | [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-hardening.test.ts` › `has an ADR that states the decision` | покрыто |

### A8. Методы, статусы, игнорируемые заголовки

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A8a | Неизвестный RPC-метод → HTTP 404 + `-32601` | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) | `test/modern-conformance.test.ts` › `answers an unknown RPC method with HTTP 404 + -32601` | покрыто |
| A8b | Методы, удалённые ревизией (`initialize`, `ping`, `logging/setLevel`, `resources/subscribe`, `resources/unsubscribe`), — неизвестны | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md), [`utilities-3.md`](mcp-2026-07-28/utilities-3.md) | `test/modern-conformance.test.ts` › `treats the methods this revision deleted as unknown`<br>`test/conformance/errors.test.ts` › `answers %s with HTTP 404 and -32601 on the modern leg` | покрыто |
| A8c | GET и DELETE на `/mcp` → 405 с заголовком `Allow` | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) (J2) | `test/modern-conformance.test.ts` › `answers GET and DELETE with 405 + Allow on a modern-only endpoint` | покрыто |
| A8d | Любой глагол, кроме POST (PUT/PATCH/OPTIONS/HEAD в том числе), → 405 + `Allow: POST` | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) (J2) | `test/conformance/errors.test.ts` › `answers %s with 405 and an Allow header on a modern-only endpoint` | покрыто |
| A8e | На `dual` глаголы маршрутизируются по эре: modern — 405, legacy сохраняет свои сессионные операции | [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/modern-conformance.test.ts` › `under dual, routes GET/DELETE by era: modern gets 405, legacy keeps its session ops` | покрыто |
| A8f | Входящий `Mcp-Session-Id` игнорируется; сервер не выпускает и не отражает session id | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) (J2) | `test/modern-conformance.test.ts` › `ignores an incoming Mcp-Session-Id instead of rejecting it, and mints none`<br>`test/conformance/errors.test.ts` › `ignores the two headers the revision retired, on every method` | покрыто |
| A8g | `Last-Event-ID` игнорируется, потоки не возобновляются | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) (J2) | `test/modern-conformance.test.ts` › `ignores Last-Event-ID instead of rejecting it` | покрыто |
| A8h | Принятая notification → 202 без тела, в том числе для неизвестного метода notification | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) (D6) | `test/conformance/errors.test.ts` › `accepts an unknown NOTIFICATION with 202 rather than answering an error` | покрыто |
| A8i | Тело POST — ровно один request или notification; батч с request'ами отвергается | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) | `test/conformance/errors.test.ts` › `refuses a JSON-RPC batch carrying requests` | покрыто |
| A8j | Битое тело JSON → `-32700`, а не HTML/`bad_request` от express | [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-hardening.test.ts` › `answers -32700, not express.json()"s {"error":"bad_request"}` | покрыто |

### A9. `subscriptions/listen`

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A9a | Первым сообщением идёт `notifications/subscriptions/acknowledged` с фактически поддержанным подмножеством фильтра | [`patterns.md`](mcp-2026-07-28/patterns.md) | `test/modern-runtime.test.ts` › `answers with the acknowledgement FIRST, carrying the honoured subset` | покрыто |
| A9b | Каждое уведомление потока несёт `io.modelcontextprotocol/subscriptionId` в `_meta` | [`patterns.md`](mcp-2026-07-28/patterns.md) | `test/modern-runtime.test.ts` › `stamps the subscription id on every notification the stream carries` | покрыто |
| A9c | Незапрошенные типы уведомлений не отправляются (**MUST NOT**) | [`patterns.md`](mcp-2026-07-28/patterns.md) | `test/modern-runtime.test.ts` › `never delivers a type the stream did not ask for`<br>`test/modern-runtime.test.ts` › `keeps two concurrent subscriptions independent` | покрыто |
| A9d | Подтверждается только то, что сервер действительно может доставить: чужие схемы и неопубликованные URI из фильтра вычёркиваются | [`patterns.md`](mcp-2026-07-28/patterns.md) | `test/modern-hardening.test.ts` › `drops URIs this server never publishes for`<br>`test/modern-hardening.test.ts` › `does not confirm a subscription to a foreign URI scheme`<br>`test/modern-hardening.test.ts` › `narrows on stdio as well as on HTTP` | покрыто |
| A9e | При остановке сервера каждый открытый поток получает `{ resultType: "complete", _meta: { subscriptionId } }` | [`patterns.md`](mcp-2026-07-28/patterns.md) | `test/modern-runtime.test.ts` › `closes every open stream gracefully when the server stops` | покрыто |
| A9f | `notifications/cancelled` от сервера — только для сноса такого потока; на штатном потоке его нет | [`patterns.md`](mcp-2026-07-28/patterns.md), [`spec-transports.md`](mcp-2026-07-28/spec-transports.md) | `test/modern-runtime.test.ts` › `emits no frame carrying both an id and a method, on any stream` | покрыто |
| A9g | Политика доступа выше подписки: скрытый политикой ресурс не становится боковым каналом | [`patterns.md`](mcp-2026-07-28/patterns.md), [`guides-security.md`](mcp-2026-07-28/guides-security.md) | `test/modern-runtime.test.ts` › `does not publish updates for a resource the policy hides` | покрыто |
| A9h | Независимая проверка: официальный клиент v2 получает суженный `honoredFilter` | [`sdk-typescript-2.md`](mcp-2026-07-28/sdk-typescript-2.md) | `test/conformance/sdk-client.test.ts` › `is told the honoured subset of a listen filter, not the one it asked for` | покрыто |

### A10. Request-scoped `notifications/message`

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A10a | «The server **MUST NOT** emit `notifications/message` for a request that does not include this field» | [`utilities-3.md`](mcp-2026-07-28/utilities-3.md) (п. 32) | `test/modern-runtime.test.ts` › `sends nothing for a request that declared no log level` | покрыто |
| A10b | Уведомление доставляется по потоку ответа именно этого запроса | [`utilities-3.md`](mcp-2026-07-28/utilities-3.md) | `test/modern-runtime.test.ts` › `sends it on the response stream of THAT request when a level is declared`<br>`test/modern-runtime.test.ts` › `never puts a log line on a subscriptions/listen stream` | покрыто |
| A10c | Нераспознанный уровень → `-32602` | [`utilities-3.md`](mcp-2026-07-28/utilities-3.md) (п. 35) | `test/modern-runtime.test.ts` › `rejects an unrecognised level with -32602` | покрыто |
| A10d | Восемь уровней RFC 5424 принимаются | [`utilities-3.md`](mcp-2026-07-28/utilities-3.md) | `test/modern-runtime.test.ts` › `accepts every level RFC 5424 defines` | покрыто |
| A10e | Фоновое зеркало pino не подключается к modern-соединению вовсе | [`utilities-3.md`](mcp-2026-07-28/utilities-3.md) | `test/protocol-era.test.ts` › `never registers a MODERN instance as a background log sink` | покрыто |

### A11. Закрытие потока = отмена

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A11a | «Closing the SSE response stream **MUST** be treated by the server as cancellation of that request»: исходящий вызов к Avito прерывается, лиза идемпотентности освобождается | [`spec-transports.md`](mcp-2026-07-28/spec-transports.md), [`utilities-1.md`](mcp-2026-07-28/utilities-1.md) | `test/modern-runtime.test.ts` › `aborts the outgoing Avito call and frees the idempotency lease` | покрыто |
| A11b | Слот rate-limiter возвращается | [`utilities-1.md`](mcp-2026-07-28/utilities-1.md) | `test/modern-runtime.test.ts` › `gives the reserved rate-limiter slot back` | покрыто |
| A11c | Ожидание слота rate-limiter прерывается отменой, а не досиживается до конца | [`utilities-1.md`](mcp-2026-07-28/utilities-1.md) | `test/modern-runtime.test.ts` › `stops waiting for a rate-limit slot once the caller is cancelled` | покрыто |

### A12. Сервер не инициирует запросов

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A12a | «Servers **MUST** send server-to-client requests … using the MRTR pattern» — ни одного сообщения, где одновременно есть `id` и `method` | [`patterns.md`](mcp-2026-07-28/patterns.md) | `test/modern-runtime.test.ts` › `emits no frame carrying both an id and a method, on any stream` | покрыто |
| A12b | Объявленные capabilities честны: `list_changed` не отправляется ниоткуда в `src/` | [`patterns.md`](mcp-2026-07-28/patterns.md), [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-runtime.test.ts` › `keeps the declaration honest: nothing in src/ ever sends a list_changed` | покрыто |

### A13. Политика распределения кодов ошибок

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A13a | Не эмитируются `-32002` и `-32042`; из `-32020…-32099` — только определённые спецификацией | [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-runtime.test.ts` › `emits no forbidden or unallocated code across the whole negative matrix`<br>`test/conformance/errors.test.ts` › `emits no reserved or legacy-sub-range code across the negative matrix` | покрыто |
| A13b | Собственные коды лежат вне `-32768…-32000` | [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-runtime.test.ts` › `allocates no code of its own inside -32768…-32000`<br>`test/conformance/errors.test.ts` › `allocates every code of its own strictly outside the JSON-RPC reserved range` | покрыто |
| A13c | Ни один ответ modern-эры не несёт код из закрытого поддиапазона `-32000…-32019` | [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-hardening.test.ts` › `never answers a modern request with a code in -32000…-32019`<br>`test/modern-hardening.test.ts` › `the modern 405 does not answer -32000` | покрыто |
| A13d | Legacy-нога тоже переведена с `-32000`/`-32001` на код вне закрытого поддиапазона | [`basic.md`](mcp-2026-07-28/basic.md) | `test/modern-hardening.test.ts` › `the legacy leg answers a missing session id with -32602, not -32000`<br>`test/modern-hardening.test.ts` › `the legacy leg answers an unknown session id outside the reserved range` | покрыто |

### A14. `resources/read`

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A14a | Несуществующий ресурс → `-32602` с `data.uri` (**MUST**, R15) | [`server-resources.md`](mcp-2026-07-28/server-resources.md) | `test/modern-runtime.test.ts` › `answers an unknown URI with -32602 and data.uri` | покрыто |
| A14b | Отсутствующий swagger — тот же `-32602`, а не `-32603` | [`server-resources.md`](mcp-2026-07-28/server-resources.md) | `test/modern-runtime.test.ts` › `answers a missing swagger with -32602 and data.uri, not -32603` | покрыто |
| A14c | Попытка обхода каталога отвечается неотличимо от обычного промаха | [`guides-security.md`](mcp-2026-07-28/guides-security.md), [`server-resources.md`](mcp-2026-07-28/server-resources.md) | `test/modern-runtime.test.ts` › `answers a traversal attempt exactly like a plain miss` | покрыто |
| A14d | Ни один read-обработчик не возвращает пустой `contents` | [`server-resources.md`](mcp-2026-07-28/server-resources.md) | `test/modern-runtime.test.ts` › `returns non-empty contents for every resource it lists` | покрыто |
| A14e | Изменение кода касается только modern-эры: провод 2025 отвечает как в 1.3.x | [`server-resources.md`](mcp-2026-07-28/server-resources.md), [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/modern-runtime.test.ts` › `leaves the legacy answer for a missing swagger exactly where 1.3.x had it` | покрыто |

### A15. Схемы инструментов

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A15a | Ни один `$ref` не указывает на сетевой URI; глубина и число подсхем ограничены; диалект задокументирован | [`server-tools.md`](mcp-2026-07-28/server-tools.md) | `test/modern-runtime.test.ts` › `declares exactly the documented dialect, contains no network $ref, and stays bounded` | покрыто |
| A15b | Диалект стабилен на обеих эрах (`schemaHash` считается по схемам как они отдаются) | [`server-tools.md`](mcp-2026-07-28/server-tools.md) | `test/wire-conformance.test.ts` › `renders every inputSchema in the draft-07 dialect`<br>`test/wire-conformance.test.ts` › `renders every outputSchema in the draft-07 dialect` | покрыто |
| A15c | `structuredContent` соответствует объявленному `outputSchema` | [`server-tools.md`](mcp-2026-07-28/server-tools.md) | `test/conformance/dual-matrix.test.ts` › `honours a tool outputSchema with a matching structuredContent` | покрыто |

### A16. Детерминированность поверхности

| ID | Нормативное требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| A16a | «Servers **SHOULD** return tools in a deterministic order» — одинаковый порядок между соединениями | [`server-tools.md`](mcp-2026-07-28/server-tools.md) | `test/modern-runtime.test.ts` › `serves the same order and the same set on every connection` | покрыто |
| A16b | Набор примитивов не варьируется по соединению и по эре | [`server-tools.md`](mcp-2026-07-28/server-tools.md), [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/modern-runtime.test.ts` › `exposes the same tool order on the legacy leg as on the modern one`<br>`test/conformance/dual-matrix.test.ts` › `exposes one tool catalogue, in one order, to both eras` | покрыто |

---

## Блок B. Совместимость с эрой 2025-11-25

| ID | Требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| B1 | Legacy-клиент проходит `initialize` → `tools/list` → `tools/call` → `resources/subscribe` так же, как на 1.3.3 | план §1.2 B, [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/modern-conformance.test.ts` › `serves a byte-identical 2025 handshake at era=legacy and era=dual`<br>`test/modern-runtime.test.ts` › `keeps resources/subscribe working on the legacy leg of the same process` | покрыто |
| B2 | Wire-снапшот 1.3.3 проходит без правок: 144 инструмента, тот же `schema_hash` | план §1.2 B (M1.1) | `test/wire-conformance.test.ts` › `recomputes to the hash 1.3.3 published`<br>`test/wire-conformance.test.ts` › `exposes the full 148-tool surface` | покрыто |
| B3 | Capability-набор и `serverInfo` эры 2025 неизменны | план §1.2 B | `test/wire-conformance.test.ts` › `advertises exactly the 1.3.x capability set`<br>`test/wire-conformance.test.ts` › `keeps serverInfo identical, including title/description/websiteUrl` | покрыто |
| B4 | Клиент, предлагающий 2026-07-28 в `initialize`, получает 2025-11-25 (а не отказ) | [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/wire-conformance.test.ts` › `answers initialize with 2025-11-25 even when a client offers 2026-07-28` | покрыто |
| B5 | Handshake при `era=dual` побайтово равен handshake при `era=legacy` | план §1.2 B | `test/http-dual-era.test.ts` › `produces a byte-identical 2025 handshake to era=legacy` | покрыто |
| B6 | Ни один результат эры 2025 не несёт `ttlMs`/`cacheScope`/`resultType` | план §1.2 B | `test/modern-conformance.test.ts` › `carries no ttlMs, cacheScope or resultType on any 2025 result` | покрыто |
| B7 | Официальный клиент v2 в дефолтном (legacy) режиме работает на том же эндпоинте | [`sdk-typescript-2.md`](mcp-2026-07-28/sdk-typescript-2.md) | `test/conformance/sdk-client.test.ts` › `serves the SAME client in its default legacy mode on the same endpoint` | покрыто |

---

## Блок C. Тестовая достоверность

| ID | Требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| C1 | Существует тестовый шов эры 2026 для HTTP (`Request`→`Response` через реальный `startHttpServer`) | план §6.1, M3.9 | `test/http-dual-era.test.ts` › `answers server/discover on the modern leg` | покрыто |
| C2 | Существует тестовый шов эры 2026 для stdio (порождённый `serveStdio` дочерний процесс) | план §6.1, M3.9 | `test/modern-conformance.test.ts` › `answers server/discover over stdio too, as the first line of the connection` | покрыто |
| C3 | Ключевые интеграционные сюиты прогоняются в ОБЕИХ эрах одной параметризацией | план §1.2 C, M6.1 | `test/conformance/dual-matrix.test.ts` › `lists tools with the era-appropriate result envelope`<br>`test/conformance/dual-matrix.test.ts` › `parks a money tool as a pending action instead of executing it`<br>`test/conformance/dual-matrix.test.ts` › `lists and renders prompts`<br>`test/conformance/dual-matrix.test.ts` › `lists resources and reads one with non-empty contents` | покрыто |
| C4 | Обе ноги обслуживаются ОДНИМ процессом на одном эндпоинте, с общим состоянием | [`versioning.md`](mcp-2026-07-28/versioning.md) | `test/conformance/dual-matrix.test.ts` › `confirms on the legacy leg what the modern leg parked, in one process` | покрыто |
| C5 | Таблица «требование → тест» существует и проверяется машинно | план §1.2 C, M6.2 | `test/conformance/conformance-doc.test.ts` › `finds every referenced test TITLE verbatim in the file it names`<br>`test/conformance/conformance-doc.test.ts` › `covers every one of the sixteen requirements of §1.2.A` | покрыто |
| C6 | Legacy-only-тесты помечены как legacy-only, а не «починены под зелёный» | план M6.1 | `test/modern-runtime.test.ts` › `leaves the legacy answer for a missing swagger exactly where 1.3.x had it` | покрыто |
| C7 | Пороги покрытия не понижены относительно 74/65/70/75; `npm run verify` держит lint, три typecheck и покрытие | план M6.5 | `test/conformance/gates.test.ts` › `keeps every coverage threshold at or above the 1.3.3 floor`<br>`test/conformance/gates.test.ts` › `keeps npm run verify covering lint, all three typechecks and coverage` | покрыто |
| C8 | conformance-набор собирается обычным прогоном (`test/conformance/` не выпадает из `include`) | план M6.2 | `test/conformance/gates.test.ts` › `collects the conformance suites in the default test run` | покрыто |
| C9 | CI прогоняется на стековых PR, а не только на PR в `main` | план M6.4 | `test/release-hardening.test.ts` › `runs CI on every pull request, including a stacked one` | покрыто |

---

## Блок D. Безопасность

| ID | Требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| D1 | Идентичность вызывающего для подтверждений не выводится из протокольной сессии | план §1.2 D, M1.2 | `test/oauth-bearer-http.test.ts` › `accepts a valid token and attributes the pending action to oauth:<client_id>`<br>`test/oauth-bearer-http.test.ts` › `meters the hard-confirmation rate limit per OAuth principal, not per MCP session` | покрыто |
| D2 | Подтверждение, выданное на одной эре, действительно на другой в том же процессе (следствие D1) | план §1.2 D | `test/conformance/dual-matrix.test.ts` › `confirms on the legacy leg what the modern leg parked, in one process` | покрыто |
| D3 | На `/mcp` действует количественный лимит после удаления сессий | план §1.2 D, M3.8 | `test/modern-hardening.test.ts` › `refuses a subscription stream past AVITO_MCP_HTTP_MAX_STREAMS`<br>`test/modern-hardening.test.ts` › `refuses a plain request past AVITO_MCP_HTTP_MAX_INFLIGHT` | покрыто |
| D4 | Невалидный Bearer-токен → 401, никогда 500 | [`spec-authorization.md`](mcp-2026-07-28/spec-authorization.md) | `test/oauth-bearer-http.test.ts` › `answers an unknown Bearer token with 401 and a discoverable challenge, never 500`<br>`test/oauth-bearer-http.test.ts` › `answers an expired but genuinely issued token with 401, not 500` | покрыто |
| D5 | Авторизационные требования ревизии: `iss` по RFC 9207, Authorization Server Binding, `application_type` при DCR, PRM во всех HTTP-режимах | [`spec-authorization.md`](mcp-2026-07-28/spec-authorization.md), [`extensions-auth.md`](mcp-2026-07-28/extensions-auth.md) | — | не покрыто — это объём этапа M5 (задачи M5.1–M5.7), который в этой ветке не выполнялся; до его завершения режим `oauth` не заявляет соответствия авторизационной части ревизии, и это должно быть записано в README при включении dual (M5.5) |
| D6 | Иерархии scope и 403 `insufficient_scope` | [`spec-authorization.md`](mcp-2026-07-28/spec-authorization.md) | — | неприменимо — вынесено в M8.7 отдельным мажорным релизом: текущая проверка требует точного равенства множества scopes, и любое расширение немедленно провалит уже выданные токены установленной базы |

---

## Блок E. Публичный контракт

| ID | Требование | Источник | Тест | Статус |
| --- | --- | --- | --- | --- |
| E1 | Оба README называют все ревизии, которые сервер реально обслуживает | план §1.2 E | `test/conformance/public-contract.test.ts` › `%s names every revision the code advertises` | покрыто |
| E2 | Оба README и `.env.example` документируют все три значения `AVITO_MCP_PROTOCOL_ERA` | план §1.2 E | `test/conformance/public-contract.test.ts` › `%s documents all three era values`<br>`test/conformance/public-contract.test.ts` › `documents the era switch in .env.example with the same three values` | покрыто |
| E3 | Ни один README не обещает ревизию новее той, что реально обслуживается; локали в паритете по ревизиям | план §1.2 E | `test/conformance/public-contract.test.ts` › `claims no revision newer than the one the code actually serves`<br>`test/conformance/public-contract.test.ts` › `keeps the two locales in revision parity` | покрыто |
| E4 | Ни один текст, уходящий модели, не упоминает удалённых методов | план §1.2 E | `test/modern-hardening.test.ts` › `holds for every string the modern era puts in front of the model`<br>`test/modern-hardening.test.ts` › `holds for the instruction brief of each era` | покрыто |
| E5 | README не рекламирует удалённый метод без указания эры | план §1.2 E | `test/conformance/public-contract.test.ts` › `never advertises a removed method as a live capability in either README` | покрыто |
| E6 | Лимиты сессий помечены как legacy-only; лимиты, заменившие их на modern-ноге, задокументированы | план §1.2 E, M3.8 | `test/conformance/public-contract.test.ts` › `marks the session limits as legacy-only wherever they are documented`<br>`test/conformance/public-contract.test.ts` › `documents the quantitative limits that replaced them on the modern leg` | покрыто |
| E7 | `package.json`, `server.json` согласованы между собой (имя, версия, идентификатор пакета) | план §1.2 E | `test/conformance/public-contract.test.ts` › `keeps the package metadata self-consistent` | покрыто |
| E8 | `CHANGELOG.md` описывает поддерживаемые ревизии и обещание совместимости | план §1.2 E | — | не покрыто — запись CHANGELOG готовится релизными задачами M3.11/M4.16, а `scripts/check-release-version.mjs` блокирует релиз, у которого версия не синхронизирована во всех шести машинных местах; писать её сейчас значит либо зафиксировать версию, которую этот этап не выпускает, либо соврать |
| E9 | `server.json` и `glama.json` заявляют поддерживаемые ревизии в метаданных реестров | план §1.2 E, M7.4 | — | не покрыто — поля ревизий в схемах реестров заполняются задачей M7.4 вместе с выпуском версии; сейчас оба файла версионированы и проверяются на согласованность с `package.json` строкой E7 |

---

## Блок F. Эксплуатация

Блок F («`AVITO_MCP_PROTOCOL_ERA=dual` включён в проде, откат одной переменной, критерии отката
измеримы») проверяется не тестами, а эксплуатационными процедурами: задачи M6.8 (способ сбора логов
и команда на каждый количественный критерий отката), M7.7 (включение dual по умолчанию) и M7.8 (три
уровня отката). На момент этого документа этап M7 не выполнялся; действующая процедура отката —
раздел 7.2 плана, уровень 1: `AVITO_MCP_PROTOCOL_ERA=legacy` в `/etc/avito-mcp/avito-mcp.env` плюс
`systemctl restart avito-mcp.service`.

---

## CI (M6.4)

`ci.yml` до этого этапа триггерился на `pull_request: branches: [main]`. Следствие, обнаруженное на
этой миграции: **стековый PR не получает проверок вообще**. Цепочка M2 → M3 → M4 ведётся ветками,
нацеленными друг на друга (`feat/m3-dual-era` → `feat/m2-sdk-v2`), ни одна из них не целит в `main`,
поэтому ни один workflow не сработал ни разу — при этом страница PR показывает не «нет проверок», а
просто отсутствие красного.

Правка: фильтр `branches` у `pull_request` снят, `push` остаётся привязан к `main` (иначе push в
ветку и её PR прогоняли бы матрицу дважды). Гард — `test/release-hardening.test.ts` ›
`runs CI on every pull request, including a stacked one`.

**Важно:** правка вступает в силу только после мержа в `main` — GitHub берёт определение workflow из
базовой ветки PR. Для текущего PR #49 единственная доступная проверка — локальный прогон
(`npm run verify`), и его результат приводится в описании PR.

## Внешняя верификация (M6.7)

Требование M6.7: соответствие не должно доказываться только тестами, написанными той же рукой, что и
реализация. План принимает три варианта; выполнен второй.

| Дата | Клиент | Версия | Режим | Результат |
| --- | --- | --- | --- | --- |
| 2026-08-01 | `@modelcontextprotocol/client` (официальный TypeScript SDK, отдельный пакет от `@modelcontextprotocol/server`) | 2.0.0 | `versionNegotiation: { mode: { pin: '2026-07-28' } }`, транспорт `StreamableHTTPClientTransport` | Пройдено. Клиент сам строит `_meta`-конверт, зеркальные заголовки SEP-2243 и connect-time `server/discover`, затем валидирует каждый результат схемами спецификации. Прошли: connect с закреплением ревизии (A1), `tools/list` (144), `tools/call` со `structuredContent` (A15c), `resources/list` / `resources/read` (A14), `prompts/list` / `prompts/get`, `subscriptions/listen` с суженным `honoredFilter` (A9d/A9h), отказ `-32022` на закреплении неподдерживаемой ревизии (A5f), и тот же клиент в дефолтном legacy-режиме на том же эндпоинте (B7). Проверка исполняемая: `test/conformance/sdk-client.test.ts`. |

Что эта проверка **не** закрывает и почему это записано, а не замолчано:

- Это тот же вендор и то же прочтение того же документа. Полностью независимой была бы проверка
  сторонней реализацией протокола (не SDK MCP) или живым хостом.
- Не проверены ожидания хост-приложений (MCP Inspector, Claude Desktop, Cursor): на момент проверки
  ни один доступный хост не заявляет поддержку 2026-07-28, поэтому «клиент-хост» вариант M6.7
  выполнить нечем.
- Официального conformance-набора ревизии на момент проверки не существует.

**Следующая попытка**: при включении `era=dual` по умолчанию (M7.7) — повторить с MCP Inspector той
версии, которая к тому моменту будет поддерживать 2026-07-28; если такой версии не будет, зафиксировать
этот факт здесь же с новой датой.

---

## Как поддерживать этот документ

1. Новое требование ревизии → новая строка с ID блока, ссылкой на документ корпуса и тестом.
2. Тест переименован или перенесён → `test/conformance/conformance-doc.test.ts` упадёт с точным
   указанием строки; чинится правкой таблицы, а не ослаблением теста.
3. Требование признано непокрытым → статус «не покрыто» с обоснованием длиннее двадцати символов;
   пустой отказ документ не примет.
4. Понижать пороги покрытия ради зелёного прогона запрещено (M6.5): новый транспортный слой
   покрывается тестами, а не порогом.
