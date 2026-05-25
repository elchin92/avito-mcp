/**
 * Домен `promotion` — swaggers/Продвижение.json (7 endpoints).
 * BBIP = "большой бюджет интегрированного продвижения" — комплексные услуги Avito.
 *
 * ⚠️ Write: create_bbip_order — РЕАЛЬНАЯ ПОКУПКА продвижения, тратит деньги с баланса.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

const ItemBudget = z
  .object({
    itemId: z.number().int().positive().describe('ID объявления.'),
    budget: z.number().int().positive().optional().describe('Бюджет в копейках.'),
  })
  .passthrough();

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'promotion_get_bbip_forecasts_by_items_v1',
    description: 'BBIP. Прогноз эффекта продвижения для списка объявлений (просмотры, контакты).',
    method: 'POST',
    path: '/promotion/v1/items/services/bbip/forecasts/get',
    domain: 'promotion',
    input: {
      items: z.array(ItemBudget).min(1).max(100).describe('До 100 объявлений с бюджетами.'),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_bbip_suggests_by_items_v1',
    description: 'BBIP. Рекомендуемые варианты бюджета продвижения для списка объявлений.',
    method: 'POST',
    path: '/promotion/v1/items/services/bbip/suggests/get',
    domain: 'promotion',
    input: {
      itemIds: z.array(z.number().int().positive()).optional().describe('ID объявлений.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_create_bbip_order_for_items_v1',
    description:
      '⚠️ ПЛАТНОЕ. BBIP — подключение услуги продвижения для объявлений. ' +
      'Списывает деньги с баланса. Подтверждайте у пользователя.',
    method: 'PUT',
    path: '/promotion/v1/items/services/bbip/orders/create',
    domain: 'promotion',
    input: {
      items: z.array(ItemBudget).min(1).max(100).describe('Объявления с бюджетами для продвижения.'),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_dict_of_services_v1',
    description: 'Справочник всех типов услуг продвижения (slug, название, описание).',
    method: 'POST',
    path: '/promotion/v1/items/services/dict',
    domain: 'promotion',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'promotion_get_services_by_items_v1',
    description: 'Список доступных услуг продвижения для конкретных объявлений.',
    method: 'POST',
    path: '/promotion/v1/items/services/get',
    domain: 'promotion',
    input: {
      itemIds: z.array(z.number().int().positive()).optional().describe('ID объявлений.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_list_orders_by_user_v1',
    description: 'Список заявок (orders) на продвижение пользователя с пагинацией.',
    method: 'POST',
    path: '/promotion/v1/items/services/orders/get',
    domain: 'promotion',
    input: {
      pagination: z
        .object({
          page: z.number().int().min(1).optional(),
          per_page: z.number().int().min(1).max(100).optional(),
        })
        .passthrough()
        .optional()
        .describe('Параметры пагинации.'),
    },
    body: { contentType: 'application/json', fields: ['pagination'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_order_status_v1',
    description: 'Статус заявки на продвижение по orderId (UUID).',
    method: 'POST',
    path: '/promotion/v1/items/services/orders/status',
    domain: 'promotion',
    input: {
      orderId: z.string().describe('UUID заявки на продвижение.'),
    },
    body: { contentType: 'application/json', fields: ['orderId'] },
  });
};
