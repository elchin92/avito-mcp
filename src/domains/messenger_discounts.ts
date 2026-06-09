/**
 * `msg_discounts` domain — swaggers/messenger-discounts.json
 * (5 endpoints, BETA).
 *
 * Workflow:
 *   1) available — find out which listings are eligible for a campaign
 *   2) multiCreate — create a campaign draft
 *   3) tariffInfo — find out the price
 *   4) multiConfirm — ⚠️ SEND AND PAY (spends money!)
 *   5) stats — statistics for sent campaigns
 *
 * ⚠️ multiConfirm — actually sends messages to customers + charges money.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_available',
    title: 'Discounts: eligible listings',
    risk: 'read',
    description:
      '[BETA] Checks whether a discount/special-offer messenger campaign is available for a list of listings (available). ' +
      'Read-only; sends nothing and charges nothing. For each itemId it returns isAvailable and, when not available, a reason. ' +
      'Run this FIRST, before msg_discounts_open_api_multi_create. Do not confuse it with ..._tariff_info (campaigns remaining in the plan) or ..._stats (statistics for sent campaigns).',
    method: 'POST',
    path: '/special-offers/v1/available',
    domain: 'special-offers',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe('List of listing IDs to check for campaign-service availability. At least one.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_multi_create',
    title: 'Discounts: create campaign',
    risk: 'write',
    description:
      '[BETA] Creates a draft discount/special-offer messenger campaign for a list of listings and locks in the recipient audience (multi_create). ' +
      'This is the FIRST step — the campaign is NOT sent yet and no money is charged: it returns dispatches (id, created/notCreated status, recipient count) and the available offers with their price. ' +
      'Then pick an offer and confirm it via msg_discounts_open_api_multi_confirm — only then are the messages sent to recipients (public). Check listing eligibility in advance via ..._available.',
    method: 'POST',
    path: '/special-offers/v1/multiCreate',
    domain: 'special-offers',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe('List of listing IDs selected for the campaign. At least one.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_multi_confirm',
    title: '⚠️ Discounts: send campaign',
    risk: 'money',
    description:
      '[BETA] ⚠️ SECOND, final step: confirms and PAYS from the Avito wallet for the discount/special-offer campaign created via msg_discounts_open_api_multi_create (multi_confirm). ' +
      'IRREVERSIBLE and PUBLIC: messages are sent to recipients (buyers who added the listing to favorites) and money is deducted from the account; if funds are insufficient an error is returned. ' +
      'Always confirm the action with the user before calling. Unlike ..._available/..._tariff_info/..._stats (read-only), this method performs the actual send and charge.',
    method: 'POST',
    path: '/special-offers/v1/multiConfirm',
    domain: 'special-offers',
    input: {
      dispatches: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe(
          'List of campaigns to confirm; taken from the multi_create response. Each item contains dispatchId (campaign ID), recipientsCount (number of recipients), offerSlug (slug of the chosen offer), and optionally discountValue (final discount amount for offers of type discount).',
        ),
      expiresAt: z
        .number()
        .int()
        .optional()
        .describe('Offer expiration date, Unix timestamp in seconds; within the min/max range from the multi_create response.'),
    },
    body: { contentType: 'application/json', fields: ['dispatches', 'expiresAt'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_stats',
    title: 'Discounts: campaign statistics',
    risk: 'read',
    description:
      '[BETA] Returns statistics for already-sent discount/special-offer campaigns over a period (stats). ' +
      'Read-only; sends nothing and charges nothing. For each campaign: itemId, offerSlug, send and expiration dates, the number of offers sent (count) and accepted by buyers (accepted), the discount amount, and the cost. ' +
      'Use it to analyze results; for eligibility checks use ..._available, and for the remaining plan balance use ..._tariff_info.',
    method: 'POST',
    path: '/special-offers/v1/stats',
    domain: 'special-offers',
    input: {
      dateTimeFrom: z.string().describe('Start of the selection period, RFC3339 / ISO 8601 format (e.g. 2022-02-24T05:00:00Z).'),
      dateTimeTo: z.string().describe('End of the selection period, RFC3339 / ISO 8601 format (e.g. 2022-03-01T12:00:00Z).'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'dateTimeTo'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_tariff_info',
    title: 'Discounts: campaign plan',
    risk: 'read',
    description:
      '[BETA] Returns information about the current discount/special-offer campaign plan: how many campaigns remain (sendsLeft) and the total allowance (totalSends) (tariff_info). ' +
      'Read-only, no parameters, sends nothing and charges nothing; if there is no active plan, the response is empty. ' +
      'Do not confuse it with ..._available (per-listing eligibility) or ..._stats (statistics for already-sent campaigns).',
    method: 'POST',
    path: '/special-offers/v1/tariffInfo',
    domain: 'special-offers',
    input: {},
    body: { contentType: 'application/json', defaults: {} },
  });
};
