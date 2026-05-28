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
    title: 'Остатки: получить',
    risk: 'read',
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
    title: '⚠️ Остатки: изменить',
    risk: 'public',
    description:
      '⚠️ ИЗМЕНЯЕТ остатки в объявлениях. stocks — массив {item_id, quantity} (количество товара); ' +
      'опционально external_id (идентификатор во внешней системе). Поля item_id и quantity обязательны.',
    method: 'PUT',
    path: '/stock-management/1/stocks',
    domain: 'stock-management',
    input: {
      stocks: z
        .array(
          z.object({
            item_id: z.number().int().positive().describe('Идентификатор объявления на сайте.'),
            quantity: z.number().int().min(0).describe('Новое количество товара (>= 0).'),
            external_id: z
              .string()
              .optional()
              .describe('Идентификатор объявления во внешней системе (опционально).'),
          }),
        )
        .min(1)
        .max(200)
        .describe('Массив остатков по объявлениям (макс 200 за запрос).'),
    },
    body: { contentType: 'application/json', fields: ['stocks'] },
  });
};
