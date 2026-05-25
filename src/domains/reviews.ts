/**
 * Домен `reviews` — swaggers/Рейтинги и отзывы.json (4 endpoints).
 *
 * ⚠️ Write: create_review_answer, remove_review_answer — публичные действия (видны клиентам).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'reviews_get_ratings_info_v1',
    description: 'Информация о рейтинге пользователя (общая оценка, количество отзывов).',
    method: 'GET',
    path: '/ratings/v1/info',
    domain: 'ratings',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'reviews_get_reviews_v1',
    description: 'Список активных отзывов на пользователя с пагинацией (offset+limit).',
    method: 'GET',
    path: '/ratings/v1/reviews',
    domain: 'ratings',
    input: {
      offset: z.number().int().min(0).optional().describe('Смещение пагинации.'),
      limit: z.number().int().min(1).max(100).optional().describe('Сколько отзывов вернуть (1–100).'),
    },
    queryParams: ['offset', 'limit'],
  });

  defineTool(server, ctx, {
    name: 'reviews_create_review_answer_v1',
    description:
      '⚠️ ПУБЛИЧНЫЙ ответ на отзыв — будет виден покупателям. Подтверждайте у пользователя.',
    method: 'POST',
    path: '/ratings/v1/answers',
    domain: 'ratings',
    input: {
      reviewId: z.number().int().positive().describe('ID отзыва.'),
      message: z.string().min(1).describe('Текст ответа на отзыв.'),
    },
    body: { contentType: 'application/json', fields: ['reviewId', 'message'] },
  });

  defineTool(server, ctx, {
    name: 'reviews_remove_review_answer_v1',
    description: '⚠️ УДАЛЯЕТ ответ на отзыв.',
    method: 'DELETE',
    path: '/ratings/v1/answers/{answer_id}',
    domain: 'ratings',
    input: {
      answer_id: z.number().int().positive().describe('ID ответа.'),
    },
    pathParams: ['answer_id'],
  });
};
