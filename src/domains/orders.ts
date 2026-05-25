/**
 * Домен `orders` — соответствует swaggers/Управление заказами.json
 *
 * 12 endpoints: получение заказов, переходы статусов, доставка курьером/Почтой/самовывоз, этикетки.
 *
 * Quirks:
 *   - operationId `checkConfirmationCode` коллидирует с одноимённым в delivery.json.
 *     Уникальность обеспечена префиксом домена (orders_check_confirmation_code).
 *   - downloadLabel возвращает PDF (binary); для simplicity отдаём raw как text content
 *     (LLM получит сырые байты как строку — обычно бесполезно, но операция выполнится).
 *     Использовать через прямой curl с токеном, если нужен файл.
 *   - Большинство dates — Unix timestamp в секундах (integer), не ISO.
 *
 * ⚠️ Write-методы:
 *   - applyTransition меняет статус заказа
 *   - acceptReturnOrder выбирает отделение для возврата
 *   - markings передаёт честный знак
 *   - setOrderTrackingNumber устанавливает трек-номер
 *   - setCourierDeliveryRange, cncSetDetails — детали доставки
 *   - generateLabels(Extended) — формирует этикетки (платно?)
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── READ ──────────────────────────────

  defineTool(server, ctx, {
    name: 'orders_get_orders',
    description:
      'Список заказов с фильтрами. ids/statuses — массивы строк. dateFrom — Unix timestamp (сек). ' +
      'Пагинация: page+limit.',
    method: 'GET',
    path: '/order-management/1/orders',
    domain: 'order-management',
    input: {
      ids: z.array(z.string()).optional().describe('Список ID заказов.'),
      statuses: z
        .array(z.string())
        .optional()
        .describe('Список статусов: new, confirmed, ready_to_ship, shipped, и т.д.'),
      dateFrom: z.number().int().optional().describe('Unix timestamp (сек), фильтр "не раньше".'),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    queryParams: ['ids', 'statuses', 'dateFrom', 'page', 'limit'],
  });

  defineTool(server, ctx, {
    name: 'orders_get_courier_delivery_range',
    description: 'Доступные временные промежутки приезда курьера для заказа.',
    method: 'GET',
    path: '/order-management/1/order/getCourierDeliveryRange',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа.'),
      address: z.string().describe('Адрес доставки.'),
    },
    queryParams: ['orderId', 'address'],
  });

  defineTool(server, ctx, {
    name: 'orders_download_label',
    description:
      'Скачать сгенерированный PDF-файл этикетки по taskID (из generateLabels/Extended). ' +
      'Возвращает raw-bytes как text — для бинарного PDF используйте прямой curl с токеном.',
    method: 'GET',
    path: '/order-management/1/orders/labels/{taskID}/download',
    domain: 'order-management',
    input: {
      taskID: z.string().describe('ID задачи генерации этикетки.'),
    },
    pathParams: ['taskID'],
  });

  // ────────────────────────────── WRITE ──────────────────────────────

  defineTool(server, ctx, {
    name: 'orders_markings',
    description:
      '⚠️ ПЕРЕДАЁТ "честный знак" (DataMatrix) для маркировки товара в заказе.',
    method: 'POST',
    path: '/order-management/1/markings',
    domain: 'order-management',
    input: {
      markings: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe('Массив записей маркировки. См. swagger Управление заказами.json.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['markings'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_accept_return_order',
    description:
      '⚠️ Выбирает отделение Почты России для получения возврата товара.',
    method: 'POST',
    path: '/order-management/1/order/acceptReturnOrder',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа.'),
      terminalNumber: z.string().describe('Номер отделения Почты России.'),
      recipient: z.record(z.string(), z.unknown()).optional().describe('Данные получателя.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'terminalNumber', 'recipient'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_apply_transition',
    description:
      '⚠️ ИЗМЕНЯЕТ СТАТУС заказа через transition (например "confirm", "ship", "cancel"). ' +
      'Состав transitions зависит от текущего статуса — см. swagger Управление заказами.json.',
    method: 'POST',
    path: '/order-management/1/order/applyTransition',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа.'),
      transition: z
        .string()
        .describe('Название перехода (confirm, ship, cancel, ...) — зависит от статуса.'),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Дополнительные параметры для transition (зависят от типа).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'transition', 'params'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_check_confirmation_code',
    description:
      'Проверка кода подтверждения заказа (при выдаче через ПВЗ/пункт самовывоза).',
    method: 'POST',
    path: '/order-management/1/order/checkConfirmationCode',
    domain: 'order-management',
    input: {
      parcelID: z.string().describe('ID посылки.'),
      confirmCode: z.string().describe('Код подтверждения от покупателя.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['parcelID', 'confirmCode'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_cnc_set_details',
    description:
      '⚠️ Подготовка заказа с самовывозом (CnC = click-and-collect). ' +
      'bookingPeriod — период бронирования (часов).',
    method: 'POST',
    path: '/order-management/1/order/cncSetDetails',
    domain: 'order-management',
    input: {
      id: z.string().describe('ID заказа.'),
      marketplaceId: z.string().describe('ID маркетплейса.'),
      bookingPeriod: z.number().int().positive().describe('Период бронирования (часов).'),
      address: z.string().optional().describe('Адрес пункта самовывоза.'),
      details: z.string().optional().describe('Доп. детали.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['id', 'marketplaceId', 'bookingPeriod', 'address', 'details'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_set_courier_delivery_range',
    description:
      '⚠️ Выбор временного промежутка для приезда курьера. Сначала вызовите ' +
      'orders_get_courier_delivery_range для списка доступных интервалов.',
    method: 'POST',
    path: '/order-management/1/order/setCourierDeliveryRange',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа.'),
      address: z.string().describe('Адрес доставки.'),
      addressDetails: z.string().optional().describe('Доп. детали адреса (подъезд, квартира).'),
      name: z.string().describe('Имя получателя.'),
      phone: z.string().describe('Телефон получателя.'),
      startDate: z.string().describe('Начало интервала (формат от API).'),
      endDate: z.string().describe('Конец интервала.'),
      intervalType: z.string().describe('Тип интервала (см. ответ getCourierDeliveryRange).'),
    },
    body: {
      contentType: 'application/json',
      fields: [
        'orderId',
        'address',
        'addressDetails',
        'name',
        'phone',
        'startDate',
        'endDate',
        'intervalType',
      ],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_set_tracking_number',
    description: '⚠️ Передача трек-номера курьерской службы для заказа.',
    method: 'POST',
    path: '/order-management/1/order/setTrackingNumber',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа.'),
      trackingNumber: z.string().describe('Трек-номер посылки.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'trackingNumber'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_generate_labels',
    description:
      'Создать задачу на генерацию этикеток (до 100 заказов). ' +
      'Возвращает taskID для последующего скачивания через orders_download_label.',
    method: 'POST',
    path: '/order-management/1/orders/labels',
    domain: 'order-management',
    input: {
      orderIDs: z.array(z.string()).min(1).max(100).describe('ID заказов (макс 100).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderIDs'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_generate_labels_extended',
    description:
      'Создать задачу на генерацию этикеток для большого числа заказов (до 1000). ' +
      'Возвращает taskID для последующего скачивания через orders_download_label.',
    method: 'POST',
    path: '/order-management/1/orders/labels/extended',
    domain: 'order-management',
    input: {
      orderIDs: z.array(z.string()).min(1).max(1000).describe('ID заказов (макс 1000).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderIDs'],
    },
  });
};
