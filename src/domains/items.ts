/**
 * `items` domain — corresponds to swaggers/items.json
 *
 * 11 endpoints. The core valuable domain for an AI agent: reading listings, price, VAS, statistics.
 *
 * Quirks:
 *   - Some paths use {userId} (camelCase), others use {user_id}.
 *     ToolSpec.injectProfileId supports both variants; in input it is always passed explicitly as `user_id`/`userId`.
 *   - GET /core/v1/items has no documented query params in swagger — in practice it accepts per_page/page/category/status.
 *     We add them as optional and document them in the description.
 *   - PUT /core/v2/items/{itemId}/vas/ — the only path with {itemId} (camelCase).
 *
 * ⚠️ Write methods actually affect the production account:
 *   - updatePrice — changes the listing price
 *   - putItemVas, putItemVasPackageV2, applyVas — purchase paid services (spends money)
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── READ-ONLY ──────────────────────────────

  defineTool(server, ctx, {
    name: 'items_get_items_info',
    title: 'List listings',
    risk: 'read',
    description:
      'Returns a LIST of the authenticated user\'s listings (get_items_info) — id, status, category, link on the site. ' +
      'Read-only, changes nothing. Use it to find listing ids and get an overview; for details on a single listing, use items_get_item_info. ' +
      'Supports pagination (page + per_page) and filters (status, category, updatedAtFrom). ' +
      'Limit: 25 requests/min. Does not work with employees\' listings — for those (under the main account or as an authenticated employee) it returns an empty list.',
    method: 'GET',
    path: '/core/v1/items',
    domain: 'core',
    input: {
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Page size: how many listings to return per request (1–100). If omitted, the server picks a default value.'),
      page: z.number().int().min(1).optional().describe('Pagination page number, starting from 1.'),
      status: z
        .string()
        .regex(/^(active|removed|old|blocked|rejected)(,(active|removed|old|blocked|rejected))*$/)
        .optional()
        .describe('One status or a comma-separated list: active, removed, old, blocked, rejected. Example: "active,old".'),
      category: z.number().int().optional().describe('Numeric Avito category ID to filter listings by category.'),
      updatedAtFrom: z
        .string()
        .optional()
        .describe('Filter: return only listings updated no earlier than this date (ISO 8601, e.g. "2026-05-01").'),
    },
    queryParams: ['per_page', 'page', 'status', 'category', 'updatedAtFrom'],
  });

  defineTool(server, ctx, {
    name: 'items_get_item_info',
    title: 'Listing details',
    risk: 'read',
    description:
      'Returns detailed information about a SINGLE listing (get_item_info) — status, price, address, list of applied VAS services, etc. ' +
      'Read-only. Use it when the item_id is already known; for a list of listings, use items_get_items_info, and for view/contact statistics, use items_post_item_stats_shallow (this method does not return statistics). ' +
      'Limit: 500 requests/min.',
    method: 'GET',
    path: '/core/v1/accounts/{user_id}/items/{item_id}/',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID of the Avito listing to get details for.'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('ID of the user who owns the listing. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id', 'item_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'items_post_calls_stats',
    title: 'Call statistics',
    risk: 'read',
    description:
      'Returns aggregated CALL statistics for listings over a period (post_calls_stats) — total/new/answered/new answered, broken down by day. ' +
      'Read-only analytics, changes nothing and spends nothing. The period is set by dateFrom..dateTo (YYYY-MM-DD). ' +
      'Without itemIds — across all of the user\'s listings. For views/contacts, use items_post_item_stats_shallow.',
    method: 'POST',
    path: '/core/v1/accounts/{user_id}/calls/stats/',
    domain: 'core',
    input: {
      dateFrom: z.string().describe('Start of the period, inclusive (YYYY-MM-DD).'),
      dateTo: z.string().describe('End of the period, inclusive (YYYY-MM-DD).'),
      itemIds: z
        .array(z.number().int().positive())
        .optional()
        .describe('List of listing IDs to filter by. Without it — statistics across all of the user\'s listings.'),
      user_id: z.number().int().positive().optional().describe('ID of the owner user. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['dateFrom', 'dateTo', 'itemIds'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_post_vas_prices',
    title: 'VAS service prices',
    risk: 'read',
    description:
      'Returns the cost of promotion services (VAS), available packages and stickers for the given listings (post_vas_prices). ' +
      'Read-only — does NOT purchase and does NOT spend money, only a price reference. ' +
      'Always call it BEFORE purchasing via items_apply_vas / items_put_item_vas to learn the current service slugs and their prices.',
    method: 'POST',
    path: '/core/v1/accounts/{userId}/vas/prices',
    domain: 'core',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe('List of listing IDs to get VAS prices and available services/stickers for (at least 1).'),
      userId: z.number().int().positive().optional().describe('ID of the owner user. Defaults to Profile_id from .env.'),
    },
    pathParams: ['userId'],
    injectProfileId: 'userId',
    body: {
      contentType: 'application/json',
      fields: ['itemIds'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_post_item_stats_shallow',
    title: 'Listing statistics',
    risk: 'read',
    description:
      'Returns counters (shallow statistics) for a list of listings over a period (post_item_stats_shallow / itemStatsShallow): unique views, contacts, favorites added. ' +
      'Read-only analytics. Use it for metrics on specific item_ids grouped by day/week/month; for extended profile analytics with filters and sorting, use items_post_item_analytics, and for calls, use items_post_calls_stats. ' +
      'Limits: no more than 200 listings per request, depth no more than 270 days back.',
    method: 'POST',
    path: '/stats/v1/accounts/{user_id}/items',
    domain: 'stats',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(200)
        .describe('List of listing IDs to get counters for (from 1 to 200 per request).'),
      dateFrom: z.string().describe('Start of the period, inclusive (YYYY-MM-DD); no more than 270 days back.'),
      dateTo: z.string().describe('End of the period, inclusive (YYYY-MM-DD).'),
      periodGrouping: z.enum(['day', 'week', 'month']).optional().describe('Group counters by period: day, week (by the first day of the week), month (by the first day of the month).'),
      fields: z
        .array(
          z.enum(['views', 'uniqViews', 'contacts', 'uniqContacts', 'favorites', 'uniqFavorites']),
        )
        .optional()
        .describe(
          'Which metrics to return: views, uniqViews, contacts, uniqContacts, favorites, uniqFavorites. Calls are not supported here; use items_post_calls_stats. If omitted, all supported counters are returned.',
        ),
      user_id: z.number().int().positive().optional().describe('ID of the owner user. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['itemIds', 'dateFrom', 'dateTo', 'periodGrouping', 'fields'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_post_item_analytics',
    title: 'Listing analytics',
    risk: 'read',
    description:
      'Returns EXTENDED statistical metrics for the profile/listings over a period (post_item_analytics, stats v2): views, contacts, presenceSpending, etc. with flexible grouping, filters and sorting. ' +
      'Read-only analytics. Choose it over items_post_item_stats_shallow when you need filters by category/employee, sorting by a metric, or presence-spending metrics. limit ≤ 1000.',
    method: 'POST',
    path: '/stats/v2/accounts/{user_id}/items',
    domain: 'stats',
    input: {
      dateFrom: z.string().describe('Start of the period, inclusive (YYYY-MM-DD).'),
      dateTo: z.string().describe('End of the period, inclusive (YYYY-MM-DD).'),
      metrics: z
        .array(z.string())
        .min(1)
        .describe('List of requested metrics (at least 1): views, contacts, presenceSpending, etc.'),
      grouping: z
        .enum(['day', 'week', 'month', 'item', 'totals'])
        .describe('How to group metrics: day, week, month, item, or totals.'),
      limit: z.number().int().min(0).max(1000).describe('Maximum number of rows in the response (0..1000) for pagination.'),
      offset: z.number().int().min(0).describe('Offset from the start of the selection for pagination (>= 0).'),
      filter: z
        .object({
          categoryIDs: z.array(z.number().int()).optional(),
          employeeIDs: z.array(z.number().int()).optional(),
        })
        .passthrough()
        .optional()
        .describe('Selection filters: categoryIDs — an array of category IDs, employeeIDs — an array of employee IDs. Without the filter — the entire profile.'),
      sort: z
        .object({
          key: z.string(),
          order: z.enum(['asc', 'desc']),
        })
        .optional()
        .describe('Sorting of results: key — the metric name, order — asc (ascending) or desc (descending).'),
      user_id: z.number().int().positive().optional().describe('ID of the owner user. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['dateFrom', 'dateTo', 'metrics', 'grouping', 'limit', 'offset', 'filter', 'sort'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_post_account_spendings',
    title: 'Profile spendings',
    risk: 'read',
    description:
      'Returns a REPORT of the profile\'s spendings over a period by Avito spending category: all, promotion, presence, commission, or rest. ' +
      'Read-only, spends no money (only shows already incurred spending). Period dateFrom..dateTo (YYYY-MM-DD). ' +
      'Note: grouping here is a STRING "day"|"week"|"month" (NOT an object, unlike items_post_item_analytics). Data depth no more than 270 days, no more than 1 request per minute. Required: dateFrom, dateTo, spendingTypes, grouping.',
    method: 'POST',
    path: '/stats/v2/accounts/{user_id}/spendings',
    domain: 'stats',
    input: {
      dateFrom: z.string().describe('Start of the period, inclusive (YYYY-MM-DD); no more than 270 days back.'),
      dateTo: z.string().describe('End of the period, inclusive (YYYY-MM-DD).'),
      spendingTypes: z
        .array(z.enum(['all', 'promotion', 'presence', 'commission', 'rest']))
        .min(1)
        .describe('Spending categories from the Avito contract (at least 1): all, promotion, presence, commission, rest.'),
      grouping: z
        .enum(['day', 'week', 'month'])
        .describe('Group spendings by period — a string (required): day (by day), week (by week), month (by month).'),
      filter: z
        .object({
          categoryIDs: z.array(z.number().int()).optional().describe('Filter by category IDs.'),
          itemIDs: z.array(z.number().int()).optional().describe('Filter by listing IDs.'),
          locationIDs: z.array(z.number().int()).optional().describe('Filter by location IDs.'),
        })
        .passthrough()
        .optional()
        .describe('Optional selection filters: categoryIDs — category IDs, itemIDs — listing IDs, locationIDs — location IDs. employeeIDs is NOT supported here. Without the filter — spendings of the entire profile.'),
      user_id: z.number().int().positive().optional().describe('ID of the owner user. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['dateFrom', 'dateTo', 'spendingTypes', 'grouping', 'filter'],
    },
  });

  // ────────────────────────────── WRITE (spends money / changes data!) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'items_update_price',
    title: '⚠️ Change price',
    risk: 'public',
    description:
      'Changes a listing\'s price (update_price). ⚠️ PUBLIC: the new price is immediately visible to buyers on the site. Requires item_id and price (integer, in rubles). ' +
      'Available only for the Goods, Spare Parts, Auto and Real Estate categories (except short-term rentals); other categories return an error. ' +
      'Spends no money, but this is a live change to a public listing — confirm with the user. Limit: 150 requests/min.',
    method: 'POST',
    path: '/core/v1/items/{item_id}/update_price',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID of the listing whose price needs to be changed.'),
      price: z.number().int().min(0).describe('New price in rubles, an integer (>= 0). Becomes visible to buyers immediately.'),
    },
    pathParams: ['item_id'],
    body: {
      contentType: 'application/json',
      fields: ['price'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_put_item_vas',
    title: '⚠️ Apply VAS',
    risk: 'money',
    description:
      'Applies ONE additional promotion service (VAS) to a listing (put_item_vas). ⚠️ MONEY: charges money from the balance; irreversible. The response contains service data and the charged amount. ' +
      'DEPRECATED: for one or more services, prefer items_apply_vas (v2); for a package of services, use items_put_item_vas_package_v2. ' +
      'First call items_post_vas_prices for the current slug and price. Confirm with the user. Note: an error does not guarantee the service was not purchased — check again in a few minutes.',
    method: 'PUT',
    path: '/core/v1/accounts/{user_id}/items/{item_id}/vas',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID of the listing the service is applied to.'),
      vas_id: z.enum(['highlight', 'xl']).describe('Slug of a single VAS service: "highlight" or "xl".'),
      user_id: z.number().int().positive().optional().describe('ID of the owner user. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id', 'item_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['vas_id'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_put_item_vas_package_v2',
    title: '⚠️ Apply VAS package',
    risk: 'money',
    description:
      'Applies a PACKAGE of promotion services (VAS) to a listing (put_item_vas_package_v2). ⚠️ MONEY: charges money from the balance; irreversible. The response contains the charged amount. ' +
      'Unlike items_put_item_vas (a single service by slug) and items_apply_vas (an arbitrary set of services/stickers), this method purchases a pre-assembled package by its package_id. ' +
      'DEPRECATED, the recommended replacement is items_apply_vas (v2). First check the price via items_post_vas_prices and confirm with the user. An error does not guarantee the package was not purchased — check again in a few minutes.',
    method: 'PUT',
    path: '/core/v2/accounts/{user_id}/items/{item_id}/vas_packages',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID of the listing the service package is applied to.'),
      package_id: z
        .enum(['x2_1', 'x2_7', 'x5_1', 'x5_7', 'x10_1', 'x10_7', 'x15_1', 'x15_7', 'x20_1', 'x20_7'])
        .describe('Identifier of the VAS service package from items_post_vas_prices.'),
      user_id: z.number().int().positive().optional().describe('ID of the owner user. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id', 'item_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['package_id'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_apply_vas',
    title: '⚠️ Apply VAS services',
    risk: 'money',
    description:
      'Applies ONE OR MORE promotion services (slugs) and/or stickers to a published listing (apply_vas, v2 — the current method). ⚠️ MONEY: charges money; irreversible. The response contains the IDs of the purchase operations for status tracking. ' +
      'The preferred replacement for the deprecated items_put_item_vas (a single service) and items_put_item_vas_package_v2 (a package). Within one request each service is applied only once; stickers are available only with the "XL listing" service, no more than three. ' +
      'First check the available slugs/stickers and price via items_post_vas_prices, and confirm with the user.',
    method: 'PUT',
    path: '/core/v2/items/{itemId}/vas/',
    domain: 'core',
    input: {
      itemId: z.number().int().positive().describe('ID of the published listing the services are applied to.'),
      slugs: z
        .array(z.string())
        .min(1)
        .describe('Slugs of the promotion services to apply, e.g. ["highlight","xl"] (at least 1; available ones from items_post_vas_prices).'),
      stickers: z.array(z.number().int()).max(3).optional().describe('Sticker IDs (integers), no more than 3; available only with the "XL listing" service.'),
    },
    pathParams: ['itemId'],
    body: {
      contentType: 'application/json',
      fields: ['slugs', 'stickers'],
    },
  });
};
