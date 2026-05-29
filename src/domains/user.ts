/**
 * Домен `user` — соответствует swaggers/Информация о пользователе.json
 *
 * Endpoints (3):
 *   GET  /core/v1/accounts/self                    → getUserInfoSelf
 *   GET  /core/v1/accounts/{user_id}/balance/      → getUserBalance     (injectProfileId)
 *   POST /core/v1/accounts/operations_history/     → postOperationsHistory
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'user_get_user_info_self',
    title: 'Профиль пользователя',
    risk: 'read',
    description:
      'Возвращает профиль текущего авторизованного аккаунта (get_user_info_self): числовой id (это и есть Profile_id), email, имя, верифицированные телефоны и profile_url. Только чтение, без параметров. Удобно, чтобы узнать Profile_id и проверить, под каким аккаунтом работает сервер; для баланса используйте get_user_balance, для списка операций — post_operations_history.',
    method: 'GET',
    path: '/core/v1/accounts/self',
    domain: 'core',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'user_get_user_balance',
    title: 'Баланс кошелька',
    risk: 'read',
    description:
      'Читает баланс кошелька аккаунта (get_user_balance): сумму реальных денег (real) и сумму бонусных средств (bonus) в рублях. Только чтение, моментальный снимок. Это кошелёк Личного кабинета, а не CPA-баланс (для CPA смотрите домен cpa). Для истории списаний/пополнений используйте post_operations_history.',
    method: 'GET',
    path: '/core/v1/accounts/{user_id}/balance/',
    domain: 'core',
    input: {
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Номер аккаунта (Profile_id) в Личном кабинете Авито, format int64. Необязательный: по умолчанию подставляется Profile_id из .env (свой аккаунт). Узнать id можно через get_user_info_self.',
        ),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'user_post_operations_history',
    title: 'История операций',
    risk: 'read',
    description:
      'Возвращает список операций по кошельку аккаунта за период (post_operations_history): списания и пополнения деньгами и бонусами, по каждой операции — amountRub, amountBonus, amountTotal, тип/название операции, тип услуги (vas, cpa, tariff и др.), itemId и даты. Только чтение. Это движения кошелька Личного кабинета, не CPA-баланс. Ограничения: dateTimeFrom не далее года назад, диапазон between from/to — не более одной недели; для текущего остатка используйте get_user_balance.',
    method: 'POST',
    path: '/core/v1/accounts/operations_history/',
    domain: 'core',
    input: {
      dateTimeFrom: z
        .string()
        .describe(
          'Начало периода выборки, обязательное. Формат date-time ISO 8601, например "2026-05-01T00:00:00". Не далее одного года назад от текущего момента.',
        ),
      dateTimeTo: z
        .string()
        .describe(
          'Конец периода выборки, обязательное. Формат date-time ISO 8601, например "2026-05-08T00:00:00". Диапазон от dateTimeFrom — не более одной недели (7 дней).',
        ),
    },
    body: { contentType: 'application/json' },
  });
};
