/**
 * Домен `trxpromo` — swaggers/TrxPromo.json (3 endpoints).
 * Транзакционное продвижение (комиссия за результат).
 *
 * Quirks: GET /trx-promo/1/commissions принимает body — нестандартно, но Avito делает так.
 *
 * ⚠️ Write: apply (запуск) / cancel (остановка) продвижения.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'trxpromo_get_commissions',
    description:
      'Проверка доступности продвижения и размера комиссий для объявлений. ' +
      'Это GET с body — нестандартно, но именно так в swagger Avito.',
    method: 'GET',
    path: '/trx-promo/1/commissions',
    domain: 'trx-promo',
    input: {
      itemIDs: z.array(z.number().int().positive()).min(1).describe('ID объявлений.'),
    },
    body: { contentType: 'application/json', fields: ['itemIDs'] },
  });

  defineTool(server, ctx, {
    name: 'trxpromo_apply',
    description:
      '⚠️ ЗАПУСКАЕТ транзакционное продвижение для объявлений. ' +
      'items: массив {itemId, ...} — см. swagger.',
    method: 'POST',
    path: '/trx-promo/1/apply',
    domain: 'trx-promo',
    input: {
      items: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe('Массив объявлений для продвижения. См. swaggers/TrxPromo.json.'),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'trxpromo_cancel',
    description: '⚠️ ОСТАНАВЛИВАЕТ транзакционное продвижение для объявлений.',
    method: 'POST',
    path: '/trx-promo/1/cancel',
    domain: 'trx-promo',
    input: {
      itemIDs: z.array(z.number().int().positive()).min(1).describe('ID объявлений.'),
    },
    body: { contentType: 'application/json', fields: ['itemIDs'] },
  });
};
