/**
 * Домен `autoload` — соответствует swaggers/Автозагрузка.json
 *
 * 17 endpoints: профили автозагрузки (v1 deprecated + v2), запуск выгрузок, отчёты,
 * соответствия ID, документация полей категорий.
 *
 * Quirks:
 *   - В swagger top-level security не указан и operation-level пустой — на практике
 *     все методы требуют Bearer-токен (auth: true по умолчанию в factory).
 *   - createOrUpdateProfile (v1 + v2) принимают сложные nested объекты (schedule, feeds_data) —
 *     используем z.record(z.unknown()) с описанием.
 *   - POST /autoload/v1/upload — без параметров и body, использует URL из настроек профиля.
 *     Лимит: одна выгрузка в час.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── PROFILE (v1 deprecated) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_profile',
    risk: 'read',
    description: '(deprecated, используйте autoload_get_profile_v2) Профиль автозагрузки v1.',
    method: 'GET',
    path: '/autoload/v1/profile',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_create_or_update_profile',
    risk: 'write',
    description:
      '(deprecated, используйте autoload_create_or_update_profile_v2) ' +
      'Создание/редактирование настроек профиля автозагрузки v1.',
    method: 'POST',
    path: '/autoload/v1/profile',
    domain: 'autoload',
    input: {
      autoload_enabled: z.boolean().describe('Включена ли автозагрузка.'),
      report_email: z.string().email().describe('Email для отчётов автозагрузки.'),
      upload_url: z.string().url().describe('URL XML-файла с объявлениями.'),
      schedule: z.record(z.string(), z.unknown()).describe('Расписание выгрузок. См. swagger Автозагрузка.json'),
      agreement: z.boolean().optional().describe('Принятие условий использования.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['autoload_enabled', 'report_email', 'upload_url', 'schedule', 'agreement'],
    },
  });

  // ────────────────────────────── UPLOAD ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_upload',
    risk: 'write',
    description:
      '⚠️ ЗАПУСКАЕТ процесс автозагрузки объявлений из файла по URL, указанному в настройках профиля. ' +
      'Лимит: одна выгрузка в час. Не требует параметров.',
    method: 'POST',
    path: '/autoload/v1/upload',
    domain: 'autoload',
    input: {},
  });

  // ────────────────────────────── USER DOCS (справочник категорий) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_user_docs_tree',
    risk: 'read',
    description: 'Полное дерево категорий товаров Avito для автозагрузки.',
    method: 'GET',
    path: '/autoload/v1/user-docs/tree',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_user_docs_node_fields',
    risk: 'read',
    description:
      'Список полей (атрибутов) для конкретной категории. ' +
      'node_slug — slug категории из autoload_user_docs_tree.',
    method: 'GET',
    path: '/autoload/v1/user-docs/node/{node_slug}/fields',
    domain: 'autoload',
    input: {
      node_slug: z.string().describe('Slug категории (получить через autoload_user_docs_tree).'),
    },
    pathParams: ['node_slug'],
  });

  // ────────────────────────────── ID MAPPING ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_ad_ids_by_avito_ids',
    risk: 'read',
    description:
      'Получить Ad ID (из файла) по Avito ID. query — CSV-список Avito ID.',
    method: 'GET',
    path: '/autoload/v2/items/ad_ids',
    domain: 'autoload',
    input: {
      query: z.string().describe('CSV-список Avito ID объявлений (например "1,2,3").'),
    },
    queryParams: ['query'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_avito_ids_by_ad_ids',
    risk: 'read',
    description: 'Получить Avito ID по Ad ID (из файла). query — CSV-список Ad ID.',
    method: 'GET',
    path: '/autoload/v2/items/avito_ids',
    domain: 'autoload',
    input: {
      query: z.string().describe('CSV-список Ad ID из файла автозагрузки.'),
    },
    queryParams: ['query'],
  });

  // ────────────────────────────── PROFILE V2 ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_profile_v2',
    risk: 'read',
    description: 'Профиль автозагрузки v2 (актуальная версия).',
    method: 'GET',
    path: '/autoload/v2/profile',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_create_or_update_profile_v2',
    risk: 'write',
    description:
      'Создание/редактирование настроек профиля автозагрузки v2. ' +
      'feeds_data — массив фидов (XML/YML/CSV URL + категории). schedule — расписание.',
    method: 'POST',
    path: '/autoload/v2/profile',
    domain: 'autoload',
    input: {
      autoload_enabled: z.boolean().describe('Включена ли автозагрузка.'),
      report_email: z.string().email().describe('Email для отчётов автозагрузки.'),
      feeds_data: z
        .array(z.record(z.string(), z.unknown()))
        .describe('Массив фидов: {url, category_id, ...}. См. swagger Автозагрузка.json.'),
      schedule: z.record(z.string(), z.unknown()).describe('Расписание выгрузок.'),
      agreement: z.boolean().optional().describe('Принятие условий использования.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['autoload_enabled', 'report_email', 'feeds_data', 'schedule', 'agreement'],
    },
  });

  // ────────────────────────────── REPORTS V2 ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_reports_v2',
    risk: 'read',
    description: 'Список отчётов автозагрузки с пагинацией и фильтром по датам.',
    method: 'GET',
    path: '/autoload/v2/reports',
    domain: 'autoload',
    input: {
      per_page: z.number().int().min(1).max(100).optional().describe('Сколько отчётов на странице.'),
      page: z.number().int().min(1).optional().describe('Номер страницы.'),
      date_from: z.string().optional().describe('Начало периода (ISO 8601).'),
      date_to: z.string().optional().describe('Конец периода (ISO 8601).'),
    },
    queryParams: ['per_page', 'page', 'date_from', 'date_to'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_autoload_items_info_v2',
    risk: 'read',
    description: 'Информация об объявлениях в автозагрузке по ID. query — CSV-список ID.',
    method: 'GET',
    path: '/autoload/v2/reports/items',
    domain: 'autoload',
    input: {
      query: z.string().describe('CSV-список ID объявлений.'),
    },
    queryParams: ['query'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_last_completed_report',
    risk: 'read',
    description: '(deprecated, используйте v3) Статистика по последней завершённой выгрузке.',
    method: 'GET',
    path: '/autoload/v2/reports/last_completed_report',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_by_id_v2',
    risk: 'read',
    description: '(deprecated, используйте v3) Статистика по конкретной выгрузке.',
    method: 'GET',
    path: '/autoload/v2/reports/{report_id}',
    domain: 'autoload',
    input: {
      report_id: z.number().int().positive().describe('ID отчёта автозагрузки.'),
    },
    pathParams: ['report_id'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_items_by_id',
    risk: 'read',
    description: 'Все объявления из конкретной выгрузки (с пагинацией и фильтрами).',
    method: 'GET',
    path: '/autoload/v2/reports/{report_id}/items',
    domain: 'autoload',
    input: {
      report_id: z.number().int().positive().describe('ID отчёта автозагрузки.'),
      per_page: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(),
      query: z
        .string()
        .optional()
        .describe('Фильтр по тексту (название объявления / ID).'),
      sections: z
        .string()
        .optional()
        .describe('CSV-список разделов отчёта: errors, warnings, info, и т.д.'),
    },
    pathParams: ['report_id'],
    queryParams: ['per_page', 'page', 'query', 'sections'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_items_fees_by_id',
    risk: 'read',
    description: 'Списания за объявления в конкретной выгрузке.',
    method: 'GET',
    path: '/autoload/v2/reports/{report_id}/items/fees',
    domain: 'autoload',
    input: {
      report_id: z.number().int().positive().describe('ID отчёта автозагрузки.'),
      per_page: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(),
      ad_ids: z.string().optional().describe('CSV-список Ad ID из файла.'),
      avito_ids: z.string().optional().describe('CSV-список Avito ID.'),
    },
    pathParams: ['report_id'],
    queryParams: ['per_page', 'page', 'ad_ids', 'avito_ids'],
  });

  // ────────────────────────────── REPORTS V3 (актуальные) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_last_completed_report_v3',
    risk: 'read',
    description: 'Статистика по последней завершённой выгрузке (v3).',
    method: 'GET',
    path: '/autoload/v3/reports/last_completed_report',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_by_id_v3',
    risk: 'read',
    description: 'Статистика по конкретной выгрузке (v3).',
    method: 'GET',
    path: '/autoload/v3/reports/{report_id}',
    domain: 'autoload',
    input: {
      report_id: z.number().int().positive().describe('ID отчёта автозагрузки.'),
    },
    pathParams: ['report_id'],
  });
};
