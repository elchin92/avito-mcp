/**
 * Домен `msg_discounts` — swaggers/Рассылка скидок и спецпредложений в мессенджере (beta-version).json
 * (5 endpoints, BETA).
 *
 * Workflow:
 *   1) available — узнать, для каких объявлений можно делать рассылку
 *   2) multiCreate — создать черновик рассылки
 *   3) tariffInfo — узнать цену
 *   4) multiConfirm — ⚠️ ОТПРАВИТЬ И ОПЛАТИТЬ (тратит деньги!)
 *   5) stats — статистика отправленных рассылок
 *
 * ⚠️ multiConfirm — реальная отправка сообщений клиентам + списание денег.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_available',
    title: 'Скидки: доступные объявления',
    risk: 'read',
    description:
      '[BETA] Проверяет доступность рассылки скидок/спецпредложений в мессенджере для списка объявлений (available). ' +
      'Только чтение, ничего не отправляет и не списывает. Для каждого itemId возвращает isAvailable и, если недоступно, reason. ' +
      'Запускайте ПЕРВЫМ, до msg_discounts_open_api_multi_create. Не путать с ..._tariff_info (остаток рассылок в тарифе) и ..._stats (статистика отправленных).',
    method: 'POST',
    path: '/special-offers/v1/available',
    domain: 'special-offers',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Список ID объявлений, для которых проверяется доступность услуги рассылки. Минимум один.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_multi_create',
    title: 'Скидки: создать рассылку',
    risk: 'write',
    description:
      '[BETA] Создаёт черновик рассылки скидок/спецпредложений в мессенджере по списку объявлений и фиксирует аудиторию получателей (multi_create). ' +
      'Это ПЕРВЫЙ шаг — рассылка пока НЕ отправлена и деньги НЕ списаны: возвращает dispatches (id, статус created/notCreated, число получателей) и доступные предложения (offers) с ценой. ' +
      'Затем выберите предложение и подтвердите через msg_discounts_open_api_multi_confirm — только тогда сообщения уйдут получателям (public). Доступность объявлений проверьте заранее через ..._available.',
    method: 'POST',
    path: '/special-offers/v1/multiCreate',
    domain: 'special-offers',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Список ID объявлений, выбранных для рассылки. Минимум один.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_multi_confirm',
    title: '⚠️ Скидки: отправить рассылку',
    risk: 'money',
    description:
      '[BETA] ⚠️ ВТОРОЙ, финальный шаг: подтверждает и ОПЛАЧИВАЕТ из кошелька Авито рассылку скидок/спецпредложений, созданную через msg_discounts_open_api_multi_create (multi_confirm). ' +
      'НЕОБРАТИМО и PUBLIC: сообщения уходят получателям (покупателям, добавившим объявление в избранное), со счёта списываются деньги; при нехватке средств вернётся ошибка. ' +
      'Обязательно подтвердите действие у пользователя перед вызовом. В отличие от ..._available/..._tariff_info/..._stats (только чтение) этот метод выполняет реальную отправку и списание.',
    method: 'POST',
    path: '/special-offers/v1/multiConfirm',
    domain: 'special-offers',
    input: {
      dispatches: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe(
          'Список рассылок для подтверждения; берётся из ответа multi_create. Каждый элемент содержит dispatchId (ID рассылки), recipientsCount (число получателей), offerSlug (slug выбранного предложения) и опционально discountValue (финальный размер скидки для предложений типа discount).',
        ),
      expiresAt: z
        .number()
        .int()
        .optional()
        .describe('Дата окончания действия предложения, Unix timestamp в секундах; в пределах диапазона min/max из ответа multi_create.'),
    },
    body: { contentType: 'application/json', fields: ['dispatches', 'expiresAt'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_stats',
    title: 'Скидки: статистика рассылок',
    risk: 'read',
    description:
      '[BETA] Возвращает статистику по уже отправленным рассылкам скидок/спецпредложений за период (stats). ' +
      'Только чтение, ничего не отправляет и не списывает. По каждой рассылке: itemId, offerSlug, дата отправки и истечения, число отправленных (count) и принятых покупателями (accepted) предложений, размер скидки и стоимость. ' +
      'Используйте для анализа результатов; для проверки доступности — ..._available, для остатка тарифа — ..._tariff_info.',
    method: 'POST',
    path: '/special-offers/v1/stats',
    domain: 'special-offers',
    input: {
      dateTimeFrom: z.string().describe('Начало периода выборки, формат RFC3339 / ISO 8601 (напр. 2022-02-24T05:00:00Z).'),
      dateTimeTo: z.string().describe('Конец периода выборки, формат RFC3339 / ISO 8601 (напр. 2022-03-01T12:00:00Z).'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'dateTimeTo'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_tariff_info',
    title: 'Скидки: тариф рассылки',
    risk: 'read',
    description:
      '[BETA] Возвращает информацию о текущем тарифе рассылок скидок/спецпредложений: сколько рассылок осталось (sendsLeft) и сколько было всего (totalSends) (tariff_info). ' +
      'Только чтение, без параметров, ничего не отправляет и не списывает; если активного тарифа нет — ответ пустой. ' +
      'Не путать с ..._available (доступность по объявлениям) и ..._stats (статистика уже отправленных рассылок).',
    method: 'POST',
    path: '/special-offers/v1/tariffInfo',
    domain: 'special-offers',
    input: {},
    body: { contentType: 'application/json', defaults: {} },
  });
};
