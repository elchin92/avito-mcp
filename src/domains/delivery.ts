/**
 * Домен `delivery` — swaggers/Доставка.json (31 endpoints, самый большой).
 *
 * Это B2B-партнёрский API логистики (только для партнёров СД — служб доставки).
 * Большинство методов вы не вызовете на обычном аккаунте.
 *
 * Quirks:
 *   - operationId `checkConfirmationCode` коллидирует с одноимённым в orders.json.
 *     Уникальность через префикс домена.
 *   - Сложные nested body описаны минимально через z.record(z.unknown()) — полные схемы
 *     см. в swaggers/Доставка.json (201 schemas компонент).
 *   - Большая часть путей под /delivery-sandbox/ — это намеренно эндпоинты тестовой среды
 *     для партнёров СД; на боевом аккаунте они возвращают 403/404 для обычных пользователей.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

/** Универсальный helper — passthrough-объект со ссылкой на swagger для нестрого типизированного body. */
const opaque = (refToSwagger: string) =>
  z.record(z.string(), z.unknown()).describe(`См. ${refToSwagger} в swaggers/Доставка.json`);

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── Announcements ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_create_announcement_3pl',
    title: 'Доставка: создать анонс [3PL]',
    risk: 'write',
    description:
      '[3PL] Создаёт анонс о планируемой отгрузке из одной службы доставки (sender) в другую (receiver). ' +
      'Метод реализуется на стороне СД — на обычном аккаунте продавца вернёт 403/404. Используйте, когда нужно ' +
      'предупредить принимающую сторону о готовящейся передаче посылки; в отличие от delivery_create_parcel ' +
      'это анонс отгрузки, а не создание самой посылки.',
    method: 'POST',
    path: '/createAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID').describe('Идентификатор анонса (обязателен).'),
      announcementType: z.string().describe('Тип анонса. Enum: DELIVERY (доставка) | PICKUP (забор).'),
      barcode: z
        .string()
        .describe('Уникальный ШК анонса, печатается на акте приёма-передачи. Пример: 000987654321.'),
      date: opaque('Date').describe('Дата и время создания анонса в формате RFC 3339, UTC.'),
      packages: z.array(opaque('Package')).describe('Список грузомест (минимум одно).'),
      receiver: opaque('Receiver').describe('Принимающая сторона: тип (3PL), название, телефоны, email, узел доставки/СЦ.'),
      sender: opaque('Sender').describe('Отправляющая сторона: тип (3PL), название, телефоны, email, узел доставки/СЦ.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['announcementID', 'announcementType', 'barcode', 'date', 'packages', 'receiver', 'sender'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_cancel_announcement_3pl',
    title: 'Доставка: отмена анонса [3PL]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[3PL] Отменяет ранее созданный анонс отгрузки в СД. Необратимо отменяет анонс, созданный через ' +
      'delivery_create_announcement_3pl. Метод реализуется на стороне СД — на обычном аккаунте продавца вернёт 403/404.',
    method: 'POST',
    path: '/cancelAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID').describe('Идентификатор отменяемого анонса (обязателен).'),
      reason: z.string().optional().describe('Причина отмены (опционально).'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'reason'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_create_parcel',
    title: '⚠️ Доставка: создать посылку [3PL]',
    risk: 'write',
    description:
      '[3PL] Боевое создание посылки на стороне службы доставки (CreateParcelRequest). Метод реализуется ' +
      'партнёром СД — на обычном аккаунте продавца вернёт 403/404. Обязательны orderID, parcelID, items, ' +
      'sender, receiver, payment. В отличие от delivery_create_sandbox_parcel_v2 ([SANDBOX v2]) это продакшен, ' +
      'создание реальной посылки.',
    method: 'POST',
    path: '/createParcel',
    domain: 'delivery',
    input: {
      orderID: z.string().describe('Идентификатор заказа Avito.'),
      parcelID: z.string().describe('Идентификатор посылки на стороне СД.'),
      items: z.array(opaque('CreateParcelItem')).min(1).describe('Состав посылки (товары); минимум один элемент.'),
      sender: opaque('CreateParcelClient').describe('Отправитель: ФИО/название, телефон, адрес/узел отправки.'),
      receiver: opaque('CreateParcelClient').describe('Получатель: ФИО, телефон, адрес или код ПВЗ.'),
      payment: opaque('CreateParcelPayment').describe('Параметры оплаты: способ, сумма, объявленная ценность.'),
      barcodes: z.array(z.string()).optional().describe('Штрихкоды посылки (опционально).'),
      directOrderID: z.string().optional().describe('Прямой идентификатор заказа у СД (опционально).'),
      options: opaque('CreateParcelOptions').optional().describe('Доп. опции посылки (опционально).'),
      package: opaque('CreateParcelPackage').optional().describe('Параметры упаковки: габариты, вес (опционально).'),
    },
    body: {
      contentType: 'application/json',
      fields: [
        'orderID',
        'parcelID',
        'items',
        'sender',
        'receiver',
        'payment',
        'barcodes',
        'directOrderID',
        'options',
        'package',
      ],
    },
  });

  // ────────────────────────────── Sandbox: announcements ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_sandbox_create_announcement',
    title: 'Доставка: создать анонс [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Создаёт анонс о планируемой отгрузке в Avito в тестовой среде; после создания анонс ' +
      'направляется в СД, указанную в receiver. Только для партнёров СД. В отличие от ' +
      'delivery_create_announcement_3pl (боевой /createAnnouncement) это песочница, без последствий.',
    method: 'POST',
    path: '/delivery-sandbox/announcements/create',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID').describe('Идентификатор анонса (обязателен).'),
      announcementType: z.string().describe('Тип анонса. Enum: DELIVERY | PICKUP.'),
      barcode: z.string().describe('Уникальный ШК анонса (печатается на акте приёма-передачи).'),
      date: opaque('Date').describe('Дата и время создания анонса в формате RFC 3339, UTC.'),
      packages: z.array(opaque('Package')).describe('Список грузомест.'),
      receiver: opaque('Receiver').describe('Принимающая СД: тип, название, телефоны, email, узел доставки/СЦ.'),
      sender: opaque('Sender').describe('Отправляющая сторона: тип, название, телефоны, email, узел отправки.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['announcementID', 'announcementType', 'barcode', 'date', 'packages', 'receiver', 'sender'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_sandbox_track_announcement',
    title: 'Доставка: трекинг анонса [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Принимает трек (событие) по анонсу от службы доставки в тестовой среде. Используйте для ' +
      'имитации продвижения анонса (приёмка, доставка, отмена). Только для партнёров СД.',
    method: 'POST',
    path: '/delivery-sandbox/announcements/track',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID').describe('Идентификатор отслеживаемого анонса (обязателен).'),
      date: opaque('Date').describe('Дата события в формате RFC 3339, UTC.'),
      event: z
        .string()
        .describe('Тип события. Enum: ACCEPTANCE_DONE | CANCELLED | DELIVERED | RECEIVED.'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'date', 'event'] },
  });

  // ────────────────────────────── Sandbox: areas & schedule ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_custom_area_schedule',
    title: 'Доставка: график зоны [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Задаёт график работы зоны доставки на конкретный день, отличный от регулярного расписания ' +
      '(например, праздничные/выходные дни). Перезаливка перезаписывает прежнее расписание на эти даты. ' +
      'Только для партнёров СД. Тело — массив расписаний напрямую (без обёртки).',
    method: 'POST',
    path: '/delivery-sandbox/areas/custom-schedule',
    domain: 'delivery',
    input: {
      schedules: z
        .array(opaque('CustomAreaSchedule'))
        .describe('Список уникальных кастомных расписаний по датам (тег зоны, дата, интервалы работы).'),
    },
    // customAreaScheduleRequest = top-level JSON array. Шлём массив напрямую,
    // как соседние array-tools (sorting-center / areas / tags / terminals / zones).
    body: { contentType: 'application/json', transform: (b) => (b.schedules as unknown[]) ?? [] },
  });

  // ────────────────────────────── Sandbox: parcel ops ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_sandbox_cancel_parcel',
    title: 'Доставка: отмена посылки [sandbox]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX] Отменяет тестовую посылку от лица получателя. Метод реализуется на стороне СД — только для ' +
      'партнёров СД. В отличие от delivery_v1_cancel_parcel ([SANDBOX v1] с полем options) это базовый контракт ' +
      'с полем actor.',
    method: 'POST',
    path: '/delivery-sandbox/cancelParcel',
    domain: 'delivery',
    input: {
      parcelID: opaque('ParcelID').describe('Идентификатор отменяемой посылки (обязателен).'),
      actor: z.string().describe('Кто инициирует отмену. Enum: receiver (получатель).'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'actor'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_check_confirmation_code',
    title: 'Доставка: проверка кода [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Проверяет код подтверждения, который покупатель показывает на ПВЗ при выдаче. Возвращает ' +
      'статус проверки (success / иные). Только для партнёров СД; одноимённый эндпоинт есть в домене orders — ' +
      'этот относится к посылкам доставки.',
    method: 'POST',
    path: '/delivery-sandbox/order/checkConfirmationCode',
    domain: 'delivery',
    input: {
      parcelID: z.string().describe('Идентификатор посылки.'),
      confirmCode: z.string().describe('Код подтверждения, предъявленный покупателем на ПВЗ.'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'confirmCode'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_set_order_properties',
    title: 'Доставка: свойства посылки [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Отправляет в Avito параметры доставки посылки (например, итоговую стоимость доставки). При ' +
      'повторной передаче данные перезаписываются — важно слать актуальные значения. Только для партнёров СД.',
    method: 'POST',
    path: '/delivery-sandbox/order/properties',
    domain: 'delivery',
    input: {
      orderId: opaque('OrderID').describe('Идентификатор заказа.'),
      properties: opaque('Properties').describe('Параметры доставки посылки (например, итоговая стоимость доставки).'),
    },
    body: { contentType: 'application/json', fields: ['orderId', 'properties'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_set_order_real_address',
    title: 'Доставка: фактический адрес [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Передаёт в Avito фактический ПВЗ приёма/возврата посылки — нужен для агентских и клиентских ' +
      'возвратов. Только для партнёров СД.',
    method: 'POST',
    path: '/delivery-sandbox/order/realAddress',
    domain: 'delivery',
    input: {
      orderId: opaque('OrderID').describe('Идентификатор заказа.'),
      address: opaque('Address').describe('Фактический ПВЗ/адрес приёма или возврата посылки.'),
    },
    body: { contentType: 'application/json', fields: ['orderId', 'address'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_tracking',
    title: 'Доставка: событие трекинга [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Передаёт в Avito информацию по трекингу посылки (смена статуса доставки) от лица СД. ' +
      'Требует соблюдения политики повторных отправок. Только для партнёров СД. Несмотря на title «событие», ' +
      'метод записывает событие — это запись, а не чтение статуса.',
    method: 'POST',
    path: '/delivery-sandbox/order/tracking',
    domain: 'delivery',
    input: {
      orderId: opaque('OrderID').describe('Идентификатор заказа.'),
      avitoEventType: z
        .string()
        .describe('Код события на стороне Avito. Пример: RECEIVED_AT_TRANSIT_TERMINAL.'),
      avitoStatus: opaque('AvitoStatus').describe(
        'Статус посылки. Enum: CONFIRMED | IN_TRANSIT | ON_DELIVERY | DELIVERED | IN_TRANSIT_RETURN | ' +
          'ON_DELIVERY_RETURN | RETURNED | LOST | DESTROYED.',
      ),
      date: opaque('Date').describe('Дата и время события в формате RFC 3339, UTC.'),
      location: z.string().describe('Населённый пункт события в именительном падеже. Пример: Казань.'),
      providerEventCode: z.string().describe('Код события по версии службы доставки.'),
      comment: z.string().optional().describe('Комментарий к статусу (опционально).'),
      options: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Доп. опции к статусу: штрихкод посылки, возвратные номера (опционально).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'avitoEventType', 'avitoStatus', 'date', 'location', 'providerEventCode', 'comment', 'options'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_prohibit_order_acceptance',
    title: 'Доставка: запрет приёма [sandbox]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX] Запрещает приём посылки от отправителя на стороне СД — посылка не будет принята в работу. ' +
      'Метод реализуется на стороне СД, только для партнёров СД. Используется в сценарии отмены посылки.',
    method: 'POST',
    path: '/delivery-sandbox/prohibitOrderAcceptance',
    domain: 'delivery',
    input: { orderId: opaque('OrderID').describe('Идентификатор заказа, приём которого запрещается.') },
    body: { contentType: 'application/json', fields: ['orderId'] },
  });

  // ────────────────────────────── Sandbox: tariffs/sorting centers ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_get_sorting_center',
    title: 'Доставка: список СЦ [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Возвращает сортировочные центры (ХАБы) для переданных служб доставки. Только для партнёров СД. ' +
      'Коды СД: pochta (Почта России), exmail, bb (Boxberry), pp (PickPoint), dpd и др.',
    method: 'GET',
    path: '/delivery-sandbox/sorting-center',
    domain: 'delivery',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'delivery_add_sorting_center',
    title: 'Доставка: загрузить СЦ [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Создаёт задачу на загрузку своих сортировочных центров (ХАБов) с первичной валидацией; ' +
      'возвращает taskID — статус проверяйте через delivery_get_task. После загрузки СЦ нужно проставить теги ' +
      'отдельным запросом (delivery_add_tags_to_sorting_center). Только для партнёров СД. Тело — массив СЦ напрямую.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/sorting-center',
    domain: 'delivery',
    input: {
      centers: z
        .array(opaque('SortingCenterPost'))
        .min(1)
        .describe('Массив СЦ: deliveryProviderId, name, address, phones, itinerary, photos, directionTag, schedule, restriction.'),
    },
    body: { contentType: 'application/json', transform: (b) => (b.centers as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_areas_sandbox',
    title: 'Доставка: загрузить области [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Загружает области, где доступны курьерская доставка/забор, для указанного тарифа. ' +
      'Классификатор адресов — индексы Почты России (1 индекс = все относящиеся к нему адреса). Только для ' +
      'партнёров СД. Тело — массив областей напрямую.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/areas',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('Идентификатор тарифа (в пути).'),
      areas: z
        .array(opaque('Area'))
        .min(1)
        .describe('Массив областей: directionTag, providerAreaNumber, services (intake/delivery), utcTimezone, zipCodes, restrictions.'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.areas as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_tags_to_sorting_center',
    title: 'Доставка: теги СЦ [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Создаёт задачу на установку тегов направлений своим и/или чужим сортировочным центрам в рамках ' +
      'тарифа; возвращает taskID — статус через delivery_get_task. В рамках одного тарифа одному СЦ соответствует ' +
      'ровно один тег, перепривязка невозможна. Только для партнёров СД. Тело — массив напрямую.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/tagged-sorting-centers',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('Идентификатор тарифа (в пути).'),
      tagged: z
        .array(opaque('TaggedSortingCenter'))
        .min(1)
        .describe('Массив привязок: deliveryProviderId (ID СЦ у провайдера) + directionTag (тег направления).'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.tagged as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_terminals_sandbox',
    title: 'Доставка: загрузить ПВЗ [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Загружает терминалы (ПВЗ/постаматы) для тарифа. Система автоматически апрувит изменения: при ' +
      'большом проценте критичных изменений загрузка отправляется на ручную проверку. Только для партнёров СД. ' +
      'Тело — массив терминалов напрямую.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/terminals',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('Идентификатор тарифа (в пути).'),
      terminals: z
        .array(opaque('Terminal'))
        .min(1)
        .describe('Массив ПВЗ: deliveryProviderId, name, address, phones, services (intake/delivery), schedule, type (PVZ|POSTAMAT, по умолчанию PVZ).'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.terminals as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_update_terms',
    title: 'Доставка: зоны сроков [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Создаёт задачу на обновление зон сроков доставки в тарифе; возвращает taskID — статус через ' +
      'delivery_get_task. Важно: список новых сроков должен полностью соответствовать deliveryProviderZoneId ' +
      'тарифа. Только для партнёров СД. Тело — массив зон напрямую.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/terms',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('Идентификатор тарифа (в пути).'),
      zones: z
        .array(opaque('TermsZone'))
        .min(1)
        .describe('Массив зон сроков: deliveryProviderZoneId, name, minTerm/maxTerm (рабочие дни).'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.zones as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_tariff_sandbox_v2',
    title: 'Доставка: загрузить тариф [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX v2] Загружает новый тариф: позволяет СД управлять доступностью направлений, стоимостью и сроками ' +
      'доставки. Лимиты: тело до 400MB, до 1 млн направлений. Только для партнёров СД.',
    method: 'POST',
    path: '/delivery-sandbox/tariffsV2',
    domain: 'delivery',
    input: {
      name: z.string().describe('Человекопонятное название тарифа (для интерфейса).'),
      deliveryProviderTariffId: z.string().describe('Идентификатор тарифа на стороне службы доставки.'),
      directions: z
        .array(opaque('Direction'))
        .describe('Направления: связь directionTagFrom→directionTagTo, тарифная зона, minTerm/maxTerm (рабочие дни).'),
      tariffZones: z
        .array(opaque('TariffZone'))
        .describe('Тарифные зоны: name, deliveryProviderTariffZoneId, items (модели расчёта цены по услугам).'),
      termsZones: z
        .array(opaque('TermsZone'))
        .describe('Зоны сроков: deliveryProviderZoneId, name, minTerm/maxTerm (рабочие дни).'),
      tariffType: z.string().optional().describe('Тип тарифа (опционально).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['name', 'deliveryProviderTariffId', 'directions', 'tariffZones', 'termsZones', 'tariffType'],
    },
  });

  // ────────────────────────────── Sandbox: tasks ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_get_task',
    title: 'Доставка: статус задачи [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Возвращает статус асинхронной задачи по taskID, полученному от загрузочных операций ' +
      '(СЦ, теги, области, сроки, тариф). Статусы: processing | success | <ошибка>. Выполнение обычно занимает ' +
      '5–20 минут. Только для партнёров СД.',
    method: 'GET',
    path: '/delivery-sandbox/tasks/{task_id}',
    domain: 'delivery',
    input: {
      task_id: z.string().describe('Идентификатор задачи (taskID из ответа async-операции, в пути).'),
    },
    pathParams: ['task_id'],
  });

  // ────────────────────────────── Sandbox: v1 announcements/parcels ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_v1_cancel_announcement',
    title: 'Доставка: отмена анонса [sandbox v1]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX v1] Запускает процесс отмены тестового анонса; при успехе ответ со статусом success. Доступен ' +
      'только в Песочнице, для партнёров СД. В отличие от delivery_cancel_announcement_3pl (боевой /cancelAnnouncement) ' +
      'это тестовый v1-контракт с обязательным полем options.',
    method: 'POST',
    path: '/delivery-sandbox/v1/cancelAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: z.string().describe('Идентификатор отменяемого тестового анонса.'),
      date: z.string().describe('Дата и время события в формате ISO 8601 (RFC 3339).'),
      options: opaque('Options').describe('Дополнительные опции отмены анонса.'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'date', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_cancel_parcel',
    title: 'Доставка: отмена посылки [sandbox v1]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX v1] Отменяет тестовую посылку: инициирует запрет приёма в СД и, если он состоялся, отменяет посылку. ' +
      'Отменить можно только посылки, созданные через delivery_create_sandbox_parcel_v2. Доступен только в Песочнице. ' +
      'В отличие от delivery_sandbox_cancel_parcel (поле actor) это v1-контракт с полем options.',
    method: 'POST',
    path: '/delivery-sandbox/v1/cancelParcel',
    domain: 'delivery',
    input: {
      parcelID: z.string().describe('Идентификатор отменяемой тестовой посылки.'),
      options: opaque('Options').optional().describe('Дополнительные опции отмены (опционально).'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_change_parcel',
    title: 'Доставка: изменить посылку [sandbox v1]',
    risk: 'write',
    description:
      '[SANDBOX v1] Создаёт заявку на изменение данных одной тестовой посылки (например, ФИО/телефон получателя). ' +
      'Доступен только в Песочнице. Статус заявки — через delivery_v1_get_change_parcel_info. В отличие от ' +
      'delivery_change_parcels (массовая обработка) меняет одну посылку.',
    method: 'POST',
    path: '/delivery-sandbox/v1/changeParcel',
    domain: 'delivery',
    input: {
      parcelID: z.string().describe('Идентификатор изменяемой тестовой посылки.'),
      type: z
        .string()
        .describe('Тип заявки. Enum: changeReceiver | prohibitParcelReceive | extendParcelStorage | prohibitParcelAcceptance.'),
      application: opaque('Application').optional().describe('Данные заявки на изменение (зависят от type, опционально).'),
      options: opaque('Options').optional().describe('Дополнительные опции заявки (опционально).'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'type', 'application', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_create_announcement',
    title: 'Доставка: создать анонс [sandbox v1]',
    risk: 'write',
    description:
      '[SANDBOX v1] Запускает процесс создания тестового анонса; при успехе ответ со статусом success. Доступен ' +
      'только в Песочнице, для партнёров СД. В отличие от delivery_sandbox_create_announcement это v1-контракт ' +
      'с обязательным полем options.',
    method: 'POST',
    path: '/delivery-sandbox/v1/createAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: z.string().describe('Идентификатор создаваемого анонса.'),
      announcementType: z.string().describe('Тип анонса. Enum: DELIVERY | PICKUP.'),
      barcode: z.string().describe('Уникальный ШК анонса (печатается на акте приёма-передачи).'),
      date: z.string().describe('Дата и время создания анонса в формате ISO 8601 (RFC 3339), UTC.'),
      options: opaque('Options').describe('Дополнительные опции анонса.'),
      packages: z.array(opaque('Package')).describe('Список грузомест.'),
      receiver: opaque('Receiver').describe('Принимающая СД: тип, название, телефоны, email, узел доставки/СЦ.'),
      sender: opaque('Sender').describe('Отправляющая сторона: тип, название, телефоны, email, узел отправки.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['announcementID', 'announcementType', 'barcode', 'date', 'options', 'packages', 'receiver', 'sender'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_announcement_event',
    title: 'Доставка: событие анонса [sandbox v1]',
    risk: 'read',
    description:
      '[SANDBOX v1] Возвращает последнее зарегистрированное событие по тестовому анонсу — облегчает отладку ' +
      'интеграции трекинга анонсов. Доступен только в Песочнице, для партнёров СД.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getAnnouncementEvent',
    domain: 'delivery',
    input: { announcementID: z.string().describe('Идентификатор тестового анонса.') },
    body: { contentType: 'application/json', fields: ['announcementID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_change_parcel_info',
    title: 'Доставка: инфо изменения [sandbox v1]',
    risk: 'read',
    description:
      '[SANDBOX v1] Возвращает информацию о заявке на изменение тестовой посылки по её applicationID (заявка ' +
      'создаётся через delivery_v1_change_parcel). Доступен только в Песочнице, для партнёров СД.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getChangeParcelInfo',
    domain: 'delivery',
    input: { applicationID: z.string().describe('Идентификатор заявки на изменение посылки.') },
    body: { contentType: 'application/json', fields: ['applicationID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_parcel_info',
    title: 'Доставка: инфо посылки [sandbox v1]',
    risk: 'read',
    description:
      '[SANDBOX v1] Возвращает информацию о тестовой посылке по parcelID. Доступен только в Песочнице; работает ' +
      'лишь с посылками, созданными через delivery_create_sandbox_parcel_v2.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getParcelInfo',
    domain: 'delivery',
    input: { parcelID: z.string().describe('Идентификатор тестовой посылки.') },
    body: { contentType: 'application/json', fields: ['parcelID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_registered_parcel_id',
    title: 'Доставка: ID посылки по orderID [sandbox v1]',
    risk: 'read',
    description:
      '[SANDBOX v1] Возвращает parcelID зарегистрированной тестовой посылки по её orderID. Работает только с ' +
      'посылками, созданными через delivery_create_sandbox_parcel_v2. Доступен только в Песочнице.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getRegisteredParcelID',
    domain: 'delivery',
    input: { orderID: z.string().describe('Идентификатор заказа тестовой посылки.') },
    body: { contentType: 'application/json', fields: ['orderID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_create_sandbox_parcel_v2',
    title: 'Доставка: создать посылку [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX v2] Запускает процесс создания тестовой посылки в Песочнице. Созданную посылку затем используют ' +
      'другие v1-методы (getParcelInfo, getRegisteredParcelID, changeParcel, cancelParcel). В отличие от ' +
      'delivery_create_parcel ([3PL], боевое создание) это тестовая среда без последствий.',
    method: 'POST',
    path: '/delivery-sandbox/v2/createParcel',
    domain: 'delivery',
    input: {
      items: z.array(opaque('Item')).optional().describe('Состав посылки — товары (опционально).'),
      options: opaque('Options').optional().describe('Доп. опции тестовой посылки (опционально).'),
      receiver: opaque('Receiver').optional().describe('Получатель: ФИО, телефон, адрес/код ПВЗ (опционально).'),
      sender: opaque('Sender').optional().describe('Отправитель: данные и узел отправки (опционально).'),
      tags: z.array(z.string()).optional().describe('Теги тестовой посылки для сценариев Песочницы (опционально).'),
    },
    body: { contentType: 'application/json', fields: ['items', 'options', 'receiver', 'sender', 'tags'] },
  });

  // ────────────────────────────── Прод (не sandbox) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_change_parcel_result',
    title: 'Доставка: результат изменения посылки',
    risk: 'write',
    description:
      '[3PL] Передаёт в Avito результат исполнения заявки на изменение посылки, ранее присланной через ' +
      'delivery_change_parcels: служба доставки сообщает, одобрена (approved) или отклонена (declined) заявка. ' +
      'Боевой метод на стороне СД — на обычном аккаунте продавца вернёт 403/404.',
    method: 'POST',
    path: '/delivery/order/changeParcelResult',
    domain: 'delivery',
    input: {
      id: z.string().describe('Идентификатор заявки на изменение посылки.'),
      status: z.string().describe('Статус обработки заявки. Enum: approved | declined.'),
      reason: z.string().optional().describe('Причина отклонения; заполняется при status=declined (опционально).'),
      options: opaque('Options').optional().describe('Дополнительные опции результата (опционально).'),
    },
    body: { contentType: 'application/json', fields: ['id', 'status', 'reason', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_change_parcels',
    title: 'Доставка: массовое обновление [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Передаёт службе доставки пакет заявок на обновление свойств посылок по инициативе Avito ' +
      '(массовая операция). Результат по каждой заявке СД возвращает через delivery_change_parcel_result. ' +
      'Метод реализуется на стороне СД, только для партнёров СД.',
    method: 'POST',
    path: '/sandbox/changeParcels',
    domain: 'delivery',
    input: {
      applications: z.array(opaque('Application')).describe('Массив заявок на изменение посылок (по одной на посылку).'),
      type: z
        .string()
        .describe('Тип заявок. Enum: changeReceiver | extendParcelStorage | prohibitParcelReceive | prohibitParcelAcceptance | changeReceiverTerminalOnConfirmed.'),
    },
    body: { contentType: 'application/json', fields: ['applications', 'type'] },
  });
};
