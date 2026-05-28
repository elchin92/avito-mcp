/**
 * Домен `promotion` — swaggers/Продвижение.json (7 endpoints).
 * BBIP = "большой бюджет интегрированного продвижения" — комплексные услуги Avito.
 *
 * ⚠️ Write: create_bbip_order — РЕАЛЬНАЯ ПОКУПКА продвижения, тратит деньги с баланса.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

// Реальный контракт Avito BBIP: и forecasts (BbipForecastRequestByItemV1), и create
// (BbipOrderByItemV1) требуют ОДИНАКОВЫЙ набор itemId+duration+oldPrice+price.
// Значения берутся из promotion_get_bbip_suggests_by_items_v1: budgets[].{oldPrice,price}
// (копейки/день) и duration.recommended (дни). Поле `budget` Avito НЕ принимает — отсюда
// была ошибка «Не удалось найти бюджет продвижения по указанным параметрам» (v0.7.1 чинил
// только create; v0.7.2 чинит и forecasts, который ошибочно слал {itemId, budget}).
const BbipOrderItem = z
  .object({
    itemId: z.number().int().positive().describe('ID объявления.'),
    duration: z
      .number()
      .int()
      .positive()
      .describe('Период продвижения в днях (suggests.duration.recommended, обычно 7).'),
    oldPrice: z
      .number()
      .int()
      .positive()
      .describe('Общая ценность продвижения за один день, в копейках (suggests budgets[].oldPrice).'),
    price: z
      .number()
      .int()
      .positive()
      .describe('Стоимость продвижения за один день, в копейках (suggests budgets[].price).'),
  })
  .passthrough();

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'promotion_get_bbip_forecasts_by_items_v1',
    title: 'BBIP: прогноз эффекта',
    risk: 'read',
    description:
      'BBIP. Прогноз эффекта продвижения для списка объявлений (просмотры, контакты). ' +
      'Для каждого объявления передай {itemId, duration, oldPrice, price} — те же значения, что и для ' +
      'create: возьми из promotion_get_bbip_suggests_by_items_v1 (budgets[].{oldPrice,price} в копейках/день, ' +
      'duration.recommended в днях).',
    method: 'POST',
    path: '/promotion/v1/items/services/bbip/forecasts/get',
    domain: 'promotion',
    input: {
      items: z
        .array(BbipOrderItem)
        .min(1)
        .max(100)
        .describe('До 100 объявлений: {itemId, duration, oldPrice, price} из suggests.'),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_bbip_suggests_by_items_v1',
    title: 'BBIP: рекомендации бюджета',
    risk: 'read',
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
    title: '⚠️ BBIP: купить продвижение',
    risk: 'money',
    description:
      '⚠️ ПЛАТНОЕ. BBIP — подключение услуги продвижения для объявлений. Списывает деньги с баланса. ' +
      'Сначала вызови promotion_get_bbip_suggests_by_items_v1; для каждого товара возьми вариант из ' +
      'budgets[] (поля oldPrice и price, в копейках за день) и duration.recommended (дни), и передай ' +
      'их сюда как {itemId, duration, oldPrice, price}. Полный бюджет = price × duration.',
    method: 'PUT',
    path: '/promotion/v1/items/services/bbip/orders/create',
    domain: 'promotion',
    input: {
      items: z
        .array(BbipOrderItem)
        .min(1)
        .max(100)
        .describe('Объявления для продвижения: {itemId, duration, oldPrice, price} из suggests.'),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_dict_of_services_v1',
    title: 'Продвижение: справочник услуг',
    risk: 'read',
    description: 'Справочник всех типов услуг продвижения (slug, название, описание).',
    method: 'POST',
    path: '/promotion/v1/items/services/dict',
    domain: 'promotion',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'promotion_get_services_by_items_v1',
    title: 'Продвижение: услуги по объявлениям',
    risk: 'read',
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
    title: 'Продвижение: список заявок',
    risk: 'read',
    description: 'Список заявок (orders) на продвижение пользователя с пагинацией.',
    method: 'POST',
    path: '/promotion/v1/items/services/orders/get',
    domain: 'promotion',
    input: {
      pagination: z
        .object({
          page: z.number().int().min(1).optional(),
          perPage: z.number().int().min(1).max(100).optional().describe('Размер страницы (camelCase!).'),
        })
        .passthrough()
        .optional()
        .describe('Параметры пагинации: {page, perPage}.'),
    },
    body: { contentType: 'application/json', fields: ['pagination'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_order_status_v1',
    title: 'Продвижение: статус заявки',
    risk: 'read',
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
