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
    itemId: z.number().int().positive().describe('ID объявления Avito (int64), для которого подключается продвижение.'),
    duration: z
      .number()
      .int()
      .positive()
      .describe(
        'Срок продвижения в ДНЯХ. Возьмите suggests.duration.recommended (обычно 5–7); ' +
          'допустимый диапазон — suggests.duration.from..to.',
      ),
    oldPrice: z
      .number()
      .int()
      .positive()
      .describe(
        'Общая ценность продвижения за ОДИН день в КОПЕЙКАХ (до скидок/акций). ' +
          'Берётся из suggests budgets[].oldPrice. Полная цена за период = price × duration.',
      ),
    price: z
      .number()
      .int()
      .positive()
      .describe(
        'Стоимость продвижения за ОДИН день в КОПЕЙКАХ (к списанию). ' +
          'Берётся из suggests budgets[].price. Полный бюджет = price × duration.',
      ),
  })
  .passthrough();

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'promotion_get_bbip_forecasts_by_items_v1',
    title: 'BBIP: прогноз эффекта',
    risk: 'read',
    description:
      'Возвращает прогноз эффекта продвижения BBIP (ставка/бюджет продвижения объявлений): ожидаемый прирост ' +
      'просмотров (min/max) и общую стоимость за период. READ-ONLY: денег НЕ тратит, используйте ДО ' +
      'promotion_create_bbip_order_for_items_v1, чтобы оценить отдачу. Для каждого объявления передайте ' +
      '{itemId, duration, oldPrice, price} — те же значения, что и для create; берите их из ' +
      'promotion_get_bbip_suggests_by_items_v1 (budgets[].{oldPrice,price} — копейки/день, duration.recommended — дни). ' +
      'Возвращает items[].{min,max,totalPrice} (копейки) и общий totalPrice.',
    method: 'POST',
    path: '/promotion/v1/items/services/bbip/forecasts/get',
    domain: 'promotion',
    input: {
      items: z
        .array(BbipOrderItem)
        .min(1)
        .max(100)
        .describe(
          'От 1 до 100 объявлений для прогноза. Каждый элемент — {itemId, duration, oldPrice, price}, ' +
            'значения брать из promotion_get_bbip_suggests_by_items_v1.',
        ),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_bbip_suggests_by_items_v1',
    title: 'BBIP: рекомендации бюджета',
    risk: 'read',
    description:
      'Возвращает рекомендованные варианты ставки/бюджета продвижения BBIP по объявлениям. READ-ONLY: денег НЕ тратит. ' +
      'Это первый шаг сценария BBIP: из ответа берите items[].budgets[].{oldPrice,price} (копейки/день, ' +
      'isRecommended помечает рекомендованный) и items[].duration.{from,to,recommended} (дни), затем передавайте ' +
      'их в promotion_get_bbip_forecasts_by_items_v1 (прогноз) и promotion_create_bbip_order_for_items_v1 (платная покупка).',
    method: 'POST',
    path: '/promotion/v1/items/services/bbip/suggests/get',
    domain: 'promotion',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .optional()
        .describe('ID объявлений Avito (int64), для которых нужны варианты бюджета. До 100 шт.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_create_bbip_order_for_items_v1',
    title: '⚠️ BBIP: купить продвижение',
    risk: 'money',
    description:
      '⚠️ ПЛАТНОЕ ДЕЙСТВИЕ (money): создаёт заявку BBIP на подключение продвижения объявлений и СПИСЫВАЕТ бюджет ' +
      'с баланса аккаунта. Заявка создаётся только если по всем объявлениям нет ошибок; при недостатке средств — 402. ' +
      'СНАЧАЛА оцените стоимость и отдачу бесплатно: promotion_get_bbip_suggests_by_items_v1 (варианты бюджета) → ' +
      'promotion_get_bbip_forecasts_by_items_v1 (прогноз). Затем для каждого объявления передайте сюда вариант из ' +
      'suggests как {itemId, duration, oldPrice, price} (oldPrice/price — копейки/день, duration — дни; полный бюджет = ' +
      'price × duration). Возвращает orderId (UUID) — проверяйте статус через promotion_get_order_status_v1.',
    method: 'PUT',
    path: '/promotion/v1/items/services/bbip/orders/create',
    domain: 'promotion',
    input: {
      items: z
        .array(BbipOrderItem)
        .min(1)
        .max(100)
        .describe(
          'От 1 до 100 объявлений для платного продвижения. Каждый элемент — {itemId, duration, oldPrice, price} ' +
            'из promotion_get_bbip_suggests_by_items_v1. Заявка отклоняется целиком, если по любому объявлению есть ошибка.',
        ),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_dict_of_services_v1',
    title: 'Продвижение: справочник услуг',
    risk: 'read',
    description:
      'Возвращает справочник всех типов услуг продвижения Avito: для каждой услуги — slug (идентификатор типа), ' +
      'name (название) и isDeprecated (устарела ли). READ-ONLY: денег НЕ тратит, параметров не требует. ' +
      'Используйте как справочник для расшифровки slug в ответах других promotion-методов.',
    method: 'POST',
    path: '/promotion/v1/items/services/dict',
    domain: 'promotion',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'promotion_get_services_by_items_v1',
    title: 'Продвижение: услуги по объявлениям',
    risk: 'read',
    description:
      'Возвращает активные услуги продвижения по указанным объявлениям: для каждого objявления список услуг с ' +
      'slug, name и датами startDate/endDate. READ-ONLY: денег НЕ тратит. Используйте, чтобы узнать, какое ' +
      'продвижение уже подключено и до какого числа действует (не путать с suggests, которые предлагают новые варианты бюджета).',
    method: 'POST',
    path: '/promotion/v1/items/services/get',
    domain: 'promotion',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .optional()
        .describe('ID объявлений Avito (int64), по которым нужны активные услуги продвижения. До 100 шт.'),
    },
    body: { contentType: 'application/json', fields: ['itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_list_orders_by_user_v1',
    title: 'Продвижение: список заявок',
    risk: 'read',
    description:
      'Возвращает список заявок (orders) на продвижение текущего пользователя с пагинацией: id (UUID), createdAt и ' +
      'status каждой заявки. READ-ONLY: денег НЕ тратит. Используйте для истории/обзора заявок; детальный статус ' +
      'конкретной заявки — через promotion_get_order_status_v1 по её orderId.',
    method: 'POST',
    path: '/promotion/v1/items/services/orders/get',
    domain: 'promotion',
    input: {
      pagination: z
        .object({
          page: z.number().int().min(1).optional().describe('Номер страницы, начиная с 1 (по умолчанию 1).'),
          perPage: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Кол-во записей на странице, 1–100 (по умолчанию 20). Имя поля строго camelCase.'),
        })
        .passthrough()
        .optional()
        .describe('Параметры постраничного чтения {page, perPage}. Можно опустить — вернётся первая страница.'),
    },
    body: { contentType: 'application/json', fields: ['pagination'] },
  });

  defineTool(server, ctx, {
    name: 'promotion_get_order_status_v1',
    title: 'Продвижение: статус заявки',
    risk: 'read',
    description:
      'Возвращает статус заявки BBIP по её orderId: общий status заявки (initialized/waiting/in_process/processed), ' +
      'totalPrice (копейки) и постатейный статус по каждому объявлению (slug, price, errorReason). READ-ONLY: денег НЕ тратит. ' +
      'Вызывайте ПОСЛЕ promotion_create_bbip_order_for_items_v1, чтобы отследить выполнение заявки.',
    method: 'POST',
    path: '/promotion/v1/items/services/orders/status',
    domain: 'promotion',
    input: {
      orderId: z
        .string()
        .describe('Идентификатор заявки на продвижение в формате UUID, полученный из promotion_create_bbip_order_for_items_v1.'),
    },
    body: { contentType: 'application/json', fields: ['orderId'] },
  });
};
