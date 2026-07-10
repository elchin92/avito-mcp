/**
 * Domain `autoload` — corresponds to swaggers/autoload.json
 *
 * 17 endpoints: autoload profiles (v1 deprecated + v2), launching uploads, reports,
 * ID mappings, category field documentation.
 *
 * Quirks:
 *   - In the swagger, top-level security is not specified and operation-level is empty — in practice
 *     all methods require a Bearer token (auth: true by default in the factory).
 *   - createOrUpdateProfile (v1 + v2) accept complex nested objects (schedule, feeds_data) —
 *     we use z.record(z.unknown()) with a description.
 *   - POST /autoload/v1/upload — no parameters and no body, uses the URL from the profile settings.
 *     Limit: one upload per hour.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

const ExportSchedule = z.array(
  z.object({
    rate: z.number().int().describe('Number of listings to upload during this period.'),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .describe('Weekdays from 0 (Monday) through 6 (Sunday).'),
    time_slots: z
      .array(z.number().int().min(0).max(23))
      .describe('Hourly Moscow-time slots from 0 through 23.'),
  }),
);

const FeedData = z.object({
  feed_name: z.string(),
  feed_url: z.string().url(),
});

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── PROFILE (v1 deprecated) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_profile',
    title: 'Autoload: get profile (v1, deprecated)',
    risk: 'read',
    description:
      'Returns the autoload profile settings (v1): autoload_enabled, report_email, the schedule, and the deprecated upload_url field. ' +
      'Read-only, no parameters. DEPRECATED: since 2024-12-23 the upload_url field has been replaced by feeds_data — use autoload_get_profile_v2, ' +
      'which returns an array of feeds. Prefer v2.',
    method: 'GET',
    path: '/autoload/v1/profile',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_create_or_update_profile',
    title: 'Autoload: save profile (v1, deprecated)',
    risk: 'write',
    destructiveHint: true,
    description:
      'Creates or updates (upsert) a v1 autoload profile with a single URL feed. Overwrites the existing profile settings on the Avito side; ' +
      'if no profile exists, it creates one. DEPRECATED: since 2024-12-23 the single upload_url has been replaced by the feeds_data array — ' +
      'use autoload_create_or_update_profile_v2 (supports multiple feeds). Prefer v2.',
    method: 'POST',
    path: '/autoload/v1/profile',
    domain: 'autoload',
    input: {
      autoload_enabled: z.boolean().describe('Autoload status: true — enabled, false — disabled. Required.'),
      report_email: z.string().email().describe('Email address to which Avito will send upload reports. Required.'),
      upload_url: z.string().url().describe('URL of the XML/YML feed of listings for regular uploads. Must start with http or https. Required.'),
      schedule: ExportSchedule
        .describe(
          'Schedule of regular uploads (array of periods): each element = {rate: number of listings per period, weekdays: [0-6, where 0=Monday], time_slots: [0-23, where 0 = the 00:00-01:00 interval]}. Moscow time. Required. See the ExportSchedule schema in swagger autoload.json.',
        ),
      agreement: z
        .boolean()
        .optional()
        .describe('Acceptance of the Avito Autoload terms of use. Required only when first creating a profile; can be omitted on update.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['autoload_enabled', 'report_email', 'upload_url', 'schedule', 'agreement'],
    },
  });

  // ────────────────────────────── UPLOAD ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_upload',
    title: '⚠️ Autoload: launch upload',
    risk: 'public',
    destructiveHint: true,
    description:
      '⚠️ Immediately LAUNCHES an unscheduled upload of listings from the feed at the URL specified in the profile settings (autoload_create_or_update_profile_v2). ' +
      'Side effect: publishes/updates/activates listings on Avito; the publication limits from the settings do NOT apply to this upload — all listings from the file will be processed. ' +
      'Limit: one upload per hour. Takes no business inputs — only the optional dryRun (preview without calling Avito) and idempotencyKey (duplicate protection). ' +
      'Returns only a launch confirmation; poll the result later via autoload_get_last_completed_report_v3.',
    method: 'POST',
    path: '/autoload/v1/upload',
    domain: 'autoload',
    input: {},
  });

  // ────────────────────────────── USER DOCS (category reference) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_user_docs_tree',
    title: 'Autoload: category tree',
    risk: 'read',
    description:
      'Returns the full Avito category tree (an array of nodes with name, slug/id and nested children) for preparing an autoload feed. ' +
      'Read-only, no parameters. Use it to find the slug of the category you need, then pass it to autoload_user_docs_node_fields to get the fields. ' +
      'The reference is cacheable and changes rarely.',
    method: 'GET',
    path: '/autoload/v1/user-docs/tree',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_user_docs_node_fields',
    title: 'Autoload: category fields',
    risk: 'read',
    description:
      'Returns the fields (tags) of a specific category for filling out the feed: their types (input/select/checkbox), whether they are required, dependencies between fields, allowed values, and references to catalogs. ' +
      'Read-only. First find the category slug via autoload_user_docs_tree, then call this method. ' +
      'Use it when preparing the XML/Excel file to know which tags are required for a category.',
    method: 'GET',
    path: '/autoload/v1/user-docs/node/{node_slug}/fields',
    domain: 'autoload',
    input: {
      node_slug: z
        .string()
        .describe('Slug (unique identifier) of the category from the autoload_user_docs_tree tree, e.g. "remont". Required.'),
    },
    pathParams: ['node_slug'],
  });

  // ────────────────────────────── ID MAPPING ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_ad_ids_by_avito_ids',
    title: 'Autoload: Ad ID by Avito ID',
    risk: 'read',
    description:
      'Returns the listing identifiers from the autoload file (ad_id) by their Avito identifiers (avito_id) — an avito_id → ad_id mapping. ' +
      'Read-only. Use it when you have Avito IDs and need to find the corresponding ID from the source feed. The reverse direction is autoload_get_avito_ids_by_ad_ids.',
    method: 'GET',
    path: '/autoload/v2/items/ad_ids',
    domain: 'autoload',
    input: {
      query: z
        .string()
        .describe('List of listing Avito IDs separated by "," or "|" (e.g. "12345,6789"). Required.'),
    },
    queryParams: ['query'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_avito_ids_by_ad_ids',
    title: 'Autoload: Avito ID by Ad ID',
    risk: 'read',
    description:
      'Returns the Avito listing identifiers (avito_id) by their identifiers from the autoload file (ad_id) — an ad_id → avito_id mapping. ' +
      'Read-only. Use it when you have an ID from the feed and need to find the published listing on Avito. The reverse direction is autoload_get_ad_ids_by_avito_ids.',
    method: 'GET',
    path: '/autoload/v2/items/avito_ids',
    domain: 'autoload',
    input: {
      query: z
        .string()
        .describe('List of listing IDs from the file (the feed Id parameter), separated by "," or "|". Required.'),
    },
    queryParams: ['query'],
  });

  // ────────────────────────────── PROFILE V2 ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_profile_v2',
    title: 'Autoload: profile',
    risk: 'read',
    description:
      'Returns the autoload profile settings (v2, current version): autoload_enabled, report_email, the schedule, and the feeds_data array of feeds (name + file link). ' +
      'Read-only, no parameters. Prefer this method over autoload_get_profile (v1): v2 returns feeds_data instead of the deprecated single upload_url.',
    method: 'GET',
    path: '/autoload/v2/profile',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_create_or_update_profile_v2',
    title: 'Autoload: save profile',
    risk: 'write',
    destructiveHint: true,
    description:
      'Creates or updates (upsert) an autoload profile (v2, current version). Overwrites the existing profile settings on the Avito side; if no profile exists, it creates one. ' +
      'Supports multiple feeds via feeds_data (unlike v1 with a single upload_url) — prefer this method. ' +
      'The uploads themselves run on the schedule, or manually via autoload_upload.',
    method: 'POST',
    path: '/autoload/v2/profile',
    domain: 'autoload',
    input: {
      autoload_enabled: z.boolean().describe('Autoload status: true — enabled, false — disabled. Required.'),
      report_email: z.string().email().describe('Email address to which Avito will send upload reports. Required.'),
      feeds_data: z
        .array(FeedData)
        .describe(
          'Array of feeds (at least one). Each element = {feed_name: feed name for the report, feed_url: URL of the file with listings, starts with http/https}. Required. See the FeedsData schema in swagger autoload.json.',
        ),
      schedule: ExportSchedule
        .describe(
          'Schedule of regular uploads (array of periods): each element = {rate: number of listings per period, weekdays: [0-6, where 0=Monday], time_slots: [0-23, where 0 = the 00:00-01:00 interval]}. Moscow time. Required. See the ExportSchedule schema in swagger autoload.json.',
        ),
      agreement: z
        .boolean()
        .optional()
        .describe('Acceptance of the Avito Autoload terms of use. Required only when first creating a profile; can be omitted on update.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['autoload_enabled', 'report_email', 'feeds_data', 'schedule', 'agreement'],
    },
  });

  // ────────────────────────────── REPORTS V2 ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_reports_v2',
    title: 'Autoload: report list',
    risk: 'read',
    description:
      'Returns a list of autoload reports (id, started_at, finished_at, status) with pagination and a filter by creation date. ' +
      'Sorted in descending order: the most recent report first. Read-only; the response contains a meta block with total/pages. ' +
      'Use it to find a report_id, then fetch details via autoload_get_report_by_id_v3 / autoload_get_report_items_by_id.',
    method: 'GET',
    path: '/autoload/v2/reports',
    domain: 'autoload',
    input: {
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Number of reports per page. Defaults to 50; the API allows up to 200, but it is capped at 100 here.'),
      page: z.number().int().min(1).optional().describe('Page number (integer ≥ 1). Defaults to the first page.'),
      date_from: z
        .string()
        .optional()
        .describe('Filter by report creation date "from" (inclusive), RFC3339 format, e.g. "2022-05-27T14:48:50.52Z".'),
      date_to: z
        .string()
        .optional()
        .describe('Filter by report creation date "to" (inclusive), RFC3339 format, e.g. "2022-05-27T14:48:50.52Z".'),
    },
    queryParams: ['per_page', 'page', 'date_from', 'date_to'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_autoload_items_info_v2',
    title: 'Autoload: listing info',
    risk: 'read',
    description:
      'Returns the current state of listings in autoload by their IDs from the file: avito_id, avito_status, report section, errors/warnings (messages), charge information, and processing date. ' +
      'Read-only, not tied to a specific report — returns the current status. Use it for targeted checks of selected listings (1-100 per request).',
    method: 'GET',
    path: '/autoload/v2/reports/items',
    domain: 'autoload',
    input: {
      query: z
        .string()
        .describe('Listing identifiers from the file (the feed Id parameter): from 1 to 100, separated by "," or "|". Required.'),
    },
    queryParams: ['query'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_last_completed_report',
    title: 'Autoload: last report (v1, deprecated)',
    risk: 'read',
    description:
      'Returns summary statistics of the last completed upload (v2 format): per-section counters (section_stats), charges (listing_fees), events, and the feed_url link. ' +
      'Read-only, no parameters. DEPRECATED: since 2024-12-23 the single feed_url has been replaced by feeds_urls — use autoload_get_last_completed_report_v3. Prefer v3.',
    method: 'GET',
    path: '/autoload/v2/reports/last_completed_report',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_by_id_v2',
    title: 'Autoload: report by ID (v2, deprecated)',
    risk: 'read',
    description:
      'Returns summary statistics of a specific upload by its report_id (v2 format): section_stats, listing_fees, events, status, and the feed_url link. ' +
      'Read-only. Get the report_id from autoload_get_reports_v2. DEPRECATED: since 2024-12-23 feed_url has been replaced by feeds_urls — use autoload_get_report_by_id_v3. Prefer v3.',
    method: 'GET',
    path: '/autoload/v2/reports/{report_id}',
    domain: 'autoload',
    input: {
      report_id: z
        .number()
        .int()
        .positive()
        .describe('Autoload report identifier (ID); obtain it via autoload_get_reports_v2. Required.'),
    },
    pathParams: ['report_id'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_items_by_id',
    title: 'Autoload: upload listings',
    risk: 'read',
    description:
      'Returns the processing result of each listing in a specific upload (by report_id): ad_id, avito_id, avito_status, report section, errors/warnings, and a link. ' +
      'Read-only, with pagination (the response contains meta with total/pages). Use it for a line-by-line breakdown of an upload; for an upload summary see autoload_get_report_by_id_v3. ' +
      'Get the list of available sections for the sections filter from the report\'s section_stats.',
    method: 'GET',
    path: '/autoload/v2/reports/{report_id}/items',
    domain: 'autoload',
    input: {
      report_id: z
        .number()
        .int()
        .positive()
        .describe('Autoload report identifier (ID); obtain it via autoload_get_reports_v2. Required.'),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Number of listings per page. Defaults to 50; the API allows up to 200, but it is capped at 100 here.'),
      page: z.number().int().min(1).optional().describe('Page number (integer ≥ 1). Defaults to the first page.'),
      query: z
        .string()
        .optional()
        .describe('Filter by listing ID: one or more IDs from the file or Avito IDs, separated by "," or "|".'),
      sections: z
        .string()
        .optional()
        .describe('Filter by report sections: section slug identifiers separated by "," or "|" (get the slugs from the report\'s section_stats, e.g. via autoload_get_report_by_id_v3).'),
    },
    pathParams: ['report_id'],
    queryParams: ['per_page', 'page', 'query', 'sections'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_items_fees_by_id',
    title: 'Autoload: upload charges',
    risk: 'read',
    description:
      'Returns the placement charges for each listing in a specific upload (by report_id): ad_id, avito_id, charge type (single — from the wallet / package — from a package), and the amount or package ID. ' +
      'Read-only, with pagination (meta with total/pages). Use it to break down the cost of an upload; for listing processing/statuses use autoload_get_report_items_by_id.',
    method: 'GET',
    path: '/autoload/v2/reports/{report_id}/items/fees',
    domain: 'autoload',
    input: {
      report_id: z
        .number()
        .int()
        .positive()
        .describe('Autoload report identifier (ID); obtain it via autoload_get_reports_v2. Required.'),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Number of charges per page. Defaults to 100 (the API allows up to 200).'),
      page: z.number().int().min(1).optional().describe('Page number (integer ≥ 1). Defaults to the first page.'),
      ad_ids: z
        .string()
        .optional()
        .describe('Filter by listing IDs from the file (the feed Id parameter), separated by "," or "|".'),
      avito_ids: z
        .string()
        .optional()
        .describe('Filter by listing Avito IDs, separated by "," or "|".'),
    },
    pathParams: ['report_id'],
    queryParams: ['per_page', 'page', 'ad_ids', 'avito_ids'],
  });

  // ────────────────────────────── REPORTS V3 (current) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_last_completed_report_v3',
    title: 'Autoload: last report',
    risk: 'read',
    description:
      'Returns summary statistics of the last completed upload (v3, current format): per-section counters (section_stats), charges (listing_fees), events, and the feeds_urls array of links. ' +
      'Read-only, no parameters. Use it after an upload has been processed (status success/success_warning/error); for a specific report use autoload_get_report_by_id_v3. ' +
      'v3 differs from v2 by supporting multiple feeds (feeds_urls instead of a single feed_url) — prefer v3.',
    method: 'GET',
    path: '/autoload/v3/reports/last_completed_report',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_by_id_v3',
    title: 'Autoload: report by ID',
    risk: 'read',
    description:
      'Returns summary statistics of a specific upload by its report_id (v3, current format): section_stats, listing_fees, events, status, and the feeds_urls array of links. ' +
      'Read-only. Get the report_id from autoload_get_reports_v2; for a line-by-line breakdown of listings use autoload_get_report_items_by_id. ' +
      'v3 differs from v2 by supporting multiple feeds (feeds_urls instead of a single feed_url) — prefer v3.',
    method: 'GET',
    path: '/autoload/v3/reports/{report_id}',
    domain: 'autoload',
    input: {
      report_id: z
        .number()
        .int()
        .positive()
        .describe('Autoload report identifier (ID); obtain it via autoload_get_reports_v2. Required.'),
    },
    pathParams: ['report_id'],
  });
};
