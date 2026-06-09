/**
 * Domain `promotion` — swaggers/promotion.json (7 endpoints).
 * BBIP = "big budget integrated promotion" — Avito's bundled promotion services.
 *
 * ⚠️ Write: create_bbip_order — a REAL PURCHASE of promotion that spends money from the balance.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

// Actual Avito BBIP contract: both forecasts (BbipForecastRequestByItemV1) and create
// (BbipOrderByItemV1) require the SAME set of itemId+duration+oldPrice+price.
// Values come from promotion_get_bbip_suggests_by_items_v1: budgets[].{oldPrice,price}
// (kopecks/day) and duration.recommended (days). Avito does NOT accept the `budget` field —
// that caused the error "Failed to find a promotion budget for the given parameters" (v0.7.1 fixed
// only create; v0.7.2 also fixes forecasts, which mistakenly sent {itemId, budget}).
const BbipOrderItem = z
  .object({
    itemId: z.number().int().positive().describe('Avito listing ID (int64) for which promotion is being enabled.'),
    duration: z
      .number()
      .int()
      .positive()
      .describe(
        'Promotion duration in DAYS. Use suggests.duration.recommended (typically 5–7); ' +
          'the allowed range is suggests.duration.from..to.',
      ),
    oldPrice: z
      .number()
      .int()
      .positive()
      .describe(
        'Total value of one DAY of promotion in KOPECKS (before discounts/offers). ' +
          'Taken from suggests budgets[].oldPrice. Full price for the period = price × duration.',
      ),
    price: z
      .number()
      .int()
      .positive()
      .describe(
        'Cost of one DAY of promotion in KOPECKS (to be charged). ' +
          'Taken from suggests budgets[].price. Full budget = price × duration.',
      ),
  })
  .passthrough();

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'promotion_get_bbip_forecasts_by_items_v1',
    title: 'BBIP: forecast effect',
    risk: 'read',
    description:
      'Returns the forecast effect of BBIP promotion (listing promotion bid/budget): expected increase in ' +
      'views (min/max) and total cost for the period. READ-ONLY: spends NO money; use BEFORE ' +
      'promotion_create_bbip_order_for_items_v1 to estimate the return. For each listing pass ' +
      '{itemId, duration, oldPrice, price} — the same values as for create; take them from ' +
      'promotion_get_bbip_suggests_by_items_v1 (budgets[].{oldPrice,price} — kopecks/day, duration.recommended — days). ' +
      'Returns items[].{min,max,totalPrice} (kopecks) and an overall totalPrice.',
    method: 'POST',
    path: '/promotion/v1/items/services/bbip/forecasts/get',
    domain: 'promotion',
    input: {
      items: z
        .array(BbipOrderItem)
        .min(1)
        .max(100)
        .describe(
          '1 to 100 listings to forecast. Each element is {itemId, duration, oldPrice, price}, ' +
            'with values taken from promotion_get_bbip_suggests_by_items_v1.',
        ),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_bbip_suggests_by_items_v1',
    title: 'BBIP: budget suggestions',
    risk: 'read',
    description:
      'Returns recommended BBIP promotion bid/budget options for the listings. READ-ONLY: spends NO money. ' +
      'This is the first step of the BBIP flow: from the response take items[].budgets[].{oldPrice,price} (kopecks/day, ' +
      'isRecommended flags the recommended one) and items[].duration.{from,to,recommended} (days), then pass ' +
      'them to promotion_get_bbip_forecasts_by_items_v1 (forecast) and promotion_create_bbip_order_for_items_v1 (paid purchase).',
    method: 'POST',
    path: '/promotion/v1/items/services/bbip/suggests/get',
    domain: 'promotion',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .optional()
        .describe('Avito listing IDs (int64) for which budget options are needed. Up to 100.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_create_bbip_order_for_items_v1',
    title: '⚠️ BBIP: buy promotion',
    risk: 'money',
    description:
      '⚠️ PAID ACTION (money): creates a BBIP order to enable promotion for listings and CHARGES the budget ' +
      'from the account balance. The order is created only if there are no errors across all listings; if funds are insufficient — 402. ' +
      'FIRST estimate the cost and return for free: promotion_get_bbip_suggests_by_items_v1 (budget options) → ' +
      'promotion_get_bbip_forecasts_by_items_v1 (forecast). Then for each listing pass an option from ' +
      'suggests as {itemId, duration, oldPrice, price} (oldPrice/price — kopecks/day, duration — days; full budget = ' +
      'price × duration). Returns orderId (UUID) — check its status via promotion_get_order_status_v1.',
    method: 'PUT',
    path: '/promotion/v1/items/services/bbip/orders/create',
    domain: 'promotion',
    input: {
      items: z
        .array(BbipOrderItem)
        .min(1)
        .max(100)
        .describe(
          '1 to 100 listings for paid promotion. Each element is {itemId, duration, oldPrice, price} ' +
            'from promotion_get_bbip_suggests_by_items_v1. The whole order is rejected if any listing has an error.',
        ),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_dict_of_services_v1',
    title: 'Promotion: service dictionary',
    risk: 'read',
    description:
      'Returns a dictionary of all Avito promotion service types: for each service — slug (type identifier), ' +
      'name and isDeprecated (whether it is deprecated). READ-ONLY: spends NO money and requires no parameters. ' +
      'Use it as a reference to resolve slugs in the responses of other promotion methods.',
    method: 'POST',
    path: '/promotion/v1/items/services/dict',
    domain: 'promotion',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'promotion_get_services_by_items_v1',
    title: 'Promotion: services by listings',
    risk: 'read',
    description:
      'Returns active promotion services for the specified listings: for each listing, a list of services with ' +
      'slug, name and startDate/endDate dates. READ-ONLY: spends NO money. Use it to find out which ' +
      'promotion is already enabled and until what date it is active (not to be confused with suggests, which propose new budget options).',
    method: 'POST',
    path: '/promotion/v1/items/services/get',
    domain: 'promotion',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .optional()
        .describe('Avito listing IDs (int64) for which active promotion services are needed. Up to 100.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_list_orders_by_user_v1',
    title: 'Promotion: list orders',
    risk: 'read',
    description:
      'Returns a paginated list of the current user\'s promotion orders: id (UUID), createdAt and ' +
      'status of each order. READ-ONLY: spends NO money. Use it for order history/overview; the detailed status ' +
      'of a specific order is available via promotion_get_order_status_v1 by its orderId.',
    method: 'POST',
    path: '/promotion/v1/items/services/orders/get',
    domain: 'promotion',
    input: {
      pagination: z
        .object({
          page: z.number().int().min(1).optional().describe('Page number, starting from 1 (default 1).'),
          perPage: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Number of records per page, 1–100 (default 20). The field name is strictly camelCase.'),
        })
        .passthrough()
        .optional()
        .describe('Pagination parameters {page, perPage}. Can be omitted — the first page is returned.'),
    },
    body: { contentType: 'application/json', fields: ['pagination'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_order_status_v1',
    title: 'Promotion: order status',
    risk: 'read',
    description:
      'Returns the status of a BBIP order by its orderId: the order\'s overall status (initialized/waiting/in_process/processed), ' +
      'totalPrice (kopecks) and a per-item status for each listing (slug, price, errorReason). READ-ONLY: spends NO money. ' +
      'Call it AFTER promotion_create_bbip_order_for_items_v1 to track the order\'s execution.',
    method: 'POST',
    path: '/promotion/v1/items/services/orders/status',
    domain: 'promotion',
    input: {
      orderId: z
        .string()
        .describe('Promotion order identifier in UUID format, obtained from promotion_create_bbip_order_for_items_v1.'),
    },
    body: { contentType: 'application/json', fields: ['orderId'] },
  });
};
