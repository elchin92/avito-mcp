/**
 * Домен `cpa_target` — swaggers/Настройка цены целевого действия.json (5 endpoints).
 * Управление ставками за целевое действие (CPA promotion bids).
 *
 * ⚠️ Write: removePromotion / saveAutoBid / saveManualBid — меняют ставки/останавливают продвижение.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'cpa_target_get_bids',
    title: 'Целевое действие: ставки',
    risk: 'read',
    description:
      'Возвращает детализированную информацию о текущих и доступных ставках за целевое действие для ОДНОГО объявления: действующая цена/бюджет, минимум/максимум/рекомендация (всё в копейках), выбранная стратегия (manual/auto) и прогноз ЦД с преимуществом перед конкурентами. Read-only — расход не меняет. Используйте перед save_manual_bid/save_auto_bid, чтобы узнать допустимые min/max/рекомендуемые суммы. Для нескольких объявлений сразу используйте cpa_target_get_promotions_by_item_ids (batch до 200). Лимит: 20 запросов/мин.',
    method: 'GET',
    path: '/cpxpromo/1/getBids/{itemId}',
    domain: 'cpxpromo',
    input: {
      itemId: z.number().int().positive().describe('ID объявления Avito, для которого запрашиваются ставки и бюджеты.'),
    },
    pathParams: ['itemId'],
  });

  defineTool(server, ctx, {
    name: 'cpa_target_get_promotions_by_item_ids',
    title: 'Целевое действие: цены по объявлениям',
    risk: 'read',
    description:
      'Возвращает текущие ставки за целевое действие и бюджеты (в копейках) по НЕСКОЛЬКИМ объявлениям сразу (batch, до 200 за запрос): для каждого объявления — actionTypeID, активная manual- либо auto-стратегия с ценой/лимитом/бюджетом. Read-only — расход не меняет. Используйте для массовой проверки текущих настроек; для одного объявления с полными min/max/рекомендациями и прогнозом — cpa_target_get_bids. Лимит: 400 запросов/мин.',
    method: 'POST',
    path: '/cpxpromo/1/getPromotionsByItemIds',
    domain: 'cpxpromo',
    input: {
      itemIDs: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Список ID объявлений Avito (от 1 до 200 шт.), по которым нужны текущие ставки и бюджеты.'),
    },
    body: { contentType: 'application/json', fields: ['itemIDs'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_target_remove_promotion',
    title: '⚠️ Целевое действие: остановить',
    risk: 'write',
    description:
      '⚠️ ОСТАНАВЛИВАЕТ продвижение объявления за целевое действие и переключает его на базовую цену из прайс-листа. ВНИМАНИЕ: снимает действующую manual- или auto-ставку — настройки сбрасываются и для возврата продвижения их придётся задать заново (save_manual_bid/save_auto_bid). Не уменьшает расход до нуля: объявление продолжит тарифицироваться по базовой цене ЦД. Возвращает текстовое сообщение о переключении. Лимит: 300 запросов/мин.',
    destructiveHint: true,
    method: 'POST',
    path: '/cpxpromo/1/remove',
    domain: 'cpxpromo',
    input: {
      itemID: z.number().int().positive().describe('ID объявления Avito, у которого нужно остановить продвижение за целевое действие.'),
    },
    body: { contentType: 'application/json', fields: ['itemID'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_target_save_auto_bid',
    title: '⚠️ Целевое действие: авто-ставка',
    risk: 'money',
    description:
      '⚠️ Включает АВТОМАТИЧЕСКУЮ стратегию ставок за целевое действие: система сама подбирает цену в рамках заданного бюджета. ВНИМАНИЕ: влияет на расход бюджета (money) — задаёт трату budgetPenny за период budgetType. Взаимоисключающе с ручной ставкой: вызов перезапишет ранее заданную manual-стратегию для этого объявления. Используйте, когда хотите делегировать управление ценой Avito (а не фиксировать сумму вручную — для этого save_manual_bid). budgetPenny должен укладываться в min/maxBudgetPenny из cpa_target_get_bids. Недоступно в категории «Транспорт». Лимит: 10 запросов/мин.',
    method: 'POST',
    path: '/cpxpromo/1/setAuto',
    domain: 'cpxpromo',
    input: {
      itemID: z.number().int().positive().describe('ID объявления Avito, для которого включается авто-стратегия.'),
      actionTypeID: z
        .number()
        .int()
        .describe('Тип целевого действия: 1 — звонок, 5 — пакет кликов, 7 — мессенджер (передача контакта в чате).'),
      budgetType: z
        .string()
        .describe('Период бюджета: "1d" — дневной, "7d" — недельный, "30d" — месячный.'),
      budgetPenny: z
        .number()
        .int()
        .positive()
        .describe('Бюджет в КОПЕЙКАХ на период budgetType (напр. 1400 = 14 руб.). Должен быть в пределах min/maxBudgetPenny из cpa_target_get_bids.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['itemID', 'actionTypeID', 'budgetType', 'budgetPenny'],
    },
  });

  defineTool(server, ctx, {
    name: 'cpa_target_save_manual_bid',
    title: '⚠️ Целевое действие: ручная ставка',
    risk: 'money',
    description:
      '⚠️ Устанавливает РУЧНУЮ (фиксированную) ставку за целевое действие для объявления (manual bid). ВНИМАНИЕ: влияет на расход бюджета (money) — каждое целевое действие тарифицируется по bidPenny, дневная трата ограничена limitPenny. Взаимоисключающе с авто-ставкой: вызов перезапишет ранее заданную auto-стратегию для этого объявления. Используйте, когда хотите сами контролировать цену за действие (делегировать подбор Avito — save_auto_bid). bidPenny должен быть не ниже minBidPenny из cpa_target_get_bids. Лимит: 20 запросов/мин.',
    method: 'POST',
    path: '/cpxpromo/1/setManual',
    domain: 'cpxpromo',
    input: {
      itemID: z.number().int().positive().describe('ID объявления Avito, для которого задаётся ручная ставка.'),
      actionTypeID: z
        .number()
        .int()
        .describe('Тип целевого действия: 1 — звонок, 5 — пакет кликов, 7 — мессенджер (передача контакта в чате).'),
      bidPenny: z
        .number()
        .int()
        .positive()
        .describe('Цена за одно целевое действие в КОПЕЙКАХ (напр. 1400 = 14 руб.). Должна быть не ниже minBidPenny из cpa_target_get_bids.'),
      limitPenny: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Необязательный дневной лимит трат в КОПЕЙКАХ. Если не задан — лимит не применяется. Допустимый диапазон min/maxLimitPenny см. в cpa_target_get_bids.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['itemID', 'actionTypeID', 'bidPenny', 'limitPenny'],
    },
  });
};
