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
    risk: 'read',
    description:
      'Возвращает идентификатор пользователя и его регистрационные данные (email, имя, телефоны, profile_url).',
    method: 'GET',
    path: '/core/v1/accounts/self',
    domain: 'core',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'user_get_user_balance',
    risk: 'read',
    description:
      'Возвращает баланс кошелька авторизованного пользователя: сумму реальных денег (real) ' +
      'и сумму бонусных средств (bonus).',
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
          'Номер пользователя в Личном кабинете Авито. По умолчанию — Profile_id из .env (свой аккаунт).',
        ),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'user_post_operations_history',
    risk: 'read',
    description:
      'Возвращает список операций (списания/пополнение кошелька) за период. ' +
      'Ограничения: dateTimeFrom не далее года в прошлое, диапазон между from/to не более одной недели. ' +
      'Формат дат — ISO 8601 (например, "2026-05-01T00:00:00").',
    method: 'POST',
    path: '/core/v1/accounts/operations_history/',
    domain: 'core',
    input: {
      dateTimeFrom: z
        .string()
        .describe('Начало периода (ISO 8601, например "2026-05-01T00:00:00"). Не далее года назад.'),
      dateTimeTo: z
        .string()
        .describe('Конец периода (ISO 8601). Диапазон от dateTimeFrom — не более 7 дней.'),
    },
    body: { contentType: 'application/json' },
  });
};
