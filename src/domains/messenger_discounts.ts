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
      'Информация об объявлениях для рассылки скидок: для каких можно делать рассылку, ' +
      'и какие у них доступные параметры.',
    method: 'POST',
    path: '/special-offers/v1/available',
    domain: 'special-offers',
    input: {
      itemIds: z.array(z.number().int().positive()).min(1).describe('ID объявлений.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_multi_create',
    title: 'Скидки: создать рассылку',
    risk: 'write',
    description:
      'Создание (черновика) массовой рассылки скидок для списка объявлений. ' +
      'После создания — узнайте цену через msg_discounts_open_api_tariff_info, ' +
      'затем подтвердите через msg_discounts_open_api_multi_confirm.',
    method: 'POST',
    path: '/special-offers/v1/multiCreate',
    domain: 'special-offers',
    input: {
      itemIds: z.array(z.number().int().positive()).min(1).describe('ID объявлений для рассылки.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_multi_confirm',
    title: '⚠️ Скидки: отправить рассылку',
    risk: 'money',
    description:
      '⚠️ ОТПРАВЛЯЕТ и ОПЛАЧИВАЕТ рассылку скидок — клиенты получат сообщения, со счёта спишутся деньги. ' +
      'Подтверждайте у пользователя перед вызовом!',
    method: 'POST',
    path: '/special-offers/v1/multiConfirm',
    domain: 'special-offers',
    input: {
      dispatches: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('Массив рассылок для подтверждения (из ответа multiCreate).'),
      expiresAt: z
        .number()
        .int()
        .optional()
        .describe('Unix timestamp (сек), до которого истекает предложение.'),
    },
    body: { contentType: 'application/json', fields: ['dispatches', 'expiresAt'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_stats',
    title: 'Скидки: статистика рассылок',
    risk: 'read',
    description:
      'Статистика отправленных рассылок скидок за период (показы, переходы, конверсии).',
    method: 'POST',
    path: '/special-offers/v1/stats',
    domain: 'special-offers',
    input: {
      dateTimeFrom: z.string().describe('Начало периода (ISO 8601).'),
      dateTimeTo: z.string().describe('Конец периода (ISO 8601).'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'dateTimeTo'] },
  });

  defineTool(server, ctx, {
    name: 'msg_discounts_open_api_tariff_info',
    title: 'Скидки: тариф рассылки',
    risk: 'read',
    description:
      'Информация о тарифе рассылки скидок — текущая цена за отправку, доступные опции.',
    method: 'POST',
    path: '/special-offers/v1/tariffInfo',
    domain: 'special-offers',
    input: {},
    body: { contentType: 'application/json', defaults: {} },
  });
};
