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
      'Читает действующие и доступные ставки CPA-аукциона по объявлениям пользователя (только чтение, расход не меняет). ' +
      'Возвращает по каждому объявлению текущую ставку pricePenny (в копейках за действие), время её действия expirationTime (RFC3339; отсутствует — действует бессрочно) и список доступных ставок availablePrices. ' +
      'Постранично, курсором fromItemID. Чтобы изменить ставки — cpa_auction_save_item_bids. Лимит 200 запросов/мин.',
    method: 'GET',
    path: '/auction/1/bids',
    domain: 'auction',
    input: {
      fromItemID: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Курсор пагинации: ID последнего объявления из предыдущей страницы (по умолчанию 0 — с начала).'),
      batchSize: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Размер страницы — число объявлений в ответе (1–200, по умолчанию 200).'),
    },
    queryParams: ['fromItemID', 'batchSize'],
  });

  defineTool(server, ctx, {
    name: 'cpa_auction_save_item_bids',
    title: '⚠️ CPA-аукцион: сохранить ставки',
    risk: 'money',
    description:
      'Сохраняет (перезаписывает) ставки в CPA-аукционе для объявлений. ВНИМАНИЕ: влияет на расход в аукционе (money) — выше ставка, выше позиция показа. ' +
      'pricePenny — в копейках за действие; expirationTime задаёт срок действия (без поля либо null — бессрочно). ' +
      'До 200 объявлений за запрос, лимит 200 запросов/мин. Текущие и доступные ставки см. в cpa_auction_get_user_bids.',
    method: 'POST',
    path: '/auction/1/bids',
    domain: 'auction',
    input: {
      items: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .max(200)
        .describe(
          'Массив ставок (1–200). Каждый элемент: itemID (int, ID объявления, обязателен), pricePenny (int, ставка в копейках, обязательна), ' +
            'expirationTime (string RFC3339, например "2023-06-29T12:34:34+03:00"; null/отсутствует — бессрочно). См. swaggers/CPA-аукцион.json.',
        ),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });
};
