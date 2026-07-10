/**
 * Domain `delivery` — swaggers/delivery.json (31 endpoints, the largest one).
 *
 * This is a B2B partner logistics API (only for delivery-service partners).
 * You won't be able to call most of these methods from a regular account.
 *
 * Quirks:
 *   - The `checkConfirmationCode` operationId collides with the same-named one in orders.json.
 *     Uniqueness is ensured via the domain prefix.
 *   - Most of the paths under /delivery-sandbox/ are intentionally test-environment endpoints
 *     for delivery-service partners; on a production account they return 403/404 for regular users.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

const nonEmptyString = z.string().min(1);
const compatibleIntPathId = z.union([
  z.number().int(),
  z.string().regex(/^-?\d+$/, 'Expected a decimal integer string'),
]);
const dateTime = nonEmptyString;
const propertyAccuracy = z.enum(['EXACT', 'APPROXIMATE']);

const announcementDeliveryPoint = z.object({
  accuracy: propertyAccuracy.optional(),
  id: z.string().optional(),
  provider: nonEmptyString,
});

const announcementParticipant = z.object({
  delivery: z.object({
    sortingCenter: announcementDeliveryPoint.nullable().optional(),
    type: z.literal('SORTING_CENTER'),
  }),
  email: z.string().optional(),
  name: nonEmptyString,
  phones: z.array(nonEmptyString),
  type: z.literal('3PL'),
});

const announcementPackage = z.object({
  id: nonEmptyString,
  parcelIDs: z.array(nonEmptyString),
  sealID: z.string().optional(),
});

const announcementPackage3pl = z.object({
  id: nonEmptyString,
  parcels: z.array(
    z.object({
      barcode: nonEmptyString,
      id: nonEmptyString,
      senderBarcode: z.string().optional(),
      senderID: z.string().optional(),
    }),
  ),
  sealID: z.string().optional(),
});

const itemDimensions = z.object({
  accuracy: propertyAccuracy,
  values: z.array(z.number().int().min(1).max(200)).length(3),
});

const itemWeight = z.object({
  accuracy: propertyAccuracy,
  value: z.number().int().min(1).max(50_000),
});

const createParcelClient = z.object({
  delivery: z.object({
    completenessAndIntegrity: z.array(z.enum(['DIRECT_FLOW', 'RETURN_FLOW'])).optional(),
    courier: z
      .object({
        address: z.object({
          addressRow: nonEmptyString,
          coordinates: z.object({
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
          }),
          details: z.object({
            flat: z.string().optional(),
            floor: z.string().optional(),
            house: nonEmptyString,
            porch: z.string().optional(),
          }),
        }),
        dateTimeInterval: z.object({ end: dateTime, start: dateTime }),
        options: z
          .object({
            comment: z.string().optional(),
            deliveryConfirmationType: z.literal('PHONE'),
            deliveryType: z.enum(['DELIVERY_TO_DOOR', 'DELIVERY_TO_PORCH']),
            elevatorAvailable: z.boolean(),
          })
          .optional(),
        provider: nonEmptyString,
      })
      .optional(),
    secondPartyLogist: z.object({ provider: nonEmptyString }).optional(),
    sortingCenter: z
      .object({ accuracy: propertyAccuracy, id: nonEmptyString, provider: nonEmptyString })
      .optional(),
    terminal: z
      .object({ accuracy: propertyAccuracy, id: nonEmptyString, provider: nonEmptyString })
      .optional(),
    type: z.enum(['TERMINAL', 'SORTING_CENTER', 'COURIER']),
  }),
  email: z.string().email().max(320),
  inn: z.string().optional(),
  name: z.string().max(255),
  phones: z.array(nonEmptyString),
  type: z.enum(['PRIVATE', 'LEGAL', '3PL']),
});

const returnPolicy = z.object({
  action: z.enum([
    'DISABLED',
    'DESTROY',
    'RETURN_TO_DEPARTURE_POINT',
    'RETURN_TO_RECEIVER',
    'MOVE_TO_ON_DEMAND_STORAGE',
  ]),
  after: z.object({ unit: z.literal('DAY'), value: z.number().int().min(1) }).optional(),
});

const createParcelOptions = z.object({
  return: z
    .object({
      receiver: createParcelClient.optional(),
      refused: returnPolicy.optional(),
      returned: returnPolicy.optional(),
      unclaimed: returnPolicy.optional(),
    })
    .optional(),
  tags: z
    .array(
      z.enum(['C2C', 'B2C', 'X_DELIVERY', 'X_DELIVERY_FIRST_LEG', 'X_DELIVERY_LAST_LEG', 'RETURN']),
    )
    .optional(),
});

const createParcelItem = z.object({
  breadcrumbs: z.array(z.object({ name: z.string().max(255) })).optional(),
  cost: z.number().int(),
  description: z.string().max(1000).optional(),
  dimensions: itemDimensions.optional(),
  id: z.number().int(),
  imagesUrls: z.object({ list: z.array(z.string()), listing: z.string() }).optional(),
  quantity: z.number().int().min(1),
  tags: z.array(z.literal('TRY_ON')).optional(),
  title: z.string().max(100),
  weight: itemWeight.optional(),
});

const paymentStatus = z.enum(['PAID', 'ON_DELIVERY']);
const createParcelPayment = z.object({
  delivery: z.object({ costWithoutVat: z.number().int().min(0), status: paymentStatus }),
  items: z.object({ cost: z.number().int().min(0), status: paymentStatus }),
});

const schedule = z.object({
  mon: z.array(z.string()),
  tue: z.array(z.string()),
  wed: z.array(z.string()),
  thu: z.array(z.string()),
  fri: z.array(z.string()),
  sat: z.array(z.string()),
  sun: z.array(z.string()),
});

const restriction = z.object({
  dimensionalFactor: z.number().int().min(1000).max(100_000).optional(),
  maxDeclaredCost: z.number().int().min(1000).max(15_000_000),
  maxDimensionalWeight: z.number().int().min(1000).max(100_000_000_000).optional(),
  maxDimensions: z.array(z.number().int().min(0).max(3000)),
  maxWeight: z.number().int().min(1000).max(100_000_000_000),
});

const address = z.object({
  addressRow: z.string().optional(),
  building: z.string().optional(),
  country: nonEmptyString,
  fias: nonEmptyString,
  floor: z.number().int().optional(),
  house: z.string().optional(),
  housing: z.string().optional(),
  lat: z.number().min(41.1).max(81.8),
  lng: z.number().min(-180).max(180),
  locality: nonEmptyString,
  localityType: z.string().optional(),
  porch: z.string().optional(),
  region: nonEmptyString,
  room: z.string().optional(),
  street: z.string().optional(),
  subRegion: z.string().optional(),
  subRegionType: z.string().optional(),
  zipCode: nonEmptyString,
});

const cutoffAndSchedule = z.object({
  cutoff: z.object({
    cutoffTime: nonEmptyString,
    daysAfterCutoff: z.number().int(),
    daysBeforeCutoff: z.number().int(),
  }),
  regularSchedule: schedule,
});

const area = z.object({
  deliverySchedule: cutoffAndSchedule.optional(),
  directionTag: nonEmptyString,
  intakeSchedule: cutoffAndSchedule.optional(),
  providerAreaNumber: z.string().min(1).max(128),
  restrictions: restriction,
  services: z.array(z.enum(['intake', 'delivery'])),
  utcTimezone: nonEmptyString,
  zipCodes: z.array(nonEmptyString).min(1),
});

const sortingCenter = z.object({
  address,
  deliveryProviderId: z.string().max(64),
  directionTag: nonEmptyString,
  itinerary: z.string(),
  name: nonEmptyString,
  phones: z.array(z.string().regex(/^7[0-9]{10}$/)),
  photos: z.array(z.string()),
  restriction,
  schedule,
});

const terminal = sortingCenter.extend({
  displayName: z.string().optional(),
  options: z
    .array(
      z.enum(['fitting', 'electronics-checking', 'cod-by-card', 'cod-by-cash', 'multi-drop-off']),
    )
    .optional(),
  services: z.array(z.enum(['intake', 'delivery'])),
  type: z.enum(['PVZ', 'POSTAMAT']).optional(),
});

const termsZone = z.object({
  deliveryProviderZoneId: z.string().optional(),
  maxTerm: z.number().int().optional(),
  minTerm: z.number().int().optional(),
  name: z.string().optional(),
});

const tariffStepValue = z.object({
  cost: z.number().int().optional(),
  costPerStep: z.number().int().optional(),
  maxWeight: z.number().int().optional(),
  minWeight: z.number().int().optional(),
  step: z.number().int().optional(),
});

const tariffGapValue = z.object({
  cost: z.number().int().optional(),
  dimensionalFactor: z.number().int().optional(),
  maxDimensions: z.array(z.number().int()).optional(),
  maxWeight: z.number().int().optional(),
});

const tariffService = z.discriminatedUnion('calculationMechanic', [
  z.object({
    calculationMechanic: z.literal('GAP_TO_COST'),
    chargeableParameter: z.enum(['WEIGHT', 'DIMENSIONS', 'PAID_WEIGHT']),
    serviceName: z.enum(['DELIVERY', 'DELIVERY_B2C']),
    values: z.array(tariffGapValue),
  }),
  z.object({
    calculationMechanic: z.literal('WEIGHT_INTERVALS'),
    chargeableParameter: z.literal('WEIGHT'),
    serviceName: z.enum(['DELIVERY', 'DELIVERY_B2C']),
    values: z.array(tariffStepValue),
  }),
  z.object({
    calculationMechanic: z.literal('GAP_TO_PERCENT'),
    chargeableParameter: z.literal('DECLARED_COST'),
    serviceName: z.enum(['INSURANCE', 'INSURANCE_B2C']),
    values: z.array(
      z.object({
        maxDeclaredCost: z.number().int().optional(),
        percent: z.number().optional(),
      }),
    ),
  }),
  z.object({
    calculationMechanic: z.literal('WEIGHT_INTERVALS_WITH_MIN_COST'),
    chargeableParameter: z.enum(['WEIGHT', 'PAID_WEIGHT']),
    minCost: z.number().int(),
    serviceName: z.enum(['DELIVERY', 'DELIVERY_B2C']),
    values: z.array(tariffStepValue),
  }),
]);

const tariffZone = z.object({
  deliveryProviderZoneId: z.string().optional(),
  items: z.array(tariffService),
  name: nonEmptyString,
});

const direction = z.object({
  providerDirectionId: nonEmptyString,
  tagFrom: nonEmptyString,
  tagTo: nonEmptyString,
  zones: z.array(
    z.object({
      tariffZoneId: z.string().optional(),
      termsZoneId: z.string().optional(),
      type: z
        .enum([
          '0',
          '3',
          '4',
          '5',
          '6',
          'S-PUDO2S-PUDO',
          'S-AREA2S-AREA',
          'S-PUDO2S-AREA',
          'S-PUDO-BTW-F-HUB',
          'S-HUB-BTW-S-PUDO',
        ])
        .optional(),
    }),
  ),
});

const sandboxParticipantPoint = z.object({
  accuracy: propertyAccuracy.optional(),
  id: z.string().optional(),
  provider: nonEmptyString,
});

const sandboxParticipant = z.object({
  delivery: z.object({
    sortingCenter: sandboxParticipantPoint.optional(),
    terminal: sandboxParticipantPoint.optional(),
    type: z.enum(['TERMINAL', 'SORTING_CENTER']),
  }),
  email: z.string(),
  name: z.string(),
  phones: z.array(z.string()),
  type: z.enum(['3PL', 'ABD']),
});

const changeApplication = z.object({
  kind: z.enum(['buyer', 'seller']).optional(),
  name: z.string().optional(),
  phones: z.array(z.string()).optional(),
});

const sandboxParcelItem = z.object({
  breadcrumbs: z.array(z.object({ name: z.string().max(255) })).optional(),
  cost: z.number().int().optional(),
  description: z.string().optional(),
  dimensions: z.object({ values: z.array(z.number().int()).length(3).optional() }).optional(),
  quantity: z.number().int().min(1).max(10),
  tags: z.array(z.literal('TRY_ON')).optional(),
  title: z.string().optional(),
  weight: z.object({ value: z.number().int().optional() }).optional(),
});

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
      announcementID: z.string().uuid().describe('Announcement identifier (required).'),
      announcementType: z.enum(['DELIVERY', 'PICKUP']).describe('Announcement type.'),
      barcode: z
        .string()
        .describe(
          'Unique announcement barcode, printed on the acceptance/handover act. Example: 000987654321.',
        ),
      date: dateTime.describe('Announcement creation date and time in RFC 3339 format, UTC.'),
      packages: z.array(announcementPackage3pl).describe('List of cargo units (at least one).'),
      receiver: announcementParticipant.describe('Receiving party and sorting center.'),
      sender: announcementParticipant.describe('Sending party and sorting center.'),
    },
    body: {
      contentType: 'application/json',
      fields: [
        'announcementID',
        'announcementType',
        'barcode',
        'date',
        'packages',
        'receiver',
        'sender',
      ],
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
      announcementID: z
        .string()
        .uuid()
        .describe('Identifier of the announcement to cancel (required).'),
      reason: z
        .enum(['CANCELED_BY_DELIVERY_PROVIDER', 'CANCELED_BY_AVITO'])
        .optional()
        .describe('Cancellation reason (optional).'),
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
      items: z
        .array(createParcelItem)
        .min(1)
        .describe('Parcel contents (items); at least one element.'),
      sender: createParcelClient.describe('Sender and delivery point.'),
      receiver: createParcelClient.describe('Receiver and delivery point.'),
      payment: createParcelPayment.describe('Payment parameters for items and delivery.'),
      barcodes: z.array(z.string()).optional().describe('Parcel barcodes (optional).'),
      directOrderID: z
        .string()
        .optional()
        .describe('Direct order identifier at the delivery service (optional).'),
      options: createParcelOptions.optional().describe('Return and parcel-tag options (optional).'),
      package: z
        .object({ dimensions: itemDimensions, weight: itemWeight })
        .optional()
        .describe('Packaging dimensions and weight (optional).'),
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
    environment: 'sandbox',
    input: {
      announcementID: z.string().uuid().describe('Announcement identifier (required).'),
      announcementType: z.enum(['DELIVERY', 'PICKUP']).describe('Announcement type.'),
      barcode: z
        .string()
        .describe('Unique announcement barcode (printed on the acceptance/handover act).'),
      date: dateTime.describe('Announcement creation date and time in RFC 3339 format, UTC.'),
      packages: z.array(announcementPackage).describe('List of cargo units.'),
      receiver: announcementParticipant.describe('Receiving delivery service and sorting center.'),
      sender: announcementParticipant.describe('Sending delivery service and sorting center.'),
    },
    body: {
      contentType: 'application/json',
      fields: [
        'announcementID',
        'announcementType',
        'barcode',
        'date',
        'packages',
        'receiver',
        'sender',
      ],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_sandbox_track_announcement',
    title: 'Delivery: push announcement tracking event [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Appends one tracking event for an announcement from the delivery service; does not modify existing history — ' +
      'use it to simulate an announcement progressing (ACCEPTANCE_DONE → RECEIVED → DELIVERED, or CANCELLED). One call records one ' +
      'event (not idempotent — re-sending logs a duplicate). Returns an empty 200 on success. For delivery-service PARTNERS only. ' +
      'This is the announcement-level analogue of delivery_tracking (which reports parcel-level status events).',
    method: 'POST',
    path: '/delivery-sandbox/announcements/track',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      announcementID: z
        .string()
        .uuid()
        .describe('Identifier of the tracked announcement (required).'),
      date: dateTime.describe('Event date in RFC 3339 format, UTC.'),
      event: z
        .enum(['ACCEPTANCE_DONE', 'CANCELLED', 'DELIVERED', 'RECEIVED'])
        .describe('Event type.'),
    },
    body: { contentType: 'application/json', fields: ['announcementID', 'date', 'event'] },
  });

  // ────────────────────────────── Sandbox: areas & schedule ──────────────────────────────

  defineTool(server, ctx, {
    name: 'delivery_custom_area_schedule',
    title: 'Delivery: zone schedule [sandbox]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX] Sets the working schedule of a delivery zone for a specific day that differs from the regular schedule ' +
      '(for example, holidays/weekends). Re-uploading overwrites the previous schedule for those dates. ' +
      'For delivery-service partners only. The body is an array of schedules directly (no wrapper).',
    method: 'POST',
    path: '/delivery-sandbox/areas/custom-schedule',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      schedules: z
        .array(
          z.object({
            customSchedule: z.array(
              z.object({
                date: z.string(),
                intervals: z.array(z.string()),
              }),
            ),
            providerAreaNumber: z.array(z.string().min(1).max(128)),
            services: z.array(z.enum(['intake', 'delivery'])),
            useAllAreas: z.boolean().nullable().optional(),
          }),
        )
        .min(1)
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
      '[SANDBOX] Cancels a test parcel on behalf of the receiver (actor=receiver); returns a success status. Only parcels created via ' +
      'delivery_create_sandbox_parcel_v2 can be cancelled. Implemented on the delivery-service side, for delivery-service PARTNERS only. ' +
      'Unlike delivery_v1_cancel_parcel ([SANDBOX v1] with an options field), this is the base contract with an actor field.',
    method: 'POST',
    path: '/delivery-sandbox/cancelParcel',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      parcelID: nonEmptyString.describe('Identifier of the parcel to cancel (required).'),
      actor: z.literal('receiver').describe('The recipient initiates the cancellation.'),
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
    environment: 'sandbox',
    input: {
      parcelID: z.string().describe('Parcel identifier.'),
      confirmCode: z
        .string()
        .describe('Confirmation code presented by the buyer at the pickup point.'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'confirmCode'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_set_order_properties',
    title: 'Delivery: set parcel properties [sandbox]',
    risk: 'write',
    destructiveHint: true,
    description:
      "[SANDBOX] Sets a parcel's delivery parameters on Avito — e.g. the final delivery cost. " +
      'Idempotent by overwrite: each call REPLACES the previous values, so always send the complete current set, not a delta. ' +
      'Returns an empty 200 on success. For delivery-service PARTNERS only (not regular sellers). ' +
      'Sibling tools: delivery_set_order_real_address sets the pickup address, delivery_tracking pushes a status event — ' +
      'this one only sets cost/parameters.',
    method: 'POST',
    path: '/delivery-sandbox/order/properties',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      orderId: nonEmptyString.describe('Order identifier.'),
      properties: z
        .object({
          delivery: z
            .object({
              cost: z.number().int().min(0).optional(),
              directControlDate: z.string().optional(),
              receiverTerminalCode: z.string().optional(),
              returnControlDate: z.string().optional(),
              senderReceiveTerminalCode: z.string().optional(),
              toughWrap: z.boolean().optional(),
            })
            .optional(),
          dimensions: z.array(z.number().int().min(0).max(200)).optional(),
          weight: z.number().min(0).max(50_000).optional(),
        })
        .describe('Parcel delivery parameters.'),
    },
    body: { contentType: 'application/json', fields: ['orderId', 'properties'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_set_order_real_address',
    title: 'Delivery: actual address [sandbox]',
    risk: 'write',
    description:
      "[SANDBOX] Sends Avito the ACTUAL pickup point used for a parcel's acceptance/return — needed for agent and customer returns. " +
      'Returns an empty 200 on success. Sibling: delivery_set_order_properties sets cost/parameters; this one only sets the address. ' +
      'For delivery-service PARTNERS only (not regular sellers).',
    method: 'POST',
    path: '/delivery-sandbox/order/realAddress',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      orderId: nonEmptyString.describe('Order identifier.'),
      address: z
        .object({
          addressType: z.enum(['SENDER_SEND', 'SENDER_RECEIVE']),
          terminalNumber: z.string().max(64),
        })
        .describe('Actual pickup point for parcel acceptance or return.'),
    },
    body: { contentType: 'application/json', fields: ['orderId', 'address'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_tracking',
    title: 'Delivery: push tracking event [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX] Appends one parcel tracking event to Avito on behalf of the delivery service; does not modify existing history — ' +
      'a single status transition (e.g. RECEIVED_AT_TRANSIT_TERMINAL → IN_TRANSIT). Use this to report movement as it happens; ' +
      'one call records one event, and events accumulate into the parcel history (not idempotent — re-sending logs a duplicate). ' +
      "Returns an empty 200 on success; a 4xx means the order/status pair was rejected. Comply with Avito's retry policy on 5xx. " +
      'For delivery-service PARTNERS only (not regular sellers). Sibling tools: delivery_set_order_properties sets cost/parameters, ' +
      'delivery_change_parcels reschedules a parcel — this one only appends a status event.',
    method: 'POST',
    path: '/delivery-sandbox/order/tracking',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      orderId: nonEmptyString.describe('Order identifier.'),
      avitoEventType: z
        .string()
        .describe('Event code on the Avito side. Example: RECEIVED_AT_TRANSIT_TERMINAL.'),
      avitoStatus: z
        .enum([
          'CONFIRMED',
          'IN_TRANSIT',
          'ON_DELIVERY',
          'DELIVERED',
          'IN_TRANSIT_RETURN',
          'ON_DELIVERY_RETURN',
          'RETURNED',
          'LOST',
          'DESTROYED',
        ])
        .describe(
          'Parcel status. Enum: CONFIRMED | IN_TRANSIT | ON_DELIVERY | DELIVERED | IN_TRANSIT_RETURN | ' +
            'ON_DELIVERY_RETURN | RETURNED | LOST | DESTROYED.',
        ),
      date: dateTime.describe('Event date and time in RFC 3339 format, UTC.'),
      location: z.string().describe('Event locality in the nominative case. Example: Kazan.'),
      providerEventCode: z.string().describe('Event code as defined by the delivery service.'),
      comment: z.string().optional().describe('Comment on the status (optional).'),
      options: z
        .object({
          barcode: z.string().optional(),
          returnBarcode: z.string().optional(),
          returnDispatchNumber: z.string().optional(),
          returnTrackingNumber: z.string().optional(),
        })
        .optional()
        .describe('Additional status options: parcel barcode, return numbers (optional).'),
    },
    body: {
      contentType: 'application/json',
      fields: [
        'orderId',
        'avitoEventType',
        'avitoStatus',
        'date',
        'location',
        'providerEventCode',
        'comment',
        'options',
      ],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_prohibit_order_acceptance',
    title: 'Delivery: prohibit acceptance [sandbox]',
    risk: 'write',
    destructiveHint: true,
    description:
      '[SANDBOX] Prohibits the delivery service from accepting a parcel from the sender — the parcel will not be taken into processing. ' +
      'A step in the parcel-cancellation flow (pair with delivery_sandbox_cancel_parcel). Returns a success status. Implemented on the ' +
      'delivery-service side, for delivery-service PARTNERS only (a regular seller account gets 403/404).',
    method: 'POST',
    path: '/delivery-sandbox/prohibitOrderAcceptance',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      orderId: nonEmptyString.describe('Identifier of the order whose acceptance is prohibited.'),
    },
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
    environment: 'sandbox',
    input: {
      deliveryProviders: nonEmptyString.describe(
        'Delivery-provider code list in the API string format, for example "pochta,exmail".',
      ),
    },
    queryParams: ['deliveryProviders'],
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
    environment: 'sandbox',
    input: {
      centers: z
        .array(sortingCenter)
        .min(1)
        .describe(
          'Array of sorting centers: deliveryProviderId, name, address, phones, itinerary, photos, directionTag, schedule, restriction.',
        ),
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
    environment: 'sandbox',
    input: {
      tariff_id: compatibleIntPathId.describe(
        'Tariff identifier (int32, in path); legacy decimal strings remain accepted.',
      ),
      areas: z
        .array(area)
        .min(1)
        .describe(
          'Array of areas: directionTag, providerAreaNumber, services (intake/delivery), utcTimezone, zipCodes, restrictions.',
        ),
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
    environment: 'sandbox',
    input: {
      tariff_id: compatibleIntPathId.describe(
        'Tariff identifier (int32, in path); legacy decimal strings remain accepted.',
      ),
      tagged: z
        .array(
          z.object({
            deliveryProviderId: z.object({
              deliveryProviderId: z.string().max(64).optional(),
              provider: z.string().min(1).max(128).optional(),
            }),
            directionTag: nonEmptyString,
          }),
        )
        .min(1)
        .describe(
          'Array of bindings: deliveryProviderId (sorting-center ID at the provider) + directionTag (direction tag).',
        ),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.tagged as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_terminals_sandbox',
    title: 'Delivery: upload pickup points [sandbox]',
    risk: 'write',
    destructiveHint: true,
    description:
      "Replaces the tariff's terminal set. [SANDBOX] Uploads terminals (pickup points / parcel lockers) for one tariff. " +
      'Auto-approves on accept (200); when a high share of the changes are critical the upload is queued for manual review instead. ' +
      'For delivery-service PARTNERS only. The request body is the terminals array directly (the tool wraps it for you).',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/terminals',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      tariff_id: compatibleIntPathId.describe(
        'Tariff identifier (int32, in path); legacy decimal strings remain accepted.',
      ),
      terminals: z
        .array(terminal)
        .min(1)
        .describe(
          'Array of pickup points: deliveryProviderId, name, address, phones, services (intake/delivery), schedule, type (PVZ|POSTAMAT, default PVZ).',
        ),
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
      "delivery_get_task. Important: the list of new terms must fully match the tariff's deliveryProviderZoneId " +
      'values. For delivery-service partners only. The body is an array of zones directly.',
    method: 'POST',
    path: '/delivery-sandbox/tariffs/{tariff_id}/terms',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      tariff_id: compatibleIntPathId.describe(
        'Tariff identifier (int32, in path); legacy decimal strings remain accepted.',
      ),
      zones: z
        .array(termsZone)
        .min(1)
        .describe(
          'Array of delivery-term zones: deliveryProviderZoneId, name, minTerm/maxTerm (business days).',
        ),
    },
    pathParams: ['tariff_id'],
    body: { contentType: 'application/json', transform: (b) => (b.zones as unknown[]) ?? [] },
  });

  defineTool(server, ctx, {
    name: 'delivery_add_tariff_sandbox_v2',
    title: 'Delivery: upload tariff [sandbox]',
    risk: 'write',
    destructiveHint: true,
    description:
      'Creates or replaces a tariff. [SANDBOX v2] Uploads a tariff so the delivery service controls direction availability, ' +
      'delivery cost and terms. Returns 200 on accept. Limits: body up to 400MB, up to 1 million directions. For delivery-service ' +
      'PARTNERS only. Prefer this v2 over any v1 tariff endpoint. Pair with delivery_update_terms (term zones) and ' +
      'delivery_add_terminals_sandbox (pickup points) to complete the tariff.',
    method: 'POST',
    path: '/delivery-sandbox/tariffsV2',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      name: z.string().describe('Human-readable tariff name (for the UI).'),
      deliveryProviderTariffId: z
        .string()
        .describe('Tariff identifier on the delivery-service side.'),
      directions: z
        .array(direction)
        .describe(
          'Directions: directionTagFrom→directionTagTo link, tariff zone, minTerm/maxTerm (business days).',
        ),
      tariffZones: z
        .array(tariffZone)
        .describe(
          'Tariff zones: name, deliveryProviderTariffZoneId, items (per-service price calculation models).',
        ),
      termsZones: z
        .array(termsZone)
        .describe(
          'Delivery-term zones: deliveryProviderZoneId, name, minTerm/maxTerm (business days).',
        ),
      tariffType: z.enum(['MGT', 'KGT']).optional().describe('Tariff type (optional).'),
    },
    body: {
      contentType: 'application/json',
      fields: [
        'name',
        'deliveryProviderTariffId',
        'directions',
        'tariffZones',
        'termsZones',
        'tariffType',
      ],
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
    environment: 'sandbox',
    input: {
      task_id: compatibleIntPathId.describe(
        'Task identifier (int32, in path); legacy decimal strings remain accepted.',
      ),
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
    environment: 'sandbox',
    input: {
      announcementID: z.string().describe('Identifier of the test announcement to cancel.'),
      date: z.string().describe('Event date and time in ISO 8601 (RFC 3339) format.'),
      options: z
        .object({ urlToCancelAnnouncement: nonEmptyString })
        .describe('Callback URL used to cancel the announcement.'),
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
    environment: 'sandbox',
    input: {
      parcelID: z.string().describe('Identifier of the test parcel to cancel.'),
      options: z
        .object({ cancelationUrl: z.string().optional() })
        .optional()
        .describe('Additional cancellation options (optional).'),
    },
    body: { contentType: 'application/json', fields: ['parcelID', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_change_parcel',
    title: 'Delivery: change parcel [sandbox v1]',
    risk: 'write',
    description:
      "[SANDBOX v1] Creates a request to change ONE test parcel's data (e.g. the receiver's name/phone), per the type enum " +
      '(changeReceiver / prohibitParcelReceive / extendParcelStorage / prohibitParcelAcceptance). The call only QUEUES the request — ' +
      'poll delivery_v1_get_change_parcel_info for the outcome. For bulk changes use delivery_change_parcels instead. ' +
      'Sandbox-only, for delivery-service PARTNERS.',
    method: 'POST',
    path: '/delivery-sandbox/v1/changeParcel',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      parcelID: z.string().describe('Identifier of the test parcel to change.'),
      type: z
        .enum([
          'changeReceiver',
          'prohibitParcelReceive',
          'extendParcelStorage',
          'prohibitParcelAcceptance',
        ])
        .describe('Request type.'),
      application: changeApplication.optional().describe('Receiver change data (optional).'),
      options: z
        .object({ changeParcelUrl: z.string().optional() })
        .optional()
        .describe('Additional request options (optional).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['parcelID', 'type', 'application', 'options'],
    },
  });

  defineTool(server, ctx, {
    name: 'delivery_v1_create_announcement',
    title: 'Delivery: create announcement [sandbox v1]',
    risk: 'write',
    description:
      '[SANDBOX v1] Creates a test shipment announcement in the Sandbox (no real-world effect); returns a success status. ' +
      'Use the base contract delivery_sandbox_create_announcement unless you specifically need this v1 shape — the only difference ' +
      'is that v1 additionally requires the options field. Sandbox-only, for delivery-service PARTNERS.',
    method: 'POST',
    path: '/delivery-sandbox/v1/createAnnouncement',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      announcementID: z.string().describe('Identifier of the announcement to create.'),
      announcementType: z.enum(['DELIVERY', 'PICKUP']).describe('Announcement type.'),
      barcode: z
        .string()
        .describe('Unique announcement barcode (printed on the acceptance/handover act).'),
      date: z
        .string()
        .describe('Announcement creation date and time in ISO 8601 (RFC 3339) format, UTC.'),
      options: z
        .object({ urlToSendAnnouncement: nonEmptyString })
        .describe('Announcement callback options.'),
      packages: z.array(announcementPackage).describe('List of cargo units.'),
      receiver: sandboxParticipant.describe('Receiving delivery service and delivery point.'),
      sender: sandboxParticipant.describe('Sending delivery service and delivery point.'),
    },
    body: {
      contentType: 'application/json',
      fields: [
        'announcementID',
        'announcementType',
        'barcode',
        'date',
        'options',
        'packages',
        'receiver',
        'sender',
      ],
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
    environment: 'sandbox',
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
    environment: 'sandbox',
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
    environment: 'sandbox',
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
    environment: 'sandbox',
    input: { orderID: z.string().describe('Order identifier of the test parcel.') },
    body: { contentType: 'application/json', fields: ['orderID'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_create_sandbox_parcel_v2',
    title: 'Delivery: create parcel [sandbox]',
    risk: 'write',
    description:
      '[SANDBOX v2] Creates a test parcel in the Sandbox (no real-world effect) and returns its parcelID — the entry point for the ' +
      'sandbox parcel lifecycle: feed that id into delivery_v1_get_parcel_info, delivery_v1_get_registered_parcel_id, ' +
      'delivery_v1_change_parcel and delivery_v1_cancel_parcel. Unlike delivery_create_parcel ([3PL] production creation), this has ' +
      'no consequences. For delivery-service PARTNERS testing only.',
    method: 'POST',
    path: '/delivery-sandbox/v2/createParcel',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      items: z.array(sandboxParcelItem).optional().describe('Parcel contents (optional).'),
      options: z
        .object({ registrationUrl: z.string().optional() })
        .optional()
        .describe('Additional test-parcel options (optional).'),
      receiver: z
        .object({
          delivery: z
            .object({
              courier: z
                .object({
                  address: z
                    .object({
                      addressRow: z.string(),
                      coordinates: z.object({
                        latitude: z.number().min(-90).max(90),
                        longitude: z.number().min(-180).max(180),
                      }),
                      details: z.object({
                        flat: z.string(),
                        floor: z.string(),
                        house: z.string(),
                        porch: z.string(),
                      }),
                    })
                    .optional(),
                  dateTimeInterval: z.object({ end: dateTime, start: dateTime }).optional(),
                  options: z
                    .object({
                      comment: z.string().optional(),
                      elevatorAvailable: z.boolean().optional(),
                    })
                    .optional(),
                })
                .optional(),
              terminal: z.object({ id: z.string().optional() }).optional(),
            })
            .optional(),
        })
        .optional()
        .describe('Receiver delivery options (optional).'),
      sender: z
        .object({
          delivery: z
            .object({ terminal: z.object({ id: z.string().optional() }).optional() })
            .optional(),
          inn: z.string().optional(),
        })
        .optional()
        .describe('Sender and departure terminal (optional).'),
      tags: z
        .array(z.string())
        .optional()
        .describe('Test-parcel tags for Sandbox scenarios (optional).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['items', 'options', 'receiver', 'sender', 'tags'],
    },
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
      status: z.enum(['approved', 'declined']).describe('Request processing status.'),
      reason: z
        .string()
        .optional()
        .describe('Rejection reason; filled in when status=declined (optional).'),
      options: z
        .object({ storageExtendedTo: dateTime.optional() })
        .nullable()
        .optional()
        .describe('Additional result options (optional).'),
    },
    body: { contentType: 'application/json', fields: ['id', 'status', 'reason', 'options'] },
  });

  defineTool(server, ctx, {
    name: 'delivery_change_parcels',
    title: 'Delivery: bulk update [sandbox]',
    risk: 'write',
    description:
      "[SANDBOX] Queues a BATCH of parcel-property change requests on Avito's initiative (changeReceiver / extendParcelStorage / " +
      'prohibitParcelReceive / prohibitParcelAcceptance / changeReceiverTerminalOnConfirmed, per the type enum). Use it for bulk ' +
      'changes; for a single parcel use delivery_v1_change_parcel. The call only QUEUES the requests — the delivery service reports ' +
      'each outcome back via delivery_change_parcel_result. Implemented on the delivery-service side, for delivery-service PARTNERS ' +
      'only (a regular seller account gets 403/404).',
    method: 'POST',
    path: '/sandbox/changeParcels',
    domain: 'delivery',
    environment: 'sandbox',
    input: {
      applications: z
        .array(
          z.object({
            id: nonEmptyString,
            parcelID: nonEmptyString,
            receiver: z
              .object({
                name: z.string().max(255),
                phones: z.array(nonEmptyString),
                terminal: z.object({ id: nonEmptyString }).optional(),
              })
              .optional(),
          }),
        )
        .describe('Array of parcel change requests (one per parcel).'),
      type: z
        .enum([
          'changeReceiver',
          'extendParcelStorage',
          'prohibitParcelReceive',
          'prohibitParcelAcceptance',
          'changeReceiverTerminalOnConfirmed',
        ])
        .describe('Request type.'),
    },
    body: { contentType: 'application/json', fields: ['applications', 'type'] },
  });
};
