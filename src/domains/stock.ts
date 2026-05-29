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
      'Читает текущие остатки (доступное количество) по списку объявлений на складе (get_stocks_info). Только чтение, ничего не меняет. Возвращает по каждому item_id: quantity (доступно = подано/отредактировано минус бронь), is_unlimited, is_multiple, is_out_of_stock. Изменение остатков — stock_update_stocks.',
    method: 'POST',
    path: '/stock-management/1/info',
    domain: 'stock-management',
    input: {
      item_ids: z
        .array(z.number().int().positive())
        .min(1)
        .max(200)
        .describe('Идентификаторы объявлений на сайте Avito (item_id), для которых нужны остатки; от 1 до 200 за один запрос.'),
      strong_consistency: z
        .boolean()
        .optional()
        .describe('Если true — пропустить кеш и отдать данные из базы (строгая консистентность): свежее, но медленнее. По умолчанию данные могут браться из кеша. Опционально.'),
    },
    body: { contentType: 'application/json', fields: ['item_ids', 'strong_consistency'] },
  });

  defineTool(server, ctx, {
    name: 'stock_update_stocks',
    title: '⚠️ Остатки: изменить',
    risk: 'public',
    description:
      '⚠️ Обновляет остатки (количество) товаров по объявлениям на складе (update_stocks). Влияет на доступность объявлений к заказу: quantity=0 переводит объявление в «нет в наличии». Принимает массив {item_id, quantity, external_id?}; quantity — целое 0..999999. Возвращает по каждому объявлению success и errors. Текущие остатки — stock_get_stocks_info.',
    method: 'PUT',
    path: '/stock-management/1/stocks',
    domain: 'stock-management',
    input: {
      stocks: z
        .array(
          z.object({
            item_id: z.number().int().positive().describe('Идентификатор объявления на сайте Avito, для которого задаётся остаток. Обязателен.'),
            quantity: z.number().int().min(0).describe('Новое количество товара в наличии; целое от 0 до 999999. 0 означает отсутствие товара. Обязателен.'),
            external_id: z
              .string()
              .optional()
              .describe('Идентификатор объявления во внешней системе (например, в учётной системе продавца); возвращается в ответе. Опционально.'),
          }),
        )
        .min(1)
        .max(200)
        .describe('Массив остатков по объявлениям; от 1 до 200 элементов за один запрос.'),
    },
    body: { contentType: 'application/json', fields: ['stocks'] },
  });
};
