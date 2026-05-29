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
    title: 'Заказы: список',
    risk: 'read',
    description:
      'Возвращает список заказов доставки (get_orders) с фильтрами по ID, статусу и дате создания. ' +
      'Только чтение, ничего не меняет. Используйте как отправную точку: из ответа берите доступные действия (availableActions: confirm/reject/perform/receive/setMarkings/setTrackNumber/setCNCDetails и т.д.) для последующих write-операций. ' +
      'Доступно только B2C-продавцам. Ответ содержит флаг hasMore для пагинации.',
    method: 'GET',
    path: '/order-management/1/orders',
    domain: 'order-management',
    input: {
      ids: z.array(z.string()).optional().describe('Фильтр по ID заказов в Авито (массив строк). Если не указан — возвращаются все заказы по другим фильтрам.'),
      statuses: z
        .array(z.string())
        .optional()
        .describe(
          'Фильтр по статусам (массив). Допустимые значения: on_confirmation (ожидает подтверждения), ' +
            'ready_to_ship (ждёт отправки), in_transit (в пути), canceled (отменён), delivered (доставлен покупателю), ' +
            'on_return (на возврате), in_dispute (открыт спор), closed (закрыт).',
        ),
      dateFrom: z.number().int().optional().describe('Unix timestamp в секундах. Возвращает только заказы, созданные не раньше этого момента.'),
      page: z.number().int().min(1).optional().describe('Номер страницы для пагинации (начиная с 1).'),
      limit: z.number().int().min(1).max(100).optional().describe('Максимум заказов на странице. По API допускается до 20.'),
    },
    queryParams: ['ids', 'statuses', 'dateFrom', 'page', 'limit'],
  });

  defineTool(server, ctx, {
    name: 'orders_get_courier_delivery_range',
    title: 'Заказы: слоты курьера',
    risk: 'read',
    description:
      'Возвращает доступные временные промежутки приезда курьера за товаром (get_courier_delivery_range), для доставки курьером продавца (RDBS/Courier). ' +
      'Только чтение. Вызывайте ДО orders_set_courier_delivery_range — из ответа (dateOptions с интервалами и intervalType) выбирается конкретный слот. ' +
      'Не путать с set-версией: эта только читает доступные интервалы, не бронирует их.',
    method: 'GET',
    path: '/order-management/1/order/getCourierDeliveryRange',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа в Авито.'),
      address: z.string().describe('Адрес продавца, откуда курьер забирает товар.'),
    },
    queryParams: ['orderId', 'address'],
  });

  defineTool(server, ctx, {
    name: 'orders_download_label',
    title: 'Заказы: скачать этикетку',
    risk: 'read',
    description:
      'Скачивает сгенерированный PDF-файл с этикетками по taskID (download_label). Только чтение, ничего не меняет. ' +
      'Вызывайте ПОСЛЕ orders_generate_labels или orders_generate_labels_extended, когда задача генерации завершена — taskID берётся из их ответа. ' +
      'Возвращает структурированный binary-ответ {mimeType: "application/pdf", sizeBytes, base64}; декодируйте base64, чтобы сохранить или напечатать файл. ' +
      'Если задача ещё не готова или taskID неверный — вернётся 404.',
    method: 'GET',
    path: '/order-management/1/orders/labels/{taskID}/download',
    domain: 'order-management',
    input: {
      taskID: z.string().describe('ID задачи (документа) генерации этикеток, полученный из orders_generate_labels(_extended).'),
    },
    pathParams: ['taskID'],
  });

  // ────────────────────────────── WRITE ──────────────────────────────

  defineTool(server, ctx, {
    name: 'orders_markings',
    title: '⚠️ Заказы: честный знак',
    risk: 'write',
    description:
      '⚠️ Передаёт коды маркировки "Честный знак" (DataMatrix) для товаров в заказе (markings). ' +
      'Write-операция: сохраняет коды на стороне Авито, требуется когда у заказа есть действие setMarkings (см. availableActions в orders_get_orders). ' +
      'Максимум 50 записей маркировки за запрос; ответ содержит массив результатов по каждому товару (success/error). ' +
      'Не путать с переходами статуса (orders_apply_transition) — этот метод лишь прикрепляет коды, статус заказа не меняет.',
    method: 'POST',
    path: '/order-management/1/markings',
    domain: 'order-management',
    input: {
      markings: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          'Массив записей маркировки (макс. 50). Каждая запись: itemId (ID товара в Авито), orderId (ID заказа в Авито) ' +
            'и markings — массив кодов DataMatrix (до 10 кодов, каждый строка длиной 29–129 символов).',
        ),
    },
    body: {
      contentType: 'application/json',
      fields: ['markings'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_accept_return_order',
    title: '⚠️ Заказы: принять возврат',
    risk: 'public',
    destructiveHint: true,
    description:
      '⚠️ Подтверждает возврат товара покупателем и выбирает отделение Почты России, куда приедет возвратная посылка (accept_return_order). ' +
      'Write/public-операция для курьерской доставки (Courier): подтверждение видно покупателю и необратимо запускает процесс возврата. ' +
      'Вызывайте когда у заказа доступно действие acceptReturnOrder. Ответ содержит флаг success.',
    method: 'POST',
    path: '/order-management/1/order/acceptReturnOrder',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа в Авито.'),
      terminalNumber: z.string().describe('Номер отделения Почты России, куда придёт возвратная посылка (например "141138").'),
      recipient: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Данные человека, который заберёт возврат: name (ФИО) и phone (телефон, формат "+79999999999").'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'terminalNumber', 'recipient'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_apply_transition',
    title: '⚠️ Заказы: сменить статус',
    risk: 'public',
    destructiveHint: true,
    description:
      '⚠️ Применяет переход статуса заказа (apply_transition), например подтверждение или отмену. ' +
      'ВНИМАНИЕ: новый статус виден покупателю и влияет на сделку; переход необратим. ' +
      'Допустимые переходы зависят от текущего статуса — список доступных действий см. в availableActions из orders_get_orders. ' +
      'Ответ содержит флаг success.',
    method: 'POST',
    path: '/order-management/1/order/applyTransition',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа в Авито.'),
      transition: z
        .string()
        .describe(
          'Название перехода. Допустимые значения: confirm (подтвердить заказ), reject (отменить заказ), ' +
            'perform (подтвердить отправку, RDBS), receive (подтвердить доставку, RDBS/CNC). Набор зависит от текущего статуса.',
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Дополнительные параметры доставки. Для самовывоза (CNC) объект cnc с полями confirmCode (код, который покупатель показывает продавцу) ' +
            'и marketplaceId (номер заказа в новой системе).',
        ),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'transition', 'params'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_check_confirmation_code',
    title: 'Заказы: проверка кода',
    risk: 'read',
    description:
      'Проверяет код подтверждения для выдачи заказа в ПВЗ (check_confirmation_code): покупатель называет код из приложения, метод валидирует его. ' +
      'Фактически read-проверка, заказ не меняет. Ответ содержит status: success (код верный), fail (неверный), expired (истёк) или attempts (исчерпаны попытки). ' +
      'Не путать с delivery_check_confirmation_code из домена доставки — этот метод относится к управлению заказами.',
    method: 'POST',
    path: '/order-management/1/order/checkConfirmationCode',
    domain: 'order-management',
    input: {
      parcelID: z.string().describe('ID посылки в Авито (например "P00081306679").'),
      confirmCode: z.string().describe('Код подтверждения, который покупатель показал/назвал при получении.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['parcelID', 'confirmCode'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_cnc_set_details',
    title: '⚠️ Заказы: самовывоз (детали)',
    risk: 'write',
    description:
      '⚠️ Подготавливает заказ с самовывозом и передаёт детали покупателю (cnc_set_details, CNC = click-and-collect). ' +
      'Write-операция: продавец задаёт адрес получения, срок бронирования и комментарий, который увидит покупатель. ' +
      'Вызывайте когда у заказа доступно действие setCNCDetails. После выдачи подтверждение делается через orders_apply_transition (receive) с кодом покупателя.',
    method: 'POST',
    path: '/order-management/1/order/cncSetDetails',
    domain: 'order-management',
    input: {
      id: z.string().describe('ID заказа в Авито.'),
      marketplaceId: z.string().describe('Номер заказа в Авито в новой системе (marketplace).'),
      bookingPeriod: z.number().int().positive().describe('Срок бронирования товара в часах (например 4).'),
      address: z.string().optional().describe('Адрес получения товара покупателем (например "Тверская улица, 3, Москва").'),
      details: z.string().optional().describe('Комментарий, который получит покупатель (например "Могу передать товар с 13:00 до 18:00").'),
    },
    body: {
      contentType: 'application/json',
      fields: ['id', 'marketplaceId', 'bookingPeriod', 'address', 'details'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_set_courier_delivery_range',
    title: '⚠️ Заказы: выбрать слот курьера',
    risk: 'write',
    description:
      '⚠️ Выбирает (бронирует) конкретный временной промежуток приезда курьера за товаром (set_courier_delivery_range), для доставки курьером продавца. ' +
      'Write-операция, в отличие от read-метода orders_get_courier_delivery_range, который только показывает доступные слоты — сначала вызовите его и возьмите интервал и intervalType из ответа. ' +
      'Можно вызвать повторно для изменения времени, пока курьер ещё не забрал посылку. Ответ содержит флаг success.',
    method: 'POST',
    path: '/order-management/1/order/setCourierDeliveryRange',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа в Авито.'),
      address: z.string().describe('Адрес продавца, откуда курьер забирает товар.'),
      addressDetails: z.string().optional().describe('Детали адреса продавца (подъезд, этаж, квартира и т.п.).'),
      name: z.string().describe('ФИО контактного лица у продавца.'),
      phone: z.string().describe('Телефон контактного лица у продавца.'),
      startDate: z.string().describe('Начальная дата/время приезда курьера в формате date-time (ISO 8601); берётся из ответа get-метода.'),
      endDate: z.string().describe('Конечная дата/время приезда курьера в формате date-time (ISO 8601); берётся из ответа get-метода.'),
      intervalType: z.string().describe('Тип интервала: fixed (фиксированный слот) или asap (как можно скорее). Берётся из ответа orders_get_courier_delivery_range.'),
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
    title: '⚠️ Заказы: трек-номер',
    risk: 'public',
    description:
      '⚠️ Передаёт трек-номер посылки для доставки партнёрами продавца (set_tracking_number, DBS). ' +
      'Write/public-операция: трек-номер виден покупателю для отслеживания. Вызывайте когда у заказа доступно действие setTrackNumber (или fixTrackNumber для исправления). ' +
      'Ответ содержит флаг success; при ошибке code: incorrect_number (некорректный номер) или already_set (номер уже привязан к другому заказу).',
    method: 'POST',
    path: '/order-management/1/order/setTrackingNumber',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('ID заказа в Авито.'),
      trackingNumber: z.string().describe('Трек-номер посылки от службы доставки (например "01-01031002199").'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'trackingNumber'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_generate_labels',
    title: 'Заказы: создать этикетки',
    risk: 'write',
    description:
      'Создаёт задачу на генерацию PDF-этикеток для заказов (generate_labels, до 100 заказов за раз). ' +
      'Доступно только для ПВЗ-заказов. Возвращает taskID; дождитесь готовности и скачайте файл через orders_download_label. ' +
      'Для больших партий (до 1000 заказов) используйте orders_generate_labels_extended — у него выше лимит, но строгий rate limit (1 запрос/мин).',
    method: 'POST',
    path: '/order-management/1/orders/labels',
    domain: 'order-management',
    input: {
      orderIDs: z.array(z.string()).min(1).max(100).describe('Массив ID заказов в сервисе сделок (marketplace), от 1 до 100.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderIDs'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_generate_labels_extended',
    title: 'Заказы: создать этикетки (до 1000)',
    risk: 'write',
    description:
      'Создаёт задачу на генерацию PDF-этикеток для большой партии заказов (generate_labels_extended, до 1000 заказов за раз). ' +
      'Доступно только для ПВЗ-заказов. Отличие от orders_generate_labels: выше лимит заказов (1000 против 100), но жёсткий rate limit — 1 запрос в минуту. ' +
      'Возвращает taskID; дождитесь готовности и скачайте файл через orders_download_label.',
    method: 'POST',
    path: '/order-management/1/orders/labels/extended',
    domain: 'order-management',
    input: {
      orderIDs: z.array(z.string()).min(1).max(1000).describe('Массив ID заказов в сервисе сделок (marketplace), от 1 до 1000.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderIDs'],
    },
  });
};
