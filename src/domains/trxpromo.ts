/**
 * Домен `trxpromo` — swaggers/TrxPromo.json (3 endpoints).
 * Транзакционное продвижение (комиссия за результат).
 *
 * Quirks: GET /trx-promo/1/commissions принимает body — нестандартно, но Avito делает так.
 *
 * ⚠️ Write: apply (запуск) / cancel (остановка) продвижения.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'trxpromo_get_commissions',
    title: 'TrxPromo: комиссии',
    risk: 'read',
    description:
      'Проверяет доступность транзакционного промо и допустимый размер комиссий для объявлений (trxpromo_get_commissions, read-only — ничего не запускает и не списывает). ' +
      'Для каждого объявления возвращает флаг promoAvailable и настройки settings: минимум/максимум/шаг комиссии в сотых долях процента (100 = 1%). ' +
      'Используйте перед trxpromo_apply, чтобы узнать границы комиссии. Запуск промо — trxpromo_apply, отмена — trxpromo_cancel. ' +
      'Это GET с телом запроса — нестандартно, но именно так задано в swagger Avito.',
    method: 'GET',
    path: '/trx-promo/1/commissions',
    domain: 'trx-promo',
    input: {
      itemIDs: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Массив ID объявлений на Авито, для которых проверяется доступность промо и размер комиссий.'),
    },
    body: { contentType: 'application/json', fields: ['itemIDs'] },
  });

  defineTool(server, ctx, {
    name: 'trxpromo_apply',
    title: '⚠️ TrxPromo: запустить продвижение',
    risk: 'money',
    description:
      '⚠️ Применяет транзакционное промо/продвижение за комиссию к объявлениям (trxpromo_apply). Влияет на цену/расход: плата за продвижение прибавляется к базовой комиссии. ' +
      'В ответе по каждому объявлению — флаг success, при ошибке код 1001 (валидация) или 1002 (промо недоступно) и допустимый диапазон комиссии. ' +
      'Сначала узнайте границы через trxpromo_get_commissions; отменить запущенное промо — trxpromo_cancel.',
    method: 'POST',
    path: '/trx-promo/1/apply',
    domain: 'trx-promo',
    input: {
      items: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          'Массив объявлений для продвижения. Каждый элемент: itemID (число, ID объявления, обязателен), ' +
            'commission (плата за продвижение в сотых долях процента, 1500 = 15%; обязательна), ' +
            'dateFrom (дата начала продвижения «ГГГГ-ММ-ДД», обязательна), ' +
            'dateTo (дата окончания «ГГГГ-ММ-ДД», опционально — иначе все свободные даты). См. swaggers/TrxPromo.json.',
        ),
    },
    body: { contentType: 'application/json', fields: ['items'] },
  });

  defineTool(server, ctx, {
    name: 'trxpromo_cancel',
    title: '⚠️ TrxPromo: остановить',
    risk: 'write',
    destructiveHint: true,
    description:
      '⚠️ Отменяет действующее и запланированное транзакционное промо для объявлений (trxpromo_cancel). Откатывает эффект trxpromo_apply — продвижение и связанная с ним комиссия перестают действовать. ' +
      'В ответе по каждому объявлению — флаг success, при ошибке код 1001 (валидация) или 1002 (промо недоступно). ' +
      'Применить промо заново — trxpromo_apply; узнать комиссии — trxpromo_get_commissions (read-only).',
    method: 'POST',
    path: '/trx-promo/1/cancel',
    domain: 'trx-promo',
    input: {
      itemIDs: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Массив ID объявлений на Авито, для которых отменяется действующее и запланированное промо.'),
    },
    body: { contentType: 'application/json', fields: ['itemIDs'] },
  });
};
