/**
 * Домен `cpa` — swaggers/CPA Авито.json (11 endpoints).
 * CPA (Cost-Per-Action): звонки, чаты, балансы, жалобы.
 *
 * Quirks: operationId `chatsByTime` встречается дважды (v1 + v2). Имена унифицированы
 * через префикс домена + версия (cpa_chats_by_time_v1 и cpa_chats_by_time_v2).
 *
 * ⚠️ Write: createComplaint(ByActionId) — создание жалобы (необратимо).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'cpa_get_call',
    title: 'CPA: запись звонка (v1, deprecated)',
    risk: 'read',
    description: '(deprecated, используйте cpa_get_call_by_id_v2) Запись звонка по call_id.',
    method: 'GET',
    path: '/cpa/v1/call/{call_id}',
    domain: 'cpa',
    input: {
      call_id: z.number().int().positive().describe('ID звонка.'),
    },
    pathParams: ['call_id'],
  });

  defineTool(server, ctx, {
    name: 'cpa_chat_by_action_id',
    title: 'CPA: чат по actionId',
    risk: 'read',
    description: 'Информация о чате CPA по actionId.',
    method: 'GET',
    path: '/cpa/v1/chatByActionId/{actionId}',
    domain: 'cpa',
    input: {
      actionId: z.number().int().positive().describe('ID действия CPA.'),
    },
    pathParams: ['actionId'],
  });

  defineTool(server, ctx, {
    name: 'cpa_chats_by_time_v1',
    title: 'CPA: чаты за период (v1, deprecated)',
    risk: 'read',
    description: '(deprecated, используйте cpa_chats_by_time_v2) Чаты CPA за период.',
    method: 'POST',
    path: '/cpa/v1/chatsByTime',
    domain: 'cpa',
    input: {
      dateTimeFrom: z.string().describe('Начало периода (ISO 8601).'),
      limit: z.number().int().min(1).max(1000).describe('Сколько чатов вернуть.'),
      offset: z.number().int().min(0).describe('Смещение пагинации.'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_post_create_complaint',
    title: '⚠️ CPA: жалоба на звонок',
    risk: 'write',
    description: '⚠️ Создание жалобы на звонок CPA (необратимо).',
    method: 'POST',
    path: '/cpa/v1/createComplaint',
    domain: 'cpa',
    input: {
      callId: z.number().int().positive().describe('ID звонка.'),
      message: z.string().min(1).describe('Текст жалобы.'),
    },
    body: { contentType: 'application/json', fields: ['callId', 'message'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_create_complaint_by_action_id',
    title: '⚠️ CPA: жалоба по actionId',
    risk: 'write',
    description: '⚠️ Создание жалобы на звонок или чат CPA по actionId (необратимо).',
    method: 'POST',
    path: '/cpa/v1/createComplaintByActionId',
    domain: 'cpa',
    input: {
      actionId: z.number().int().positive().describe('ID действия CPA (звонок или чат).'),
      message: z.string().min(1).describe('Текст жалобы.'),
    },
    body: { contentType: 'application/json', fields: ['actionId', 'message'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_phones_info_from_chats',
    title: 'CPA: телефоны из чатов',
    risk: 'read',
    description: 'Информация по номерам телефонов из целевых чатов CPA за период.',
    method: 'POST',
    path: '/cpa/v1/phonesInfoFromChats',
    domain: 'cpa',
    input: {
      dateTimeFrom: z.string().describe('Начало периода (ISO 8601).'),
      limit: z.number().int().min(1).max(1000),
      offset: z.number().int().min(0),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_balance_info_v2',
    title: 'CPA: баланс (v2, deprecated)',
    risk: 'read',
    description: '(deprecated, используйте cpa_balance_info_v3) Баланс CPA. Body: пустой `{}`.',
    method: 'POST',
    path: '/cpa/v2/balanceInfo',
    domain: 'cpa',
    input: {},
    body: { contentType: 'application/json', defaults: {} },
  });

  defineTool(server, ctx, {
    name: 'cpa_get_call_by_id_v2',
    title: 'CPA: звонок по callId',
    risk: 'read',
    description: 'Звонок CPA по callId с записью.',
    method: 'POST',
    path: '/cpa/v2/callById',
    domain: 'cpa',
    input: {
      callId: z.number().int().positive().describe('ID звонка.'),
    },
    body: { contentType: 'application/json', fields: ['callId'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_get_calls_by_time_v2',
    title: 'CPA: звонки за период',
    risk: 'read',
    description: 'Звонки CPA за период (с пагинацией). dateTimeFrom — ISO 8601.',
    method: 'POST',
    path: '/cpa/v2/callsByTime',
    domain: 'cpa',
    input: {
      dateTimeFrom: z.string().describe('Начало периода (ISO 8601).'),
      limit: z.number().int().min(1).max(1000),
      offset: z.number().int().min(0).optional(),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_chats_by_time_v2',
    title: 'CPA: чаты за период',
    risk: 'read',
    description: 'Чаты CPA за период v2 (с пагинацией).',
    method: 'POST',
    path: '/cpa/v2/chatsByTime',
    domain: 'cpa',
    input: {
      dateTimeFrom: z.string().describe('Начало периода (ISO 8601).'),
      limit: z.number().int().min(1).max(1000),
      offset: z.number().int().min(0),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_balance_info_v3',
    title: 'CPA: баланс',
    risk: 'read',
    description: 'Баланс CPA (v3 — актуальная). Body: пустой `{}`.',
    method: 'POST',
    path: '/cpa/v3/balanceInfo',
    domain: 'cpa',
    input: {},
    body: { contentType: 'application/json', defaults: {} },
  });
};
