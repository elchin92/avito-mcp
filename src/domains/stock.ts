/**
 * Домен `stock` — swaggers/Управление остатками.json (2 endpoints).
 *
 * Quirks: в swagger операции БЕЗ operationId — имена tools назначены семантически.
 *
 * ⚠️ Write: update_stocks меняет количество товара в объявлениях.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'stock_get_stocks_info',
    description:
      'Получение текущих остатков для списка объявлений. strong_consistency — гарантия свежих данных.',
    method: 'POST',
    path: '/stock-management/1/info',
    domain: 'stock-management',
    input: {
      item_ids: z
        .array(z.number().int().positive())
        .min(1)
        .max(200)
        .describe('ID объявлений (макс 200 за запрос).'),
      strong_consistency: z
        .boolean()
        .optional()
        .describe('Требовать строгую консистентность (медленнее, но свежо).'),
    },
    body: { contentType: 'application/json', fields: ['item_ids', 'strong_consistency'] },
  });

  defineTool(server, ctx, {
    name: 'stock_update_stocks',
    description:
      '⚠️ ИЗМЕНЯЕТ остатки в объявлениях. stocks — массив {item_id, stock} (количество товара).',
    method: 'PUT',
    path: '/stock-management/1/stocks',
    domain: 'stock-management',
    input: {
      stocks: z
        .array(
          z.object({
            item_id: z.number().int().positive(),
            stock: z.number().int().min(0).describe('Новый остаток (>= 0).'),
          }),
        )
        .min(1)
        .max(200)
        .describe('Массив остатков по объявлениям (макс 200 за запрос).'),
    },
    body: { contentType: 'application/json', fields: ['stocks'] },
  });
};
