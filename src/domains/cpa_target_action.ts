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
    risk: 'read',
    description:
      'Детализированная информация о действующих и доступных ценах за целевое действие для одного объявления.',
    method: 'GET',
    path: '/cpxpromo/1/getBids/{itemId}',
    domain: 'cpxpromo',
    input: {
      itemId: z.number().int().positive().describe('ID объявления.'),
    },
    pathParams: ['itemId'],
  });

  defineTool(server, ctx, {
    name: 'cpa_target_get_promotions_by_item_ids',
    risk: 'read',
    description: 'Текущие цены за целевое действие и бюджеты по нескольким объявлениям (batch).',
    method: 'POST',
    path: '/cpxpromo/1/getPromotionsByItemIds',
    domain: 'cpxpromo',
    input: {
      itemIDs: z.array(z.number().int().positive()).min(1).describe('ID объявлений.'),
    },
    body: { contentType: 'application/json', fields: ['itemIDs'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_target_remove_promotion',
    risk: 'write',
    description: '⚠️ ОСТАНАВЛИВАЕТ продвижение объявления по itemID.',
    method: 'POST',
    path: '/cpxpromo/1/remove',
    domain: 'cpxpromo',
    input: {
      itemID: z.number().int().positive().describe('ID объявления.'),
    },
    body: { contentType: 'application/json', fields: ['itemID'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_target_save_auto_bid',
    risk: 'money',
    description:
      '⚠️ Применение автоматической настройки ставки. budgetPenny — бюджет в копейках, ' +
      'budgetType — тип бюджета (см. swagger). actionTypeID — тип целевого действия.',
    method: 'POST',
    path: '/cpxpromo/1/setAuto',
    domain: 'cpxpromo',
    input: {
      itemID: z.number().int().positive().describe('ID объявления.'),
      actionTypeID: z.number().int().describe('Тип целевого действия.'),
      budgetType: z.string().describe('Тип бюджета (см. swagger).'),
      budgetPenny: z.number().int().positive().describe('Бюджет в копейках.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['itemID', 'actionTypeID', 'budgetType', 'budgetPenny'],
    },
  });

  defineTool(server, ctx, {
    name: 'cpa_target_save_manual_bid',
    risk: 'money',
    description:
      '⚠️ Применение ручной ставки. bidPenny — ставка за действие в копейках, ' +
      'limitPenny — суточный лимит бюджета в копейках.',
    method: 'POST',
    path: '/cpxpromo/1/setManual',
    domain: 'cpxpromo',
    input: {
      itemID: z.number().int().positive().describe('ID объявления.'),
      actionTypeID: z.number().int().describe('Тип целевого действия.'),
      bidPenny: z.number().int().positive().describe('Ставка за действие в копейках.'),
      limitPenny: z.number().int().positive().optional().describe('Суточный лимит в копейках.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['itemID', 'actionTypeID', 'bidPenny', 'limitPenny'],
    },
  });
};
