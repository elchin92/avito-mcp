/**
 * Domain `calltracking` — swaggers/calltracking.json (3 endpoints).
 * Call tracking: retrieving information about calls and audio recordings.
 *
 * Quirks:
 *   - getRecordByCallId returns BINARY audio (mp3/wav). Since v0.5.0, client.ts
 *     detects non-JSON/non-text content and wraps it in { mimeType, sizeBytes, base64 }.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'calltracking_get_call_by_id',
    title: 'Call tracking: call by ID',
    risk: 'read',
    description:
      'Returns metadata for a single call-tracking call by its callId (read-only): call time, talk and wait durations, buyer/seller phone numbers, the protective (virtual) number, and the listing itemId. ' +
      'Use this when you know a specific callId; to query calls over a time range use calltracking_get_calls, and for the conversation audio recording use calltracking_get_record_by_call_id.',
    method: 'POST',
    path: '/calltracking/v1/getCallById/',
    domain: 'calltracking',
    input: {
      callId: z
        .number()
        .int()
        .min(1)
        .describe('Call identifier (callId) obtained from calltracking_get_calls.'),
    },
    body: { contentType: 'application/json', fields: ['callId'] },
  });

  defineTool(server, ctx, {
    name: 'calltracking_get_calls',
    title: 'Call tracking: list of calls',
    risk: 'read',
    description:
      'Returns a list of call-tracking calls over a time range, filtered by call time (callTime), with pagination (read-only). Requires a time window in RFC3339 format. ' +
      'To fetch a single call by id use calltracking_get_call_by_id; for the conversation recording use calltracking_get_record_by_call_id.',
    method: 'POST',
    path: '/calltracking/v1/getCalls/',
    domain: 'calltracking',
    input: {
      dateTimeFrom: z
        .string()
        .describe(
          'Start of the search range by call time (callTime), an RFC3339-formatted string, e.g. "2021-01-02T00:00:00Z". Required.',
        ),
      dateTimeTo: z
        .string()
        .optional()
        .describe(
          'End of the search range by callTime (RFC3339, e.g. "2021-03-02T23:59:59Z"). If omitted, defaults to dateTimeFrom + 1 month; the maximum is dateTimeFrom + 3 months.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe('Page size — how many calls to return per request (the API allows at most 100).'),
      offset: z
        .number()
        .int()
        .min(0)
        .describe('Pagination offset (the number of records to skip from the start, starting at 0).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['dateTimeFrom', 'dateTimeTo', 'limit', 'offset'],
    },
  });

  defineTool(server, ctx, {
    name: 'calltracking_get_record_by_call_id',
    title: 'Call tracking: call audio recording',
    risk: 'read',
    description:
      'Downloads the call-tracking conversation audio recording for a specific callId (read-only). Returns a structured binary response {mimeType: "audio/mpeg" (or wav), sizeBytes, base64}; decode the base64 to save the file (it may be several MB). ' +
      'The recording becomes available with a delay of up to 30 minutes after the call and is retained for 3 months; if the recording is not ready yet, the API returns an error (HTTP 425, code 1005). For call metadata use calltracking_get_call_by_id, and for a list over a time range use calltracking_get_calls.',
    method: 'GET',
    path: '/calltracking/v1/getRecordByCallId/',
    domain: 'calltracking',
    input: {
      callId: z
        .number()
        .int()
        .positive()
        .describe('Call identifier (callId) for which the conversation audio recording is requested.'),
    },
    queryParams: ['callId'],
  });
};
