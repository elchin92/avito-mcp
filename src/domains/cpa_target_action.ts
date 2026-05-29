/**
 * Domain `cpa_target` — swaggers/Настройка цены целевого действия.json (5 endpoints).
 * Manages target-action bids (CPA promotion bids).
 *
 * ⚠️ Write: removePromotion / saveAutoBid / saveManualBid — change bids / stop promotion.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'cpa_target_get_bids',
    title: 'Target action: bids',
    risk: 'read',
    description:
      'Returns detailed information about current and available target-action bids for ONE listing: the active price/budget, the minimum/maximum/recommended values (all in kopecks), the selected strategy (manual/auto), and a target-action forecast with the advantage over competitors. Read-only — does not change spending. Use it before save_manual_bid/save_auto_bid to find the allowed min/max/recommended amounts. For multiple listings at once, use cpa_target_get_promotions_by_item_ids (batch up to 200). Limit: 20 requests/min.',
    method: 'GET',
    path: '/cpxpromo/1/getBids/{itemId}',
    domain: 'cpxpromo',
    input: {
      itemId: z.number().int().positive().describe('Avito listing ID for which bids and budgets are requested.'),
    },
    pathParams: ['itemId'],
  });

  defineTool(server, ctx, {
    name: 'cpa_target_get_promotions_by_item_ids',
    title: 'Target action: prices by listing',
    risk: 'read',
    description:
      'Returns current target-action bids and budgets (in kopecks) for MULTIPLE listings at once (batch, up to 200 per request): for each listing — actionTypeID and the active manual or auto strategy with its price/limit/budget. Read-only — does not change spending. Use it to bulk-check current settings; for a single listing with full min/max/recommendations and a forecast, use cpa_target_get_bids. Limit: 400 requests/min.',
    method: 'POST',
    path: '/cpxpromo/1/getPromotionsByItemIds',
    domain: 'cpxpromo',
    input: {
      itemIDs: z
        .array(z.number().int().positive())
        .min(1)
        .describe('List of Avito listing IDs (1 to 200 items) for which current bids and budgets are requested.'),
    },
    body: { contentType: 'application/json', fields: ['itemIDs'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_target_remove_promotion',
    title: '⚠️ Target action: stop',
    risk: 'write',
    description:
      '⚠️ STOPS target-action promotion for a listing and switches it to the base price from the price list. WARNING: removes the active manual or auto bid — the settings are reset, and to resume promotion you will have to set them again (save_manual_bid/save_auto_bid). Does not reduce spending to zero: the listing keeps being charged at the base target-action price. Returns a text message about the switch. Limit: 300 requests/min.',
    destructiveHint: true,
    method: 'POST',
    path: '/cpxpromo/1/remove',
    domain: 'cpxpromo',
    input: {
      itemID: z.number().int().positive().describe('Avito listing ID for which target-action promotion should be stopped.'),
    },
    body: { contentType: 'application/json', fields: ['itemID'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_target_save_auto_bid',
    title: '⚠️ Target action: auto bid',
    risk: 'money',
    description:
      '⚠️ Enables the AUTOMATIC target-action bidding strategy: the system picks the price itself within the specified budget. WARNING: affects budget spending (money) — sets a spend of budgetPenny per budgetType period. Mutually exclusive with the manual bid: this call overwrites any previously set manual strategy for this listing. Use it when you want to delegate price management to Avito (rather than fixing the amount manually — use save_manual_bid for that). budgetPenny must fall within min/maxBudgetPenny from cpa_target_get_bids. Not available in the "Transport" category. Limit: 10 requests/min.',
    method: 'POST',
    path: '/cpxpromo/1/setAuto',
    domain: 'cpxpromo',
    input: {
      itemID: z.number().int().positive().describe('Avito listing ID for which the auto strategy is enabled.'),
      actionTypeID: z
        .number()
        .int()
        .describe('Target-action type: 1 — call, 5 — click package, 7 — messenger (sharing a contact in chat).'),
      budgetType: z
        .string()
        .describe('Budget period: "1d" — daily, "7d" — weekly, "30d" — monthly.'),
      budgetPenny: z
        .number()
        .int()
        .positive()
        .describe('Budget in KOPECKS for the budgetType period (e.g. 1400 = 14 rubles). Must be within min/maxBudgetPenny from cpa_target_get_bids.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['itemID', 'actionTypeID', 'budgetType', 'budgetPenny'],
    },
  });

  defineTool(server, ctx, {
    name: 'cpa_target_save_manual_bid',
    title: '⚠️ Target action: manual bid',
    risk: 'money',
    description:
      '⚠️ Sets a MANUAL (fixed) target-action bid for a listing (manual bid). WARNING: affects budget spending (money) — each target action is charged at bidPenny, and daily spending is capped by limitPenny. Mutually exclusive with the auto bid: this call overwrites any previously set auto strategy for this listing. Use it when you want to control the per-action price yourself (to delegate the choice to Avito, use save_auto_bid). bidPenny must be no lower than minBidPenny from cpa_target_get_bids. Limit: 20 requests/min.',
    method: 'POST',
    path: '/cpxpromo/1/setManual',
    domain: 'cpxpromo',
    input: {
      itemID: z.number().int().positive().describe('Avito listing ID for which the manual bid is set.'),
      actionTypeID: z
        .number()
        .int()
        .describe('Target-action type: 1 — call, 5 — click package, 7 — messenger (sharing a contact in chat).'),
      bidPenny: z
        .number()
        .int()
        .positive()
        .describe('Price per single target action in KOPECKS (e.g. 1400 = 14 rubles). Must be no lower than minBidPenny from cpa_target_get_bids.'),
      limitPenny: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional daily spending limit in KOPECKS. If omitted, no limit is applied. For the allowed min/maxLimitPenny range, see cpa_target_get_bids.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['itemID', 'actionTypeID', 'bidPenny', 'limitPenny'],
    },
  });
};
