/**
 * Домен `cpa_auction` — swaggers/CPA-аукцион.json (2 endpoints).
 *
 * ⚠️ Write: saveItemBids — сохраняет ставки в аукционе CPA (до 200 объявлений за запрос).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'cpa_auction_get_user_bids',
    title: 'CPA-аукцион: мои ставки',
    risk: 'read',
    description:
      'Текущие и доступные ставки в CPA-аукционе с курсорной пагинацией. ' +
      'fromItemID — курсор (ID объявления, с которого продолжить), batchSize — размер страницы.',
    method: 'GET',
    path: '/auction/1/bids',
    domain: 'auction',
    input: {
      fromItemID: z.number().int().positive().optional().describe('Курсор: ID объявления.'),
      batchSize: z.number().int().min(1).max(200).optional().describe('Размер страницы (1–200).'),
    },
    queryParams: ['fromItemID', 'batchSize'],
  });

  defineTool(server, ctx, {
    name: 'cpa_auction_save_item_bids',
    title: '⚠️ CPA-аукцион: сохранить ставки',
    risk: 'money',
    description:
      '⚠️ Сохранение новых ставок в CPA-аукционе для объявлений (до 200 за запрос). ' +
      'items: массив {itemId, bid (в копейках), ...} — см. swagger.',
    method: 'POST',
    path: '/auction/1/bids',
    domain: 'auction',
    input: {
      items: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .max(200)
        .describe('Массив ставок {itemId, bid, ...}. См. swaggers/CPA-аукцион.json.'),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });
};
