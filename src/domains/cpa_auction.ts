/**
 * Domain `cpa_auction` — swaggers/cpa-auction.json (2 endpoints).
 *
 * ⚠️ Write: saveItemBids — saves CPA auction bids (up to 200 listings per request).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'cpa_auction_get_user_bids',
    title: 'CPA auction: my bids',
    risk: 'read',
    description:
      'Reads active and available CPA auction bids for the user\'s listings (read-only, does not change spending). ' +
      'For each listing returns the current bid pricePenny (in kopecks per action), its validity time expirationTime (RFC3339; absent — valid indefinitely), and the list of available bids availablePrices. ' +
      'Paginated via the fromItemID cursor. To change bids, use cpa_auction_save_item_bids. Limit 200 requests/min.',
    method: 'GET',
    path: '/auction/1/bids',
    domain: 'auction',
    input: {
      fromItemID: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Pagination cursor: ID of the last listing from the previous page (default 0 — from the start).'),
      batchSize: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Page size — number of listings in the response (1–200, default 200).'),
    },
    queryParams: ['fromItemID', 'batchSize'],
  });

  defineTool(server, ctx, {
    name: 'cpa_auction_save_item_bids',
    title: '⚠️ CPA auction: save bids',
    risk: 'money',
    description:
      'Saves (overwrites) CPA auction bids for listings. WARNING: affects auction spending (money) — a higher bid means a higher display position. ' +
      'pricePenny is in kopecks per action; expirationTime sets the validity period (omitted or null — indefinite). ' +
      'Up to 200 listings per request, limit 200 requests/min. For current and available bids see cpa_auction_get_user_bids.',
    method: 'POST',
    path: '/auction/1/bids',
    domain: 'auction',
    input: {
      items: z
        .array(
          z.object({
            itemID: z.number().int(),
            pricePenny: z.number().int(),
            expirationTime: z.string().nullable().optional(),
          }),
        )
        .min(1)
        .max(200)
        .describe(
          'Array of bids (1–200). Each element: itemID (int, listing ID, required), pricePenny (int, bid in kopecks, required), ' +
            'expirationTime (string RFC3339, e.g. "2023-06-29T12:34:34+03:00"; null/absent — indefinite). See swaggers/cpa-auction.json.',
        ),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });
};
