/**
 * `orders` domain — maps to swaggers/orders.json
 *
 * 12 endpoints: fetching orders, status transitions, courier/postal/click-and-collect delivery, labels.
 *
 * Quirks:
 *   - operationId `checkConfirmationCode` collides with the one of the same name in delivery.json.
 *     Uniqueness is ensured by the domain prefix (orders_check_confirmation_code).
 *   - downloadLabel returns a PDF (binary); for simplicity we return the raw bytes as text content
 *     (the LLM receives the raw bytes as a string — usually useless, but the operation will run).
 *     Use a direct curl with a token if you need the file.
 *   - Most dates are Unix timestamps in seconds (integer), not ISO.
 *
 * ⚠️ Write methods:
 *   - applyTransition changes the order status
 *   - acceptReturnOrder selects the return drop-off point
 *   - markings submits the "Chestny Znak" tracking codes
 *   - setOrderTrackingNumber sets the tracking number
 *   - setCourierDeliveryRange, cncSetDetails — delivery details
 *   - generateLabels(Extended) — generates labels (paid?)
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── READ ──────────────────────────────

  defineTool(server, ctx, {
    name: 'orders_get_orders',
    title: 'Orders: list',
    risk: 'read',
    description:
      'Returns a list of delivery orders (get_orders) with filters by ID, status, and creation date. ' +
      'Read-only, changes nothing. Use it as a starting point: take the available actions from the response (availableActions: confirm/reject/perform/receive/setMarkings/setTrackNumber/setCNCDetails, etc.) for subsequent write operations. ' +
      'Available only to B2C sellers. The response includes a hasMore flag for pagination.',
    method: 'GET',
    path: '/order-management/1/orders',
    domain: 'order-management',
    input: {
      ids: z.array(z.string()).optional().describe('Filter by Avito order IDs (array of strings). If omitted, all orders matching the other filters are returned.'),
      statuses: z
        .array(
          z.enum([
            'on_confirmation',
            'ready_to_ship',
            'in_transit',
            'canceled',
            'delivered',
            'on_return',
            'in_dispute',
            'closed',
          ]),
        )
        .optional()
        .describe(
          'Filter by statuses (array). Allowed values: on_confirmation (awaiting confirmation), ' +
            'ready_to_ship (awaiting shipment), in_transit (in transit), canceled (canceled), delivered (delivered to the buyer), ' +
            'on_return (being returned), in_dispute (dispute opened), closed (closed).',
        ),
      dateFrom: z.number().int().optional().describe('Unix timestamp in seconds. Returns only orders created no earlier than this moment.'),
      page: z.number().int().min(1).optional().describe('Page number for pagination (starting from 1).'),
      limit: z.number().int().min(0).max(20).optional().describe('Maximum orders per page, from 0 to 20.'),
    },
    queryParams: ['ids', 'statuses', 'dateFrom', 'page', 'limit'],
  });

  defineTool(server, ctx, {
    name: 'orders_get_courier_delivery_range',
    title: 'Orders: courier time slots',
    risk: 'read',
    description:
      'Returns the available time slots for a courier to pick up the item (get_courier_delivery_range), for seller-courier delivery (RDBS/Courier). ' +
      'Read-only. Call it BEFORE orders_set_courier_delivery_range — a specific slot is chosen from the response (dateOptions with intervals and intervalType). ' +
      'Do not confuse it with the set version: this one only reads the available intervals, it does not book them.',
    method: 'GET',
    path: '/order-management/1/order/getCourierDeliveryRange',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('Avito order ID.'),
      address: z.string().describe("Seller's address where the courier picks up the item."),
    },
    queryParams: ['orderId', 'address'],
  });

  defineTool(server, ctx, {
    name: 'orders_download_label',
    title: 'Orders: download label',
    risk: 'read',
    description:
      'Downloads the generated PDF file with labels by taskID (download_label). Read-only, changes nothing. ' +
      'Call it AFTER orders_generate_labels or orders_generate_labels_extended, once the generation task is complete — the taskID comes from their response. ' +
      'Returns a structured binary response {mimeType: "application/pdf", sizeBytes, base64}; decode the base64 to save or print the file. ' +
      'If the task is not ready yet or the taskID is wrong, a 404 is returned.',
    method: 'GET',
    path: '/order-management/1/orders/labels/{taskID}/download',
    domain: 'order-management',
    input: {
      taskID: z.string().describe('ID of the label-generation task (document) obtained from orders_generate_labels(_extended).'),
    },
    pathParams: ['taskID'],
  });

  // ────────────────────────────── WRITE ──────────────────────────────

  defineTool(server, ctx, {
    name: 'orders_markings',
    title: '⚠️ Orders: Chestny Znak codes',
    risk: 'write',
    description:
      '⚠️ Submits "Chestny Znak" marking codes (DataMatrix) for the items in an order (markings). ' +
      'Write operation: stores the codes on the Avito side; required when the order has a setMarkings action (see availableActions in orders_get_orders). ' +
      'Maximum 50 marking records per request; the response contains an array of per-item results (success/error). ' +
      'Do not confuse it with status transitions (orders_apply_transition) — this method only attaches codes, it does not change the order status.',
    method: 'POST',
    path: '/order-management/1/markings',
    domain: 'order-management',
    input: {
      markings: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          'Array of marking records (max 50). Each record: itemId (Avito item ID), orderId (Avito order ID) ' +
            'and markings — an array of DataMatrix codes (up to 10 codes, each a string of 29–129 characters).',
        ),
    },
    body: {
      contentType: 'application/json',
      fields: ['markings'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_accept_return_order',
    title: '⚠️ Orders: accept return',
    risk: 'public',
    destructiveHint: true,
    description:
      '⚠️ Confirms the buyer\'s return of an item and selects the Russian Post office the return parcel will be sent to (accept_return_order). ' +
      'Write/public operation for courier delivery (Courier): the confirmation is visible to the buyer and irreversibly starts the return process. ' +
      'Call it when the order has an available acceptReturnOrder action. The response contains a success flag.',
    method: 'POST',
    path: '/order-management/1/order/acceptReturnOrder',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('Avito order ID.'),
      terminalNumber: z.string().describe('Number of the Russian Post office the return parcel will be sent to (e.g. "141138").'),
      recipient: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Details of the person who will collect the return: name (full name) and phone (phone, format "+79999999999").'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'terminalNumber', 'recipient'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_apply_transition',
    title: '⚠️ Orders: change status',
    risk: 'public',
    destructiveHint: true,
    description:
      '⚠️ Applies an order status transition (apply_transition), such as confirmation or cancellation. ' +
      'WARNING: the new status is visible to the buyer and affects the deal; the transition is irreversible. ' +
      'The allowed transitions depend on the current status — see the list of available actions in availableActions from orders_get_orders. ' +
      'The response contains a success flag.',
    method: 'POST',
    path: '/order-management/1/order/applyTransition',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('Avito order ID.'),
      transition: z
        .enum(['confirm', 'reject', 'perform', 'receive'])
        .describe(
          'Transition name. Allowed values: confirm (confirm the order), reject (cancel the order), ' +
            'perform (confirm shipment, RDBS), receive (confirm delivery, RDBS/CNC). The set depends on the current status.',
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Additional delivery parameters. For click-and-collect (CNC), a cnc object with the fields confirmCode (the code the buyer shows the seller) ' +
            'and marketplaceId (order number in the new system).',
        ),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'transition', 'params'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_check_confirmation_code',
    title: 'Orders: verify code',
    risk: 'read',
    description:
      'Verifies the confirmation code for handing over an order at a pickup point (check_confirmation_code): the buyer states the code from the app and the method validates it. ' +
      'Effectively a read check, it does not change the order. The response contains status: success (code valid), fail (invalid), expired (expired), or attempts (attempts exhausted). ' +
      'Do not confuse it with delivery_check_confirmation_code from the delivery domain — this method belongs to order management.',
    method: 'POST',
    path: '/order-management/1/order/checkConfirmationCode',
    domain: 'order-management',
    input: {
      parcelID: z.string().describe('Avito parcel ID (e.g. "P00081306679").'),
      confirmCode: z.string().describe('The confirmation code the buyer showed/stated upon receipt.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['parcelID', 'confirmCode'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_cnc_set_details',
    title: '⚠️ Orders: click-and-collect (details)',
    risk: 'write',
    description:
      '⚠️ Prepares a click-and-collect order and sends the details to the buyer (cnc_set_details, CNC = click-and-collect). ' +
      'Write operation: the seller sets the pickup address, the booking period, and a comment the buyer will see. ' +
      'Call it when the order has an available setCNCDetails action. After handover, confirmation is done via orders_apply_transition (receive) with the buyer\'s code.',
    method: 'POST',
    path: '/order-management/1/order/cncSetDetails',
    domain: 'order-management',
    input: {
      id: z.string().describe('Avito order ID.'),
      marketplaceId: z.string().describe('Order number in the new Avito system (marketplace).'),
      bookingPeriod: z.number().int().positive().describe('Item booking period in hours (e.g. 4).'),
      address: z.string().optional().describe('Address where the buyer picks up the item (e.g. "Tverskaya Street 3, Moscow").'),
      details: z.string().optional().describe('A comment the buyer will receive (e.g. "I can hand over the item from 13:00 to 18:00").'),
    },
    body: {
      contentType: 'application/json',
      fields: ['id', 'marketplaceId', 'bookingPeriod', 'address', 'details'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_set_courier_delivery_range',
    title: '⚠️ Orders: select courier slot',
    risk: 'write',
    description:
      '⚠️ Selects (books) a specific time slot for a courier to pick up the item (set_courier_delivery_range), for seller-courier delivery. ' +
      'A write operation, unlike the read method orders_get_courier_delivery_range, which only shows the available slots — call it first and take the interval and intervalType from the response. ' +
      'Can be called again to change the time while the courier has not yet picked up the parcel. The response contains a success flag.',
    method: 'POST',
    path: '/order-management/1/order/setCourierDeliveryRange',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('Avito order ID.'),
      address: z.string().describe("Seller's address where the courier picks up the item."),
      addressDetails: z.string().optional().describe('Seller address details (entrance, floor, apartment, etc.).'),
      name: z.string().describe("Full name of the seller's contact person."),
      phone: z.string().describe("Phone of the seller's contact person."),
      startDate: z.string().describe('Start date/time of the courier arrival in date-time format (ISO 8601); taken from the get method response.'),
      endDate: z.string().describe('End date/time of the courier arrival in date-time format (ISO 8601); taken from the get method response.'),
      intervalType: z.enum(['fixed', 'asap']).describe('Interval type from orders_get_courier_delivery_range.'),
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
    title: '⚠️ Orders: tracking number',
    risk: 'public',
    description:
      '⚠️ Submits the parcel tracking number for delivery by the seller\'s partners (set_tracking_number, DBS). ' +
      'Write/public operation: the tracking number is visible to the buyer for tracking. Call it when the order has an available setTrackNumber action (or fixTrackNumber to correct it). ' +
      'The response contains a success flag; on error, code: incorrect_number (invalid number) or already_set (the number is already attached to another order).',
    method: 'POST',
    path: '/order-management/1/order/setTrackingNumber',
    domain: 'order-management',
    input: {
      orderId: z.string().describe('Avito order ID.'),
      trackingNumber: z.string().describe('Parcel tracking number from the delivery service (e.g. "01-01031002199").'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'trackingNumber'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_generate_labels',
    title: 'Orders: create labels',
    risk: 'write',
    description:
      'Creates a task to generate PDF labels for orders (generate_labels, up to 100 orders at a time). ' +
      'Available only for pickup-point orders. Returns a taskID; wait for it to be ready and download the file via orders_download_label. ' +
      'For large batches (up to 1000 orders) use orders_generate_labels_extended — it has a higher limit but a strict rate limit (1 request/min).',
    method: 'POST',
    path: '/order-management/1/orders/labels',
    domain: 'order-management',
    input: {
      orderIDs: z.array(z.string()).min(1).max(100).describe('Array of order IDs in the deals service (marketplace), from 1 to 100.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderIDs'],
    },
  });

  defineTool(server, ctx, {
    name: 'orders_generate_labels_extended',
    title: 'Orders: create labels (up to 1000)',
    risk: 'write',
    description:
      'Creates a task to generate PDF labels for a large batch of orders (generate_labels_extended, up to 1000 orders at a time). ' +
      'Available only for pickup-point orders. Difference from orders_generate_labels: a higher order limit (1000 vs 100), but a strict rate limit — 1 request per minute. ' +
      'Returns a taskID; wait for it to be ready and download the file via orders_download_label.',
    method: 'POST',
    path: '/order-management/1/orders/labels/extended',
    domain: 'order-management',
    input: {
      orderIDs: z.array(z.string()).min(1).max(1000).describe('Array of order IDs in the deals service (marketplace), from 1 to 1000.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderIDs'],
    },
  });
};
