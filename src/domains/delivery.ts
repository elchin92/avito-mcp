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
    description: 'Создание анонса посылки в СД (для партнёров служб доставки).',
    method: 'POST',
    path: '/createAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID'),
      announcementType: z.string().describe('Тип анонса.'),
      barcode: z.string().describe('Штрихкод посылки.'),
      date: opaque('Date'),
      packages: z.array(opaque('Package')).describe('Массив пакетов.'),
      receiver: opaque('Receiver'),
      sender: opaque('Sender'),
    },
    body: {
      contentType: 'application/json',
      fields: ['announcementID', 'announcementType', 'barcode', 'date', 'packages', 'receiver', 'sender'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_cancel_announcement_3pl',
    description: 'Отмена анонса посылки в СД.',
    method: 'POST',
    path: '/cancelAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID'),
      reason: z.string().optional().describe('Причина отмены.'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'reason'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_create_parcel',
    description: 'Создание посылки в боевой системе доставки. barcodes — штрихкоды.',
    method: 'POST',
    path: '/createParcel',
    domain: 'delivery',
    input: {
      barcodes: z.array(z.string()).min(1).describe('Штрихкоды посылки.'),
    },
    body: { contentType: 'application/json', fields: ['barcodes'] },
  });

  // ────────────────────────────── Sandbox: announcements ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_sandbox_create_announcement',
    description: '[SANDBOX] Создание анонса в тестовой среде Avito.',
    method: 'POST',
    path: '/delivery-sandbox/announcements/create',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID'),
      announcementType: z.string(),
      barcode: z.string(),
      date: opaque('Date'),
      packages: z.array(opaque('Package')),
      receiver: opaque('Receiver'),
      sender: opaque('Sender'),
    },
    body: {
      contentType: 'application/json',
      fields: ['announcementID', 'announcementType', 'barcode', 'date', 'packages', 'receiver', 'sender'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_sandbox_track_announcement',
    description: '[SANDBOX] Трекинг события анонса.',
    method: 'POST',
    path: '/delivery-sandbox/announcements/track',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID'),
      date: opaque('Date'),
      event: z.string().describe('Тип события (см. swagger).'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'date', 'event'] },
  });

  // ────────────────────────────── Sandbox: areas & schedule ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_custom_area_schedule',
    description:
      '[SANDBOX] Установка графика работы зоны доставки на определённый день. ' +
      'Перезаливка перезаписывает старое расписание.',
    method: 'POST',
    path: '/delivery-sandbox/areas/custom-schedule',
    domain: 'delivery',
    input: {
      schedules: z
        .array(opaque('CustomAreaSchedule'))
        .describe('Список уникальных кастомных расписаний.'),
    },
    body: { contentType: 'application/json', fields: ['schedules'] },
  });

  // ────────────────────────────── Sandbox: parcel ops ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_sandbox_cancel_parcel',
    description: '[SANDBOX] Отмена тестовой посылки. actor: sender/receiver.',
    method: 'POST',
    path: '/delivery-sandbox/cancelParcel',
    domain: 'delivery',
    input: {
      parcelID: opaque('ParcelID'),
      actor: z.string().describe('Кто отменяет (sender/receiver).'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'actor'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_check_confirmation_code',
    description: '[SANDBOX] Проверка кода подтверждения посылки.',
    method: 'POST',
    path: '/delivery-sandbox/order/checkConfirmationCode',
    domain: 'delivery',
    input: {
      parcelID: z.string().describe('ID посылки.'),
      confirmCode: z.string().describe('Код подтверждения.'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'confirmCode'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_set_order_properties',
    description: '[SANDBOX] Изменение параметров доставки (свойств) посылки.',
    method: 'POST',
    path: '/delivery-sandbox/order/properties',
    domain: 'delivery',
    input: {
      orderId: opaque('OrderID'),
      properties: opaque('Properties'),
    },
    body: { contentType: 'application/json', fields: ['orderId', 'properties'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_set_order_real_address',
    description: '[SANDBOX] Установка фактического адреса приёма/возврата посылки.',
    method: 'POST',
    path: '/delivery-sandbox/order/realAddress',
    domain: 'delivery',
    input: {
      orderId: opaque('OrderID'),
      address: opaque('Address'),
    },
    body: { contentType: 'application/json', fields: ['orderId', 'address'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_tracking',
    description: '[SANDBOX] Отправка события трекинга в систему Avito.',
    method: 'POST',
    path: '/delivery-sandbox/order/tracking',
    domain: 'delivery',
    input: {
      orderId: opaque('OrderID'),
      avitoEventType: z.string().describe('Тип события (см. swagger).'),
      avitoStatus: opaque('AvitoStatus'),
      date: opaque('Date'),
      location: z.string().describe('Локация события.'),
      providerEventCode: z.string().describe('Код события у провайдера.'),
      comment: z.string().optional().describe('Комментарий.'),
      options: z.record(z.string(), z.unknown()).optional().describe('Опции.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'avitoEventType', 'avitoStatus', 'date', 'location', 'providerEventCode', 'comment', 'options'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_prohibit_order_acceptance',
    description: '[SANDBOX] Запрет приёма посылки от отправителя.',
    method: 'POST',
    path: '/delivery-sandbox/prohibitOrderAcceptance',
    domain: 'delivery',
    input: { orderId: opaque('OrderID') },
    body: { contentType: 'application/json', fields: ['orderId'] },
  });

  // ────────────────────────────── Sandbox: tariffs/sorting centers ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_get_sorting_center',
    description: '[SANDBOX] Список сортировочных центров.',
    method: 'GET',
    path: '/delivery-sandbox/sorting-center',
    domain: 'delivery',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'delivery_add_sorting_center',
    description: '[SANDBOX] Загрузка сортировочных центров.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/sorting-center',
    domain: 'delivery',
    input: {
      centers: z.array(opaque('SortingCenterPost')).min(1).describe('Массив центров.'),
    },
    body: { contentType: 'application/json', transform: (b) => (b.centers as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_areas_sandbox',
    description: '[SANDBOX] Загрузка областей доставки для тарифа.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/areas',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('ID тарифа.'),
      areas: z.array(opaque('Area')).min(1).describe('Массив областей.'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.areas as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_tags_to_sorting_center',
    description: '[SANDBOX] Установка тегов сортировочным центрам (своим/чужим).',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/tagged-sorting-centers',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('ID тарифа.'),
      tagged: z.array(opaque('TaggedSortingCenter')).min(1).describe('Массив тегированных центров.'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.tagged as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_terminals_sandbox',
    description: '[SANDBOX] Загрузка терминалов (ПВЗ) для тарифа.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/terminals',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('ID тарифа.'),
      terminals: z.array(opaque('Terminal')).min(1).describe('Массив терминалов.'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.terminals as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_update_terms',
    description: '[SANDBOX] Обновление зон сроков по тарифу.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/terms',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('ID тарифа.'),
      zones: z.array(opaque('TermsZone')).min(1).describe('Массив зон сроков.'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.zones as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_tariff_sandbox_v2',
    description: '[SANDBOX] Загрузка нового тарифа (v2).',
    method: 'POST',
    path: '/delivery-sandbox/tariffsV2',
    domain: 'delivery',
    input: {
      name: z.string().describe('Название тарифа.'),
      deliveryProviderTariffId: z.string().describe('ID тарифа у провайдера.'),
      directions: z.array(opaque('Direction')).describe('Направления.'),
      tariffZones: z.array(opaque('TariffZone')).describe('Зоны тарифа.'),
      termsZones: z.array(opaque('TermsZone')).describe('Зоны сроков.'),
      tariffType: z.string().optional().describe('Тип тарифа.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['name', 'deliveryProviderTariffId', 'directions', 'tariffZones', 'termsZones', 'tariffType'],
    },
  });

  // ────────────────────────────── Sandbox: tasks ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_get_task',
    description: '[SANDBOX] Информация по задаче (taskID из ответа async-операций).',
    method: 'GET',
    path: '/delivery-sandbox/tasks/{task_id}',
    domain: 'delivery',
    input: {
      task_id: z.string().describe('ID задачи.'),
    },
    pathParams: ['task_id'],
  });

  // ────────────────────────────── Sandbox: v1 announcements/parcels ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_v1_cancel_announcement',
    description: '[SANDBOX v1] Отправка события об отмене тестового анонса.',
    method: 'POST',
    path: '/delivery-sandbox/v1/cancelAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: z.string(),
      date: z.string().describe('Дата (ISO 8601).'),
      options: opaque('Options'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'date', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_cancel_parcel',
    description: '[SANDBOX v1] Отмена тестовой посылки.',
    method: 'POST',
    path: '/delivery-sandbox/v1/cancelParcel',
    domain: 'delivery',
    input: {
      parcelID: z.string(),
      options: opaque('Options').optional(),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_change_parcel',
    description: '[SANDBOX v1] Создание заявки на изменение данных тестовой посылки.',
    method: 'POST',
    path: '/delivery-sandbox/v1/changeParcel',
    domain: 'delivery',
    input: {
      parcelID: z.string(),
      type: z.string().describe('Тип изменения.'),
      application: opaque('Application').optional(),
      options: opaque('Options').optional(),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'type', 'application', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_create_announcement',
    description: '[SANDBOX v1] Создание тестового анонса.',
    method: 'POST',
    path: '/delivery-sandbox/v1/createAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: z.string(),
      announcementType: z.string(),
      barcode: z.string(),
      date: z.string().describe('ISO 8601.'),
      options: opaque('Options'),
      packages: z.array(opaque('Package')),
      receiver: opaque('Receiver'),
      sender: opaque('Sender'),
    },
    body: {
      contentType: 'application/json',
      fields: ['announcementID', 'announcementType', 'barcode', 'date', 'options', 'packages', 'receiver', 'sender'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_announcement_event',
    description: '[SANDBOX v1] Последнее событие тестового анонса по ID.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getAnnouncementEvent',
    domain: 'delivery',
    input: { announcementID: z.string() },
    body: { contentType: 'application/json', fields: ['announcementID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_change_parcel_info',
    description: '[SANDBOX v1] Информация об изменении тестовой посылки по ID заявки.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getChangeParcelInfo',
    domain: 'delivery',
    input: { applicationID: z.string() },
    body: { contentType: 'application/json', fields: ['applicationID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_parcel_info',
    description: '[SANDBOX v1] Информация о тестовой посылке по ID.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getParcelInfo',
    domain: 'delivery',
    input: { parcelID: z.string() },
    body: { contentType: 'application/json', fields: ['parcelID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_registered_parcel_id',
    description: '[SANDBOX v1] ID зарегистрированной тестовой посылки по orderID.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getRegisteredParcelID',
    domain: 'delivery',
    input: { orderID: z.string() },
    body: { contentType: 'application/json', fields: ['orderID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_create_sandbox_parcel_v2',
    description: '[SANDBOX v2] Создание тестовой посылки.',
    method: 'POST',
    path: '/delivery-sandbox/v2/createParcel',
    domain: 'delivery',
    input: {
      items: z.array(opaque('Item')).optional(),
      options: opaque('Options').optional(),
      receiver: opaque('Receiver').optional(),
      sender: opaque('Sender').optional(),
      tags: z.array(z.string()).optional(),
    },
    body: { contentType: 'application/json', fields: ['items', 'options', 'receiver', 'sender', 'tags'] },
  });

  // ────────────────────────────── Прод (не sandbox) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_change_parcel_result',
    description: 'Отправка результата исполнения заявки на изменение посылки.',
    method: 'POST',
    path: '/delivery/order/changeParcelResult',
    domain: 'delivery',
    input: {
      id: z.string().describe('ID заявки.'),
      status: z.string().describe('Статус результата.'),
      reason: z.string().optional().describe('Причина.'),
      options: opaque('Options').optional(),
    },
    body: { contentType: 'application/json', fields: ['id', 'status', 'reason', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_change_parcels',
    description: '[SANDBOX] Массовое обновление свойств посылок.',
    method: 'POST',
    path: '/sandbox/changeParcels',
    domain: 'delivery',
    input: {
      applications: z.array(opaque('Application')).describe('Массив заявок.'),
      type: z.string().describe('Тип изменения.'),
    },
    body: { contentType: 'application/json', fields: ['applications', 'type'] },
  });
};
