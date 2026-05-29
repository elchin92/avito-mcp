/**
 * `user` domain — maps to swaggers/Информация о пользователе.json
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
    title: 'User profile',
    risk: 'read',
    description:
      'Returns the profile of the currently authorized account (get_user_info_self): numeric id (this is the Profile_id), email, name, verified phone numbers, and profile_url. Read-only, no parameters. Handy for finding out the Profile_id and checking which account the server is running under; for the balance use get_user_balance, for the list of operations use post_operations_history.',
    method: 'GET',
    path: '/core/v1/accounts/self',
    domain: 'core',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'user_get_user_balance',
    title: 'Wallet balance',
    risk: 'read',
    description:
      'Reads the account wallet balance (get_user_balance): the amount of real money (real) and the amount of bonus funds (bonus) in rubles. Read-only, a point-in-time snapshot. This is the Personal Account wallet, not the CPA balance (for CPA see the cpa domain). For the history of charges/top-ups use post_operations_history.',
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
          'Account number (Profile_id) in the Avito Personal Account, format int64. Optional: by default the Profile_id from .env (your own account) is substituted. You can find out the id via get_user_info_self.',
        ),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'user_post_operations_history',
    title: 'Operations history',
    risk: 'read',
    description:
      'Returns the list of account wallet operations for a period (post_operations_history): charges and top-ups in money and bonuses, with amountRub, amountBonus, amountTotal, operation type/name, service type (vas, cpa, tariff, etc.), itemId, and dates for each operation. Read-only. These are Personal Account wallet movements, not the CPA balance. Constraints: dateTimeFrom no more than a year ago, the range between from/to no more than one week; for the current balance use get_user_balance.',
    method: 'POST',
    path: '/core/v1/accounts/operations_history/',
    domain: 'core',
    input: {
      dateTimeFrom: z
        .string()
        .describe(
          'Start of the selection period, required. Format date-time ISO 8601, for example "2026-05-01T00:00:00". No more than one year ago from the current moment.',
        ),
      dateTimeTo: z
        .string()
        .describe(
          'End of the selection period, required. Format date-time ISO 8601, for example "2026-05-08T00:00:00". The range from dateTimeFrom is no more than one week (7 days).',
        ),
    },
    body: { contentType: 'application/json' },
  });
};
