/**
 * Домен `items` — соответствует swaggers/Объявления.json
 *
 * 11 endpoints. Основной ценный домен для AI-агента: чтение объявлений, цена, VAS, статистика.
 *
 * Quirks:
 *   - Часть путей использует {userId} (camelCase), часть — {user_id}.
 *     ToolSpec.injectProfileId поддерживает оба варианта; в input всегда `user_id`/`userId` явно.
 *   - GET /core/v1/items в swagger без описанных query — на практике принимает per_page/page/category/status.
 *     Добавляем их как опциональные, описываем в description.
 *   - PUT /core/v2/items/{itemId}/vas/ — единственный путь с {itemId} (camelCase).
 *
 * ⚠️ Write-методы реально влияют на боевой аккаунт:
 *   - updatePrice — меняет цену объявления
 *   - putItemVas, putItemVasPackageV2, applyVas — покупают платные услуги (тратит деньги)
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── READ-ONLY ──────────────────────────────

  defineTool(server, ctx, {
    name: 'items_get_items_info',
    title: 'Список объявлений',
    risk: 'read',
    description:
      'Список объявлений авторизованного пользователя — статус, категория, ссылка на сайте. ' +
      'Лимит: 25 запросов в минуту. Не работает с объявлениями сотрудников ' +
      '(в этом случае вернёт пустой список). Поддерживает пагинацию через page+per_page.',
    method: 'GET',
    path: '/core/v1/items',
    domain: 'core',
    input: {
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Сколько объявлений вернуть (1–100). По умолчанию сервер сам решает.'),
      page: z.number().int().min(1).optional().describe('Номер страницы (начиная с 1).'),
      status: z
        .enum(['active', 'old', 'blocked', 'removed'])
        .optional()
        .describe('Фильтр по статусу объявления.'),
      category: z.number().int().optional().describe('ID категории Авито для фильтра.'),
      updatedAtFrom: z
        .string()
        .optional()
        .describe('Фильтр по дате обновления (ISO 8601, например "2026-05-01").'),
    },
    queryParams: ['per_page', 'page', 'status', 'category', 'updatedAtFrom'],
  });

  defineTool(server, ctx, {
    name: 'items_get_item_info',
    title: 'Информация об объявлении',
    risk: 'read',
    description:
      'Детальная информация по одному объявлению: заголовок, цена, статус, адрес, фото и др.',
    method: 'GET',
    path: '/core/v1/accounts/{user_id}/items/{item_id}/',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID объявления на Avito.'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Номер пользователя. По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'item_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'items_post_calls_stats',
    risk: 'read',
    description:
      'Статистика звонков по объявлениям за период (всего/новые/отвеченные/новые отвеченные, ' +
      'в разрезе дней). Период dateFrom..dateTo в формате YYYY-MM-DD. ' +
      'Без itemIds — статистика по всем объявлениям пользователя.',
    method: 'POST',
    path: '/core/v1/accounts/{user_id}/calls/stats/',
    domain: 'core',
    input: {
      dateFrom: z.string().describe('Начало периода (YYYY-MM-DD).'),
      dateTo: z.string().describe('Конец периода (YYYY-MM-DD).'),
      itemIds: z
        .array(z.number().int().positive())
        .optional()
        .describe('Фильтр по ID объявлений. Без него — все.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['dateFrom', 'dateTo', 'itemIds'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_post_vas_prices',
    risk: 'read',
    description:
      'Информация о стоимости услуг продвижения (VAS) и доступных значках для заданных объявлений. ' +
      'Принимает массив ID объявлений. Используйте перед покупкой VAS, чтобы узнать цену.',
    method: 'POST',
    path: '/core/v1/accounts/{userId}/vas/prices',
    domain: 'core',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Список ID объявлений, для которых нужны цены VAS.'),
      userId: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['userId'],
    injectProfileId: 'userId',
    body: {
      contentType: 'application/json',
      fields: ['itemIds'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_post_item_stats_shallow',
    risk: 'read',
    description:
      'Поверхностная статистика по объявлениям за период (просмотры, контакты). ' +
      'dateFrom/dateTo — YYYY-MM-DD. periodGrouping: day|week|month. ' +
      'fields — массив метрик (например ["uniqViews","uniqContacts","calls"]).',
    method: 'POST',
    path: '/stats/v1/accounts/{user_id}/items',
    domain: 'stats',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(200)
        .describe('ID объявлений (макс 200 за запрос).'),
      dateFrom: z.string().describe('Начало периода (YYYY-MM-DD), не далее 270 дней назад.'),
      dateTo: z.string().describe('Конец периода (YYYY-MM-DD).'),
      periodGrouping: z.enum(['day', 'week', 'month']).optional().describe('Группировка периодов.'),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          'Какие метрики вернуть, например ["uniqViews","uniqContacts","uniqFavorites","calls"].',
        ),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['itemIds', 'dateFrom', 'dateTo', 'periodGrouping', 'fields'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_post_item_analytics',
    risk: 'read',
    description:
      'Расширенная аналитика по объявлениям (views, contacts, presenceSpending и др.) с группировкой и сортировкой. ' +
      'Поддерживает фильтры по категориям и сотрудникам. limit ≤ 1000.',
    method: 'POST',
    path: '/stats/v2/accounts/{user_id}/items',
    domain: 'stats',
    input: {
      dateFrom: z.string().describe('Начало периода (YYYY-MM-DD).'),
      dateTo: z.string().describe('Конец периода (YYYY-MM-DD).'),
      metrics: z
        .array(z.string())
        .min(1)
        .describe('Список метрик: views, contacts, presenceSpending, и др.'),
      grouping: z
        .object({
          period: z.enum(['day', 'week', 'month']).optional(),
          itemId: z.boolean().optional(),
        })
        .passthrough()
        .describe('Группировка: по периоду/объявлению/категории.'),
      limit: z.number().int().min(0).max(1000).describe('Сколько строк вернуть (0..1000).'),
      offset: z.number().int().min(0).describe('Смещение пагинации.'),
      filter: z
        .object({
          categoryIDs: z.array(z.number().int()).optional(),
          employeeIDs: z.array(z.number().int()).optional(),
        })
        .passthrough()
        .optional()
        .describe('Фильтры по категориям/сотрудникам.'),
      sort: z
        .object({
          key: z.string(),
          order: z.enum(['asc', 'desc']),
        })
        .optional()
        .describe('Сортировка по метрике.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['dateFrom', 'dateTo', 'metrics', 'grouping', 'limit', 'offset', 'filter', 'sort'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_post_account_spendings',
    risk: 'read',
    description:
      'Статистика расходов профиля (по типам услуг — vas/cpa/tariff и т.п.) за период. ' +
      'Поддерживает группировку и фильтры по категориям/сотрудникам.',
    method: 'POST',
    path: '/stats/v2/accounts/{user_id}/spendings',
    domain: 'stats',
    input: {
      dateFrom: z.string().describe('Начало периода (YYYY-MM-DD).'),
      dateTo: z.string().describe('Конец периода (YYYY-MM-DD).'),
      spendingTypes: z
        .array(z.string())
        .min(1)
        .describe('Типы расходов: vas, perf_vas, lf, cv, tariff, subscription, cpa, bundle.'),
      grouping: z
        .object({
          period: z.enum(['day', 'week', 'month']).optional(),
        })
        .passthrough()
        .describe('Группировка расходов.'),
      filter: z
        .object({
          categoryIDs: z.array(z.number().int()).optional(),
          employeeIDs: z.array(z.number().int()).optional(),
        })
        .passthrough()
        .optional()
        .describe('Фильтры по категориям/сотрудникам.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['dateFrom', 'dateTo', 'spendingTypes', 'grouping', 'filter'],
    },
  });

  // ────────────────────────────── WRITE (тратят деньги/меняют данные!) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'items_update_price',
    title: '⚠️ Изменить цену',
    risk: 'public',
    description:
      '⚠️ ИЗМЕНЯЕТ ЦЕНУ объявления (целое число в рублях). ' +
      'Подтверждайте у пользователя перед вызовом на боевом аккаунте.',
    method: 'POST',
    path: '/core/v1/items/{item_id}/update_price',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID объявления.'),
      price: z.number().int().min(0).describe('Новая цена в рублях (целое число).'),
    },
    pathParams: ['item_id'],
    body: {
      contentType: 'application/json',
      fields: ['price'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_put_item_vas',
    risk: 'money',
    description:
      '⚠️ ПЛАТНОЕ. Применяет одну дополнительную услугу (VAS) к объявлению — тратит деньги с баланса. ' +
      'vas_id — slug услуги (highlight, xl, premium, vip, ...). Сначала вызовите items_post_vas_prices.',
    method: 'PUT',
    path: '/core/v1/accounts/{user_id}/items/{item_id}/vas',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID объявления.'),
      vas_id: z.string().describe('Slug услуги VAS (например "highlight").'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'item_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['vas_id'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_put_item_vas_package_v2',
    risk: 'money',
    description:
      '⚠️ ПЛАТНОЕ. Применяет пакет услуг VAS к объявлению — тратит деньги. ' +
      'package_id — идентификатор пакета.',
    method: 'PUT',
    path: '/core/v2/accounts/{user_id}/items/{item_id}/vas_packages',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID объявления.'),
      package_id: z.string().describe('Идентификатор пакета услуг.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'item_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['package_id'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_apply_vas',
    risk: 'money',
    description:
      '⚠️ ПЛАТНОЕ. Применяет несколько услуг продвижения (slugs) и/или стикеры (stickers) ' +
      'к одному объявлению — тратит деньги.',
    method: 'PUT',
    path: '/core/v2/items/{itemId}/vas/',
    domain: 'core',
    input: {
      itemId: z.number().int().positive().describe('ID объявления.'),
      slugs: z
        .array(z.string())
        .min(1)
        .describe('Slug-и услуг VAS (например ["highlight","xl"]).'),
      stickers: z.array(z.string()).optional().describe('Slug-и стикеров.'),
    },
    pathParams: ['itemId'],
    body: {
      contentType: 'application/json',
      fields: ['slugs', 'stickers'],
    },
  });
};
