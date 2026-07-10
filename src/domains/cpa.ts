/**
 * `cpa` domain — swaggers/cpa.json (11 endpoints).
 * CPA (Cost-Per-Action): calls, chats, balances, complaints.
 *
 * Quirks: the `chatsByTime` operationId appears twice (v1 + v2). Names are unified
 * via the domain prefix + version (cpa_chats_by_time_v1 and cpa_chats_by_time_v2).
 *
 * ⚠️ Public: createComplaint(ByActionId) — files an external complaint (irreversible).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  const staticHeaders = { 'X-Source': ctx.config.cpaSource } as const;

  defineTool(server, ctx, {
    name: 'cpa_get_call',
    title: 'CPA: call recording (v1, deprecated)',
    risk: 'read',
    description:
      'Returns the recording (audio) of a CPA call by its identifier (v1, deprecated). Read-only, spends no money. Deprecated — prefer cpa_get_call_by_id_v2 (or calltracking get_record_by_call_id), which return the full call model together with the recording. Limit: 1 request/min.',
    method: 'GET',
    path: '/cpa/v1/call/{call_id}',
    domain: 'cpa',
    staticHeaders,
    input: {
      call_id: z.number().int().positive().describe('CPA call identifier (call_id), obtained from cpa_get_calls_by_time_v2 or from a chat/action.'),
    },
    pathParams: ['call_id'],
  });

  defineTool(server, ctx, {
    name: 'cpa_chat_by_action_id',
    title: 'CPA: chat by actionId',
    risk: 'read',
    description:
      'Returns the CPA chat model by target-action identifier (actionId). Read-only, spends no money. Use when you already have the actionId of a specific chat (from cpa_chats_by_time_v2); not for iterating by time. Limit: 3 requests/min.',
    method: 'GET',
    path: '/cpa/v1/chatByActionId/{actionId}',
    domain: 'cpa',
    staticHeaders,
    input: {
      actionId: z.number().int().positive().describe('CPA target-action identifier (chat actionId), obtained from cpa_chats_by_time_v2.'),
    },
    pathParams: ['actionId'],
  });

  defineTool(server, ctx, {
    name: 'cpa_chats_by_time_v1',
    title: 'CPA: chats for a period (v1, deprecated)',
    risk: 'read',
    description:
      'Returns a paginated list of target CPA chats created starting from the given moment (v1, deprecated). Read-only, spends no money. Deprecated — prefer cpa_chats_by_time_v2 (identical semantics, higher request limit: 40 vs 60/min for v1, but v2 is the current version).',
    method: 'POST',
    path: '/cpa/v1/chatsByTime',
    domain: 'cpa',
    staticHeaders,
    input: {
      dateTimeFrom: z.string().describe('Moment from which to search chats by the date field, in RFC3339 format, e.g. "2021-01-02T15:04:05Z".'),
      limit: z.number().int().min(1).max(100).describe('Page size (number of chats), no more than 100.'),
      offset: z.number().int().min(0).describe('Page offset (default 0). For performance, prefer passing the maximum startTime/date of a chat from the previous page.'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_post_create_complaint',
    title: '⚠️ CPA: complaint about a call',
    risk: 'public',
    destructiveHint: true,
    description:
      '⚠️ Files an external complaint with Avito about a CPA call by its callId (action record) — e.g. when disputing a charge for an off-target call. Irreversible record: a complaint cannot be withdrawn, so confirmation is required by default. Requires the callId of a specific call from a preceding call (cpa_get_calls_by_time_v2). To file complaints about both calls and chats by a single actionId, use cpa_create_complaint_by_action_id. Limit: 1 request/min.',
    method: 'POST',
    path: '/cpa/v1/createComplaint',
    domain: 'cpa',
    staticHeaders,
    input: {
      callId: z.number().int().positive().describe('CPA call identifier (callId, int64) the complaint is filed against.'),
      message: z.string().min(1).describe('Complaint text — a description of the reason for disputing the target action.'),
    },
    body: { contentType: 'application/json', fields: ['callId', 'message'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_create_complaint_by_action_id',
    title: '⚠️ CPA: complaint by actionId',
    risk: 'public',
    destructiveHint: true,
    description:
      '⚠️ Files an external complaint with Avito about a CPA target action (call or chat) by its actionId — to dispute a charge for an off-target action. Irreversible record: a complaint cannot be withdrawn, so confirmation is required by default. Requires the actionId from a preceding call (cpa_chats_by_time_v2 / cpa_get_calls_by_time_v2). Preferred over cpa_post_create_complaint, since it covers both calls and chats. Limit: 3 requests/min.',
    method: 'POST',
    path: '/cpa/v1/createComplaintByActionId',
    domain: 'cpa',
    staticHeaders,
    input: {
      actionId: z.number().int().positive().describe('CPA target-action identifier (actionId of a call or chat, e.g. 123456789) the complaint is filed against.'),
      message: z.string().min(1).describe('Complaint text attached to the action, e.g. "this was not a contact exchange in the chat".'),
    },
    body: { contentType: 'application/json', fields: ['actionId', 'message'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_phones_info_from_chats',
    title: 'CPA: phone numbers from chats',
    risk: 'read',
    description:
      'Returns a paginated set of information on phone numbers extracted from target CPA chats starting from the given moment. Read-only, spends no money. Use to export customer contacts from correspondence over a period. Limit: 5 requests/min.',
    method: 'POST',
    path: '/cpa/v1/phonesInfoFromChats',
    domain: 'cpa',
    staticHeaders,
    input: {
      dateTimeFrom: z.string().describe('Moment from which the search begins, in RFC3339 format, e.g. "2021-01-02T15:04:05Z".'),
      limit: z.number().int().min(1).max(1000).describe('Page size (number of records).'),
      offset: z.number().int().min(0).describe('Page offset (default 0) for page-by-page iteration.'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_balance_info_v2',
    title: 'CPA: balance (v2, deprecated)',
    risk: 'read',
    description:
      'Returns the CPA wallet balance in kopecks: balance, debt, and the current month\'s advance (v2, deprecated). Read-only, spends no money. The request body is empty (`{}`). Deprecated — prefer cpa_balance_info_v3 (the current version). Limit: 1 request/min.',
    method: 'POST',
    path: '/cpa/v2/balanceInfo',
    domain: 'cpa',
    staticHeaders,
    input: {},
    body: { contentType: 'application/json', defaults: {} },
  });

  defineTool(server, ctx, {
    name: 'cpa_get_call_by_id_v2',
    title: 'CPA: call by callId',
    risk: 'read',
    description:
      'Returns the full CPA call model by callId, including a link to the recording (v2). Read-only, spends no money. Use when the callId is already known (from cpa_get_calls_by_time_v2). The current replacement for the deprecated cpa_get_call (v1).',
    method: 'POST',
    path: '/cpa/v2/callById',
    domain: 'cpa',
    staticHeaders,
    input: {
      callId: z.number().int().positive().describe('CPA call identifier (callId, int64), obtained from cpa_get_calls_by_time_v2.'),
    },
    body: { contentType: 'application/json', fields: ['callId'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_get_calls_by_time_v2',
    title: 'CPA: calls for a period',
    risk: 'read',
    description:
      'Returns a paginated list of CPA calls created starting from the given moment (by startTime) (v2). Read-only, spends no money. Use to iterate over calls for a period; the returned callId/actionId values are then suitable for cpa_get_call_by_id_v2 or filing a complaint. Limit: 1 request/min.',
    method: 'POST',
    path: '/cpa/v2/callsByTime',
    domain: 'cpa',
    staticHeaders,
    input: {
      dateTimeFrom: z.string().describe('Moment from which to search calls by startTime, in RFC3339 format, e.g. "2021-01-02T15:04:05Z".'),
      limit: z.number().int().min(1).max(1000).describe('Page size (number of calls).'),
      offset: z.number().int().min(0).optional().describe('Page offset (default 0). For performance, prefer passing the maximum startTime of a call from the previous page.'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_chats_by_time_v2',
    title: 'CPA: chats for a period',
    risk: 'read',
    description:
      'Returns a paginated list of target CPA chats created starting from the given moment (by the date field) (v2 — current). Read-only, spends no money. Prefer this method over the deprecated cpa_chats_by_time_v1. The returned actionId values are then suitable for cpa_chat_by_action_id or filing a complaint. Limit: 40 requests/min.',
    method: 'POST',
    path: '/cpa/v2/chatsByTime',
    domain: 'cpa',
    staticHeaders,
    input: {
      dateTimeFrom: z.string().describe('Moment from which to search chats by the date field, in RFC3339 format, e.g. "2021-01-02T15:04:05Z".'),
      limit: z.number().int().min(1).max(100).describe('Page size (number of chats), no more than 100.'),
      offset: z.number().int().min(0).describe('Page offset (default 0). For performance, prefer passing the maximum date of a chat from the previous page.'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_balance_info_v3',
    title: 'CPA: balance',
    risk: 'read',
    description:
      'Returns the current balance of the user\'s CPA wallet in kopecks (v3 — current). Read-only, spends no money. The request body is empty (`{}`). v3 differs from v2 in having an updated response structure — prefer v3. Limit: 1 request/min.',
    method: 'POST',
    path: '/cpa/v3/balanceInfo',
    domain: 'cpa',
    staticHeaders,
    input: {},
    body: { contentType: 'application/json', defaults: {} },
  });
};
