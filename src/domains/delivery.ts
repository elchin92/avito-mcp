/**
 * Domain `delivery` — swaggers/delivery.json (31 endpoints, the largest one).
 *
 * This is a B2B partner logistics API (only for delivery-service partners).
 * You won't be able to call most of these methods from a regular account.
 *
 * Quirks:
 *   - The `checkConfirmationCode` operationId collides with the same-named one in orders.json.
 *     Uniqueness is ensured via the domain prefix.
 *   - Complex nested bodies are described minimally via z.record(z.unknown()) — for full schemas
 *     see swaggers/delivery.json (201 schema components).
 *   - Most of the paths under /delivery-sandbox/ are intentionally test-environment endpoints
 *     for delivery-service partners; on a production account they return 403/404 for regular users.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

/** Generic helper — a passthrough object with a swagger reference for a loosely typed body. */
const opaque = (refToSwagger: string) =>
  z.record(z.string(), z.unknown()).describe(`See ${refToSwagger} in swaggers/delivery.json`);

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── Announcements ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_create_announcement_3pl',
    title: 'Delivery: create announcement [3PL]',
    risk: 'write',
    description:
      '[3PL] Creates an announcement of a planned shipment from one delivery service (sender) to another (receiver). ' +
      'The method is implemented on the delivery-service side — on a regular seller account it returns 403/404. Use it when you need ' +
      'to notify the receiving party about an upcoming parcel handover; unlike delivery_create_parcel ' +
      'this is a shipment announcement, not the creation of the parcel itself.',
    method: 'POST',
    path: '/createAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID').describe('Announcement identifier (required).'),
      announcementType: z.string().describe('Announcement type. Enum: DELIVERY (delivery) | PICKUP (pickup).'),
      barcode: z
        .string()
        .describe('Unique announcement barcode, printed on the acceptance/handover act. Example: 000987654321.'),
      date: opaque('Date').describe('Announcement creation date and time in RFC 3339 format, UTC.'),
      packages: z.array(opaque('Package')).describe('List of cargo units (at least one).'),
      receiver: opaque('Receiver').describe('Receiving party: type (3PL), name, phones, email, delivery node/sorting center.'),
      sender: opaque('Sender').describe('Sending party: type (3PL), name, phones, email, delivery node/sorting center.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['announcementID', 'announcementType', 'barcode', 'date', 'packages', 'receiver', 'sender'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_cancel_announcement_3pl',
    title: 'Delivery: cancel announcement [3PL]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[3PL] Cancels a previously created shipment announcement in the delivery service. Irreversibly cancels an announcement created via ' +
      'delivery_create_announcement_3pl. The method is implemented on the delivery-service side — on a regular seller account it returns 403/404.',
    method: 'POST',
    path: '/cancelAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID').describe('Identifier of the announcement to cancel (required).'),
      reason: z.string().optional().describe('Cancellation reason (optional).'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'reason'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_create_parcel',
    title: '⚠️ Delivery: create parcel [3PL]',
    risk: 'write',
    description:
      '[3PL] Production creation of a parcel on the delivery-service side (CreateParcelRequest). The method is implemented ' +
      'by the delivery-service partner — on a regular seller account it returns 403/404. orderID, parcelID, items, ' +
      'sender, receiver, payment are required. Unlike delivery_create_sandbox_parcel_v2 ([SANDBOX v2]), this is production, ' +
      'the creation of a real parcel.',
    method: 'POST',
    path: '/createParcel',
    domain: 'delivery',
    input: {
      orderID: z.string().describe('Avito order identifier.'),
      parcelID: z.string().describe('Parcel identifier on the delivery-service side.'),
      items: z.array(opaque('CreateParcelItem')).min(1).describe('Parcel contents (items); at least one element.'),
      sender: opaque('CreateParcelClient').describe('Sender: full name/company name, phone, address/sending node.'),
      receiver: opaque('CreateParcelClient').describe('Receiver: full name, phone, address or pickup-point code.'),
      payment: opaque('CreateParcelPayment').describe('Payment parameters: method, amount, declared value.'),
      barcodes: z.array(z.string()).optional().describe('Parcel barcodes (optional).'),
      directOrderID: z.string().optional().describe('Direct order identifier at the delivery service (optional).'),
      options: opaque('CreateParcelOptions').optional().describe('Additional parcel options (optional).'),
      package: opaque('CreateParcelPackage').optional().describe('Packaging parameters: dimensions, weight (optional).'),
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
    title: 'Delivery: create announcement [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Creates an announcement of a planned shipment to Avito in the test environment; after creation the announcement ' +
      'is routed to the delivery service specified in receiver. For delivery-service partners only. Unlike ' +
      'delivery_create_announcement_3pl (production /createAnnouncement), this is a sandbox, with no consequences.',
    method: 'POST',
    path: '/delivery-sandbox/announcements/create',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID').describe('Announcement identifier (required).'),
      announcementType: z.string().describe('Announcement type. Enum: DELIVERY | PICKUP.'),
      barcode: z.string().describe('Unique announcement barcode (printed on the acceptance/handover act).'),
      date: opaque('Date').describe('Announcement creation date and time in RFC 3339 format, UTC.'),
      packages: z.array(opaque('Package')).describe('List of cargo units.'),
      receiver: opaque('Receiver').describe('Receiving delivery service: type, name, phones, email, delivery node/sorting center.'),
      sender: opaque('Sender').describe('Sending party: type, name, phones, email, sending node.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['announcementID', 'announcementType', 'barcode', 'date', 'packages', 'receiver', 'sender'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_sandbox_track_announcement',
    title: 'Delivery: track announcement [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Accepts a tracking event for an announcement from the delivery service in the test environment. Use it to ' +
      'simulate the progress of an announcement (acceptance, delivery, cancellation). For delivery-service partners only.',
    method: 'POST',
    path: '/delivery-sandbox/announcements/track',
    domain: 'delivery',
    input: {
      announcementID: opaque('AnnouncementID').describe('Identifier of the tracked announcement (required).'),
      date: opaque('Date').describe('Event date in RFC 3339 format, UTC.'),
      event: z
        .string()
        .describe('Event type. Enum: ACCEPTANCE_DONE | CANCELLED | DELIVERED | RECEIVED.'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'date', 'event'] },
  });

  // ────────────────────────────── Sandbox: areas & schedule ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_custom_area_schedule',
    title: 'Delivery: zone schedule [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Sets the working schedule of a delivery zone for a specific day that differs from the regular schedule ' +
      '(for example, holidays/weekends). Re-uploading overwrites the previous schedule for those dates. ' +
      'For delivery-service partners only. The body is an array of schedules directly (no wrapper).',
    method: 'POST',
    path: '/delivery-sandbox/areas/custom-schedule',
    domain: 'delivery',
    input: {
      schedules: z
        .array(opaque('CustomAreaSchedule'))
        .describe('List of unique custom schedules by date (zone tag, date, working intervals).'),
    },
    // customAreaScheduleRequest = top-level JSON array. We send the array directly,
    // like the neighboring array tools (sorting-center / areas / tags / terminals / zones).
    body: { contentType: 'application/json', transform: (b) => (b.schedules as unknown[]) ?? [] },
  });

  // ────────────────────────────── Sandbox: parcel ops ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_sandbox_cancel_parcel',
    title: 'Delivery: cancel parcel [sandbox]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX] Cancels a test parcel on behalf of the receiver. The method is implemented on the delivery-service side — for ' +
      'delivery-service partners only. Unlike delivery_v1_cancel_parcel ([SANDBOX v1] with an options field), this is the base contract ' +
      'with an actor field.',
    method: 'POST',
    path: '/delivery-sandbox/cancelParcel',
    domain: 'delivery',
    input: {
      parcelID: opaque('ParcelID').describe('Identifier of the parcel to cancel (required).'),
      actor: z.string().describe('Who initiates the cancellation. Enum: receiver (the recipient).'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'actor'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_check_confirmation_code',
    title: 'Delivery: check code [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Verifies the confirmation code that the buyer shows at the pickup point upon handover. Returns ' +
      'the verification status (success / other). For delivery-service partners only; a same-named endpoint exists in the orders domain — ' +
      'this one applies to delivery parcels.',
    method: 'POST',
    path: '/delivery-sandbox/order/checkConfirmationCode',
    domain: 'delivery',
    input: {
      parcelID: z.string().describe('Parcel identifier.'),
      confirmCode: z.string().describe('Confirmation code presented by the buyer at the pickup point.'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'confirmCode'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_set_order_properties',
    title: 'Delivery: parcel properties [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Sends parcel delivery parameters to Avito (for example, the final delivery cost). On ' +
      'a repeated submission the data is overwritten — it is important to send current values. For delivery-service partners only.',
    method: 'POST',
    path: '/delivery-sandbox/order/properties',
    domain: 'delivery',
    input: {
      orderId: opaque('OrderID').describe('Order identifier.'),
      properties: opaque('Properties').describe('Parcel delivery parameters (for example, the final delivery cost).'),
    },
    body: { contentType: 'application/json', fields: ['orderId', 'properties'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_set_order_real_address',
    title: 'Delivery: actual address [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Sends Avito the actual pickup point for parcel acceptance/return — needed for agent and customer ' +
      'returns. For delivery-service partners only.',
    method: 'POST',
    path: '/delivery-sandbox/order/realAddress',
    domain: 'delivery',
    input: {
      orderId: opaque('OrderID').describe('Order identifier.'),
      address: opaque('Address').describe('Actual pickup point/address for parcel acceptance or return.'),
    },
    body: { contentType: 'application/json', fields: ['orderId', 'address'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_tracking',
    title: 'Delivery: tracking event [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Sends Avito parcel tracking information (a delivery status change) on behalf of the delivery service. ' +
      'Requires compliance with the retry policy. For delivery-service partners only. Despite the "event" wording in the title, ' +
      'the method records an event — it is a write, not a status read.',
    method: 'POST',
    path: '/delivery-sandbox/order/tracking',
    domain: 'delivery',
    input: {
      orderId: opaque('OrderID').describe('Order identifier.'),
      avitoEventType: z
        .string()
        .describe('Event code on the Avito side. Example: RECEIVED_AT_TRANSIT_TERMINAL.'),
      avitoStatus: opaque('AvitoStatus').describe(
        'Parcel status. Enum: CONFIRMED | IN_TRANSIT | ON_DELIVERY | DELIVERED | IN_TRANSIT_RETURN | ' +
          'ON_DELIVERY_RETURN | RETURNED | LOST | DESTROYED.',
      ),
      date: opaque('Date').describe('Event date and time in RFC 3339 format, UTC.'),
      location: z.string().describe('Event locality in the nominative case. Example: Kazan.'),
      providerEventCode: z.string().describe('Event code as defined by the delivery service.'),
      comment: z.string().optional().describe('Comment on the status (optional).'),
      options: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Additional status options: parcel barcode, return numbers (optional).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['orderId', 'avitoEventType', 'avitoStatus', 'date', 'location', 'providerEventCode', 'comment', 'options'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_prohibit_order_acceptance',
    title: 'Delivery: prohibit acceptance [sandbox]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX] Prohibits accepting a parcel from the sender on the delivery-service side — the parcel will not be taken into processing. ' +
      'The method is implemented on the delivery-service side, for delivery-service partners only. Used in the parcel cancellation flow.',
    method: 'POST',
    path: '/delivery-sandbox/prohibitOrderAcceptance',
    domain: 'delivery',
    input: { orderId: opaque('OrderID').describe('Identifier of the order whose acceptance is prohibited.') },
    body: { contentType: 'application/json', fields: ['orderId'] },
  });

  // ────────────────────────────── Sandbox: tariffs/sorting centers ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_get_sorting_center',
    title: 'Delivery: list sorting centers [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Returns the sorting centers (hubs) for the specified delivery services. For delivery-service partners only. ' +
      'Delivery-service codes: pochta (Russian Post), exmail, bb (Boxberry), pp (PickPoint), dpd, and others.',
    method: 'GET',
    path: '/delivery-sandbox/sorting-center',
    domain: 'delivery',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'delivery_add_sorting_center',
    title: 'Delivery: upload sorting centers [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Creates a task to upload your own sorting centers (hubs) with initial validation; ' +
      'returns a taskID — check the status via delivery_get_task. After uploading sorting centers you must assign tags ' +
      'with a separate request (delivery_add_tags_to_sorting_center). For delivery-service partners only. The body is an array of sorting centers directly.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/sorting-center',
    domain: 'delivery',
    input: {
      centers: z
        .array(opaque('SortingCenterPost'))
        .min(1)
        .describe('Array of sorting centers: deliveryProviderId, name, address, phones, itinerary, photos, directionTag, schedule, restriction.'),
    },
    body: { contentType: 'application/json', transform: (b) => (b.centers as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_areas_sandbox',
    title: 'Delivery: upload areas [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Uploads the areas where courier delivery/pickup is available for the specified tariff. ' +
      'The address classifier is Russian Post postal codes (1 postal code = all addresses belonging to it). For ' +
      'delivery-service partners only. The body is an array of areas directly.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/areas',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('Tariff identifier (in path).'),
      areas: z
        .array(opaque('Area'))
        .min(1)
        .describe('Array of areas: directionTag, providerAreaNumber, services (intake/delivery), utcTimezone, zipCodes, restrictions.'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.areas as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_tags_to_sorting_center',
    title: 'Delivery: sorting center tags [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Creates a task to assign direction tags to your own and/or third-party sorting centers within ' +
      'a tariff; returns a taskID — status via delivery_get_task. Within a single tariff each sorting center maps to ' +
      'exactly one tag, and re-binding is not possible. For delivery-service partners only. The body is an array directly.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/tagged-sorting-centers',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('Tariff identifier (in path).'),
      tagged: z
        .array(opaque('TaggedSortingCenter'))
        .min(1)
        .describe('Array of bindings: deliveryProviderId (sorting-center ID at the provider) + directionTag (direction tag).'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.tagged as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_terminals_sandbox',
    title: 'Delivery: upload pickup points [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Uploads terminals (pickup points/parcel lockers) for a tariff. The system auto-approves changes: with ' +
      'a high percentage of critical changes the upload is sent for manual review. For delivery-service partners only. ' +
      'The body is an array of terminals directly.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/terminals',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('Tariff identifier (in path).'),
      terminals: z
        .array(opaque('Terminal'))
        .min(1)
        .describe('Array of pickup points: deliveryProviderId, name, address, phones, services (intake/delivery), schedule, type (PVZ|POSTAMAT, default PVZ).'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.terminals as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_update_terms',
    title: 'Delivery: delivery-term zones [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Creates a task to update the delivery-term zones in a tariff; returns a taskID — status via ' +
      'delivery_get_task. Important: the list of new terms must fully match the tariff\'s deliveryProviderZoneId ' +
      'values. For delivery-service partners only. The body is an array of zones directly.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/terms',
    domain: 'delivery',
    input: {
      tariff_id: z.string().describe('Tariff identifier (in path).'),
      zones: z
        .array(opaque('TermsZone'))
        .min(1)
        .describe('Array of delivery-term zones: deliveryProviderZoneId, name, minTerm/maxTerm (business days).'),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.zones as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_tariff_sandbox_v2',
    title: 'Delivery: upload tariff [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX v2] Uploads a new tariff: lets the delivery service control direction availability, delivery cost, and delivery ' +
      'terms. Limits: body up to 400MB, up to 1 million directions. For delivery-service partners only.',
    method: 'POST',
    path: '/delivery-sandbox/tariffsV2',
    domain: 'delivery',
    input: {
      name: z.string().describe('Human-readable tariff name (for the UI).'),
      deliveryProviderTariffId: z.string().describe('Tariff identifier on the delivery-service side.'),
      directions: z
        .array(opaque('Direction'))
        .describe('Directions: directionTagFrom→directionTagTo link, tariff zone, minTerm/maxTerm (business days).'),
      tariffZones: z
        .array(opaque('TariffZone'))
        .describe('Tariff zones: name, deliveryProviderTariffZoneId, items (per-service price calculation models).'),
      termsZones: z
        .array(opaque('TermsZone'))
        .describe('Delivery-term zones: deliveryProviderZoneId, name, minTerm/maxTerm (business days).'),
      tariffType: z.string().optional().describe('Tariff type (optional).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['name', 'deliveryProviderTariffId', 'directions', 'tariffZones', 'termsZones', 'tariffType'],
    },
  });

  // ────────────────────────────── Sandbox: tasks ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_get_task',
    title: 'Delivery: task status [sandbox]',
    risk: 'read',
    description:
      '[SANDBOX] Returns the status of an asynchronous task by the taskID obtained from upload operations ' +
      '(sorting centers, tags, areas, terms, tariff). Statuses: processing | success | <error>. Processing usually takes ' +
      '5–20 minutes. For delivery-service partners only.',
    method: 'GET',
    path: '/delivery-sandbox/tasks/{task_id}',
    domain: 'delivery',
    input: {
      task_id: z.string().describe('Task identifier (the taskID from an async operation response, in path).'),
    },
    pathParams: ['task_id'],
  });

  // ────────────────────────────── Sandbox: v1 announcements/parcels ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_v1_cancel_announcement',
    title: 'Delivery: cancel announcement [sandbox v1]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX v1] Starts the process of cancelling a test announcement; on success the response has a success status. Available ' +
      'only in the Sandbox, for delivery-service partners. Unlike delivery_cancel_announcement_3pl (production /cancelAnnouncement), ' +
      'this is the test v1 contract with a required options field.',
    method: 'POST',
    path: '/delivery-sandbox/v1/cancelAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: z.string().describe('Identifier of the test announcement to cancel.'),
      date: z.string().describe('Event date and time in ISO 8601 (RFC 3339) format.'),
      options: opaque('Options').describe('Additional announcement-cancellation options.'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'date', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_cancel_parcel',
    title: 'Delivery: cancel parcel [sandbox v1]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX v1] Cancels a test parcel: initiates an acceptance prohibition at the delivery service and, if it took effect, cancels the parcel. ' +
      'Only parcels created via delivery_create_sandbox_parcel_v2 can be cancelled. Available only in the Sandbox. ' +
      'Unlike delivery_sandbox_cancel_parcel (actor field), this is the v1 contract with an options field.',
    method: 'POST',
    path: '/delivery-sandbox/v1/cancelParcel',
    domain: 'delivery',
    input: {
      parcelID: z.string().describe('Identifier of the test parcel to cancel.'),
      options: opaque('Options').optional().describe('Additional cancellation options (optional).'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_change_parcel',
    title: 'Delivery: change parcel [sandbox v1]',
    risk: 'write',
    description:
      '[SANDBOX v1] Creates a request to change the data of a single test parcel (for example, the receiver\'s full name/phone). ' +
      'Available only in the Sandbox. Request status — via delivery_v1_get_change_parcel_info. Unlike ' +
      'delivery_change_parcels (bulk processing), it changes a single parcel.',
    method: 'POST',
    path: '/delivery-sandbox/v1/changeParcel',
    domain: 'delivery',
    input: {
      parcelID: z.string().describe('Identifier of the test parcel to change.'),
      type: z
        .string()
        .describe('Request type. Enum: changeReceiver | prohibitParcelReceive | extendParcelStorage | prohibitParcelAcceptance.'),
      application: opaque('Application').optional().describe('Change-request data (depends on type, optional).'),
      options: opaque('Options').optional().describe('Additional request options (optional).'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'type', 'application', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_create_announcement',
    title: 'Delivery: create announcement [sandbox v1]',
    risk: 'write',
    description:
      '[SANDBOX v1] Starts the process of creating a test announcement; on success the response has a success status. Available ' +
      'only in the Sandbox, for delivery-service partners. Unlike delivery_sandbox_create_announcement, this is the v1 contract ' +
      'with a required options field.',
    method: 'POST',
    path: '/delivery-sandbox/v1/createAnnouncement',
    domain: 'delivery',
    input: {
      announcementID: z.string().describe('Identifier of the announcement to create.'),
      announcementType: z.string().describe('Announcement type. Enum: DELIVERY | PICKUP.'),
      barcode: z.string().describe('Unique announcement barcode (printed on the acceptance/handover act).'),
      date: z.string().describe('Announcement creation date and time in ISO 8601 (RFC 3339) format, UTC.'),
      options: opaque('Options').describe('Additional announcement options.'),
      packages: z.array(opaque('Package')).describe('List of cargo units.'),
      receiver: opaque('Receiver').describe('Receiving delivery service: type, name, phones, email, delivery node/sorting center.'),
      sender: opaque('Sender').describe('Sending party: type, name, phones, email, sending node.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['announcementID', 'announcementType', 'barcode', 'date', 'options', 'packages', 'receiver', 'sender'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_announcement_event',
    title: 'Delivery: announcement event [sandbox v1]',
    risk: 'read',
    description:
      '[SANDBOX v1] Returns the last registered event for a test announcement — makes it easier to debug ' +
      'announcement-tracking integration. Available only in the Sandbox, for delivery-service partners.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getAnnouncementEvent',
    domain: 'delivery',
    input: { announcementID: z.string().describe('Test announcement identifier.') },
    body: { contentType: 'application/json', fields: ['announcementID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_change_parcel_info',
    title: 'Delivery: change request info [sandbox v1]',
    risk: 'read',
    description:
      '[SANDBOX v1] Returns information about a test-parcel change request by its applicationID (the request ' +
      'is created via delivery_v1_change_parcel). Available only in the Sandbox, for delivery-service partners.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getChangeParcelInfo',
    domain: 'delivery',
    input: { applicationID: z.string().describe('Identifier of the parcel change request.') },
    body: { contentType: 'application/json', fields: ['applicationID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_parcel_info',
    title: 'Delivery: parcel info [sandbox v1]',
    risk: 'read',
    description:
      '[SANDBOX v1] Returns information about a test parcel by parcelID. Available only in the Sandbox; works ' +
      'only with parcels created via delivery_create_sandbox_parcel_v2.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getParcelInfo',
    domain: 'delivery',
    input: { parcelID: z.string().describe('Test parcel identifier.') },
    body: { contentType: 'application/json', fields: ['parcelID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_get_registered_parcel_id',
    title: 'Delivery: parcel ID by orderID [sandbox v1]',
    risk: 'read',
    description:
      '[SANDBOX v1] Returns the parcelID of a registered test parcel by its orderID. Works only with ' +
      'parcels created via delivery_create_sandbox_parcel_v2. Available only in the Sandbox.',
    method: 'POST',
    path: '/delivery-sandbox/v1/getRegisteredParcelID',
    domain: 'delivery',
    input: { orderID: z.string().describe('Order identifier of the test parcel.') },
    body: { contentType: 'application/json', fields: ['orderID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_create_sandbox_parcel_v2',
    title: 'Delivery: create parcel [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX v2] Starts the process of creating a test parcel in the Sandbox. The created parcel is then used by ' +
      'other v1 methods (getParcelInfo, getRegisteredParcelID, changeParcel, cancelParcel). Unlike ' +
      'delivery_create_parcel ([3PL], production creation), this is a test environment with no consequences.',
    method: 'POST',
    path: '/delivery-sandbox/v2/createParcel',
    domain: 'delivery',
    input: {
      items: z.array(opaque('Item')).optional().describe('Parcel contents — items (optional).'),
      options: opaque('Options').optional().describe('Additional test-parcel options (optional).'),
      receiver: opaque('Receiver').optional().describe('Receiver: full name, phone, address/pickup-point code (optional).'),
      sender: opaque('Sender').optional().describe('Sender: details and sending node (optional).'),
      tags: z.array(z.string()).optional().describe('Test-parcel tags for Sandbox scenarios (optional).'),
    },
    body: { contentType: 'application/json', fields: ['items', 'options', 'receiver', 'sender', 'tags'] },
  });

  // ────────────────────────────── Production (non-sandbox) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_change_parcel_result',
    title: 'Delivery: parcel change result',
    risk: 'write',
    description:
      '[3PL] Sends Avito the outcome of a parcel change request previously sent via ' +
      'delivery_change_parcels: the delivery service reports whether the request was approved (approved) or rejected (declined). ' +
      'A production method on the delivery-service side — on a regular seller account it returns 403/404.',
    method: 'POST',
    path: '/delivery/order/changeParcelResult',
    domain: 'delivery',
    input: {
      id: z.string().describe('Identifier of the parcel change request.'),
      status: z.string().describe('Request processing status. Enum: approved | declined.'),
      reason: z.string().optional().describe('Rejection reason; filled in when status=declined (optional).'),
      options: opaque('Options').optional().describe('Additional result options (optional).'),
    },
    body: { contentType: 'application/json', fields: ['id', 'status', 'reason', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_change_parcels',
    title: 'Delivery: bulk update [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Sends the delivery service a batch of requests to update parcel properties on Avito\'s initiative ' +
      '(a bulk operation). The delivery service returns the result for each request via delivery_change_parcel_result. ' +
      'The method is implemented on the delivery-service side, for delivery-service partners only.',
    method: 'POST',
    path: '/sandbox/changeParcels',
    domain: 'delivery',
    input: {
      applications: z.array(opaque('Application')).describe('Array of parcel change requests (one per parcel).'),
      type: z
        .string()
        .describe('Request type. Enum: changeReceiver | extendParcelStorage | prohibitParcelReceive | prohibitParcelAcceptance | changeReceiverTerminalOnConfirmed.'),
    },
    body: { contentType: 'application/json', fields: ['applications', 'type'] },
  });
};
