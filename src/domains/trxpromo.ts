/**
 * Domain `trxpromo` — swaggers/trxpromo.json (3 endpoints).
 * Transactional promotion (pay-per-result commission).
 *
 * Quirks: GET /trx-promo/1/commissions accepts a body — non-standard, but that's how Avito does it.
 *
 * ⚠️ Write: apply (start) / cancel (stop) promotion.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'trxpromo_get_commissions',
    title: 'TrxPromo: commissions',
    risk: 'read',
    description:
      'Checks transactional promo availability and the allowed commission range for listings (trxpromo_get_commissions, read-only — does not start anything or charge any fee). ' +
      'For each listing it returns the promoAvailable flag and settings: minimum/maximum/step of the commission in hundredths of a percent (100 = 1%). ' +
      'Use before trxpromo_apply to learn the commission limits. Start promo with trxpromo_apply, cancel with trxpromo_cancel. ' +
      'This is a GET with a request body — non-standard, but that is exactly how it is defined in the Avito swagger.',
    method: 'GET',
    path: '/trx-promo/1/commissions',
    domain: 'trx-promo',
    input: {
      itemIDs: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Array of Avito listing IDs to check for promo availability and commission limits.'),
    },
    body: { contentType: 'application/json', fields: ['itemIDs'] },
  });

  defineTool(server, ctx, {
    name: 'trxpromo_apply',
    title: '⚠️ TrxPromo: start promotion',
    risk: 'money',
    description:
      '⚠️ Applies transactional promo/promotion with a pay-per-result commission to listings (trxpromo_apply). Affects price/spend: the promotion fee is added on top of the base commission. ' +
      'The response includes a success flag per listing, and on error a code 1001 (validation) or 1002 (promo unavailable) along with the allowed commission range. ' +
      'First check the limits via trxpromo_get_commissions; cancel a running promo with trxpromo_cancel.',
    method: 'POST',
    path: '/trx-promo/1/apply',
    domain: 'trx-promo',
    input: {
      items: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          'Array of listings to promote. Each element: itemID (number, listing ID, required), ' +
            'commission (promotion fee in hundredths of a percent, 1500 = 15%; required), ' +
            'dateFrom (promotion start date "YYYY-MM-DD", required), ' +
            'dateTo (end date "YYYY-MM-DD", optional — otherwise all available dates). See swaggers/trxpromo.json.',
        ),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'trxpromo_cancel',
    title: '⚠️ TrxPromo: stop',
    risk: 'write',
    destructiveHint: true,
    description:
      '⚠️ Cancels active and scheduled transactional promo for listings (trxpromo_cancel). Reverts the effect of trxpromo_apply — the promotion and its associated commission stop applying. ' +
      'The response includes a success flag per listing, and on error a code 1001 (validation) or 1002 (promo unavailable). ' +
      'Apply promo again with trxpromo_apply; check commissions with trxpromo_get_commissions (read-only).',
    method: 'POST',
    path: '/trx-promo/1/cancel',
    domain: 'trx-promo',
    input: {
      itemIDs: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Array of Avito listing IDs for which active and scheduled promo is canceled.'),
    },
    body: { contentType: 'application/json', fields: ['itemIDs'] },
  });
};
