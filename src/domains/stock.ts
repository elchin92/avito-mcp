/**
 * Domain `stock` — swaggers/Stock management.json (2 endpoints).
 *
 * Quirks: the swagger operations have NO operationId — tool names were assigned semantically.
 *
 * ⚠️ Write: update_stocks changes the item quantity in listings.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'stock_get_stocks_info',
    title: 'Stock: get',
    risk: 'read',
    description:
      'Reads current stock (available quantity) for a list of listings in the warehouse (get_stocks_info). Read-only, changes nothing. Returns for each item_id: quantity (available = submitted/edited minus reserved), is_unlimited, is_multiple, is_out_of_stock. To change stock, use stock_update_stocks.',
    method: 'POST',
    path: '/stock-management/1/info',
    domain: 'stock-management',
    input: {
      item_ids: z
        .array(z.number().int().positive())
        .min(1)
        .max(200)
        .describe('IDs of the listings on the Avito website (item_id) to get stock for; from 1 to 200 per request.'),
      strong_consistency: z
        .boolean()
        .optional()
        .describe('If true, skip the cache and return data from the database (strong consistency): fresher but slower. By default data may be served from the cache. Optional.'),
    },
    body: { contentType: 'application/json', fields: ['item_ids', 'strong_consistency'] },
  });

  defineTool(server, ctx, {
    name: 'stock_update_stocks',
    title: '⚠️ Stock: update',
    risk: 'public',
    description:
      '⚠️ Updates the stock (quantity) of items across listings in the warehouse (update_stocks). Affects whether listings are available to order: quantity=0 marks a listing as "out of stock". Accepts an array of {item_id, quantity, external_id?}; quantity is an integer 0..999999. Returns success and errors for each listing. For current stock, use stock_get_stocks_info.',
    method: 'PUT',
    path: '/stock-management/1/stocks',
    domain: 'stock-management',
    input: {
      stocks: z
        .array(
          z.object({
            item_id: z.number().int().positive().describe('ID of the listing on the Avito website for which stock is being set. Required.'),
            quantity: z.number().int().min(0).describe('New available quantity of the item; an integer from 0 to 999999. 0 means out of stock. Required.'),
            external_id: z
              .string()
              .optional()
              .describe('ID of the listing in an external system (for example, the seller\'s inventory system); returned in the response. Optional.'),
          }),
        )
        .min(1)
        .max(200)
        .describe('Array of stock entries per listing; from 1 to 200 elements per request.'),
    },
    body: { contentType: 'application/json', fields: ['stocks'] },
  });
};
