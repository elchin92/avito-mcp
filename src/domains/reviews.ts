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
    title: 'Рейтинг пользователя',
    risk: 'read',
    description:
      'Возвращает агрегированный рейтинг текущего пользователя (reviews_get_ratings_info_v1): средняя оценка score, общее число активных отзывов и число отзывов, влияющих на рейтинг, плюс флаг включён ли рейтинг. Параметров нет, постранично ничего не возвращает. Нужен сам список отзывов — используйте reviews_get_reviews_v1.',
    method: 'GET',
    path: '/ratings/v1/info',
    domain: 'ratings',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'reviews_get_reviews_v1',
    title: 'Список отзывов',
    risk: 'read',
    description:
      'Возвращает постраничный список активных отзывов на текущего пользователя (reviews_get_reviews_v1): id отзыва, оценку, текст, автора, объявление, приложенные фото и текущий ответ продавца, а также total — общее число отзывов. Используйте для просмотра отдельных отзывов и получения reviewId (нужен для reviews_create_review_answer_v1). Нужна только сводная оценка без перечня — берите reviews_get_ratings_info_v1.',
    method: 'GET',
    path: '/ratings/v1/reviews',
    domain: 'ratings',
    input: {
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Смещение пагинации: сколько отзывов пропустить от начала списка. По умолчанию 0; для следующей страницы увеличивайте на размер limit.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Максимальное число отзывов на странице. Допустимый диапазон по API: 1–50 (по умолчанию используется верхняя граница).'),
    },
    queryParams: ['offset', 'limit'],
  });

  defineTool(server, ctx, {
    name: 'reviews_create_review_answer_v1',
    title: '⚠️ Ответить на отзыв',
    risk: 'public',
    description:
      'Публикует ответ продавца на отзыв (reviews_create_review_answer_v1). ВНИМАНИЕ: ответ ПУБЛИЧНЫЙ — после модерации виден всем на странице профиля. Требует reviewId (из reviews_get_reviews_v1) и текст message; возвращает id созданного ответа и timestamp. Подтверждайте действие у пользователя. Удалить ответ — reviews_remove_review_answer_v1.',
    method: 'POST',
    path: '/ratings/v1/answers',
    domain: 'ratings',
    input: {
      reviewId: z
        .number()
        .int()
        .positive()
        .describe('ID отзыва, на который публикуется ответ. Берётся из поля id в reviews_get_reviews_v1.'),
      message: z
        .string()
        .min(1)
        .describe('Текст публичного ответа на отзыв (не может быть пустым). Проходит модерацию перед публикацией.'),
    },
    body: { contentType: 'application/json', fields: ['reviewId', 'message'] },
  });

  defineTool(server, ctx, {
    name: 'reviews_remove_review_answer_v1',
    title: '⚠️ Удалить ответ на отзыв',
    risk: 'public',
    destructiveHint: true,
    description:
      'Безвозвратно удаляет ранее опубликованный ответ продавца на отзыв (reviews_remove_review_answer_v1). ВНИМАНИЕ: удаление НЕОБРАТИМО и сразу убирает публичный ответ из профиля; возвращает флаг success. Подтверждайте действие у пользователя. Опубликовать ответ заново — reviews_create_review_answer_v1.',
    method: 'DELETE',
    path: '/ratings/v1/answers/{answer_id}',
    domain: 'ratings',
    input: {
      answer_id: z
        .number()
        .int()
        .positive()
        .describe('ID удаляемого ответа на отзыв (не путать с reviewId). Берётся из поля answer.id отзыва в reviews_get_reviews_v1.'),
    },
    pathParams: ['answer_id'],
  });
};
