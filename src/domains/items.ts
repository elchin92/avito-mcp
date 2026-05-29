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
      'Возвращает СПИСОК объявлений авторизованного пользователя (get_items_info) — id, статус, категория, ссылка на сайте. ' +
      'Read-only, ничего не меняет. Используйте для поиска id объявлений и обзора; для деталей по одному объявлению — items_get_item_info. ' +
      'Поддерживает пагинацию (page + per_page) и фильтры (status, category, updatedAtFrom). ' +
      'Лимит 25 запросов/мин. Не работает с объявлениями сотрудников — для них (под главным аккаунтом или авторизованным сотрудником) вернётся пустой список.',
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
        .describe('Размер страницы: сколько объявлений вернуть за запрос (1–100). Если не задан, сервер выбирает значение по умолчанию.'),
      page: z.number().int().min(1).optional().describe('Номер страницы пагинации, начиная с 1.'),
      status: z
        .enum(['active', 'old', 'blocked', 'removed'])
        .optional()
        .describe('Фильтр по статусу объявления: active (опубликовано), old (в архиве), blocked (заблокировано), removed (удалено). Без фильтра — все статусы.'),
      category: z.number().int().optional().describe('Числовой ID категории Авито для фильтра по категории объявлений.'),
      updatedAtFrom: z
        .string()
        .optional()
        .describe('Фильтр: вернуть только объявления, обновлённые не раньше этой даты (ISO 8601, например "2026-05-01").'),
    },
    queryParams: ['per_page', 'page', 'status', 'category', 'updatedAtFrom'],
  });

  defineTool(server, ctx, {
    name: 'items_get_item_info',
    title: 'Информация об объявлении',
    risk: 'read',
    description:
      'Возвращает детальную информацию по ОДНОМУ объявлению (get_item_info) — статус, цена, адрес, список применённых услуг VAS и др. ' +
      'Read-only. Используйте, когда уже известен item_id; для списка объявлений — items_get_items_info, для статистики просмотров/контактов — items_post_item_stats_shallow (этот метод статистику не возвращает). ' +
      'Лимит 500 запросов/мин.',
    method: 'GET',
    path: '/core/v1/accounts/{user_id}/items/{item_id}/',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID объявления на Avito, по которому нужны детали.'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('ID пользователя-владельца объявления. По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'item_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'items_post_calls_stats',
    title: 'Статистика звонков',
    risk: 'read',
    description:
      'Возвращает агрегированную статистику ЗВОНКОВ по объявлениям за период (post_calls_stats) — всего/новые/отвеченные/новые отвеченные, в разрезе дней. ' +
      'Read-only аналитика, ничего не меняет и не тратит. Период задаётся датами dateFrom..dateTo (YYYY-MM-DD). ' +
      'Без itemIds — по всем объявлениям пользователя. Для просмотров/контактов используйте items_post_item_stats_shallow.',
    method: 'POST',
    path: '/core/v1/accounts/{user_id}/calls/stats/',
    domain: 'core',
    input: {
      dateFrom: z.string().describe('Начало периода включительно (YYYY-MM-DD).'),
      dateTo: z.string().describe('Конец периода включительно (YYYY-MM-DD).'),
      itemIds: z
        .array(z.number().int().positive())
        .optional()
        .describe('Список ID объявлений для фильтра. Без него — статистика по всем объявлениям пользователя.'),
      user_id: z.number().int().positive().optional().describe('ID пользователя-владельца. По умолчанию — Profile_id из .env.'),
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
    title: 'Цены услуг VAS',
    risk: 'read',
    description:
      'Возвращает стоимость услуг продвижения (VAS), доступные пакеты и значки для заданных объявлений (post_vas_prices). ' +
      'Read-only — НЕ покупает и НЕ тратит деньги, только справка по ценам. ' +
      'Обязательно вызывайте ПЕРЕД покупкой через items_apply_vas / items_put_item_vas, чтобы узнать актуальные slug-и услуг и их цену.',
    method: 'POST',
    path: '/core/v1/accounts/{userId}/vas/prices',
    domain: 'core',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Список ID объявлений, для которых нужны цены и доступные услуги/значки VAS (минимум 1).'),
      userId: z.number().int().positive().optional().describe('ID пользователя-владельца. По умолчанию — Profile_id из .env.'),
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
    title: 'Статистика объявлений',
    risk: 'read',
    description:
      'Возвращает счётчики (поверхностную статистику) по списку объявлений за период (post_item_stats_shallow / itemStatsShallow): уникальные просмотры, контакты, добавления в избранное. ' +
      'Read-only аналитика. Используйте для метрик по конкретным item_id с группировкой по дням/неделям/месяцам; для расширенной аналитики профиля с фильтрами и сортировкой — items_post_item_analytics, для звонков — items_post_calls_stats. ' +
      'Лимиты: не более 200 объявлений за запрос, глубина не более 270 дней назад.',
    method: 'POST',
    path: '/stats/v1/accounts/{user_id}/items',
    domain: 'stats',
    input: {
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(200)
        .describe('Список ID объявлений, по которым нужны счётчики (от 1 до 200 за запрос).'),
      dateFrom: z.string().describe('Начало периода включительно (YYYY-MM-DD); не далее 270 дней назад.'),
      dateTo: z.string().describe('Конец периода включительно (YYYY-MM-DD).'),
      periodGrouping: z.enum(['day', 'week', 'month']).optional().describe('Группировка счётчиков по периоду: day (дни), week (по первому дню недели), month (по первому дню месяца).'),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          'Какие метрики (счётчики) вернуть: uniqViews (уник. просмотры), uniqContacts (уник. контакты), uniqFavorites (уник. добавления в избранное), calls. Без указания возвращаются все доступные.',
        ),
      user_id: z.number().int().positive().optional().describe('ID пользователя-владельца. По умолчанию — Profile_id из .env.'),
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
    title: 'Аналитика объявлений',
    risk: 'read',
    description:
      'Возвращает РАСШИРЕННЫЕ статистические показатели по профилю/объявлениям за период (post_item_analytics, stats v2): views, contacts, presenceSpending и др. с гибкой группировкой, фильтрами и сортировкой. ' +
      'Read-only аналитика. Выбирайте вместо items_post_item_stats_shallow, когда нужны фильтры по категориям/сотрудникам, сортировка по метрике или показатели расхода присутствия. limit ≤ 1000.',
    method: 'POST',
    path: '/stats/v2/accounts/{user_id}/items',
    domain: 'stats',
    input: {
      dateFrom: z.string().describe('Начало периода включительно (YYYY-MM-DD).'),
      dateTo: z.string().describe('Конец периода включительно (YYYY-MM-DD).'),
      metrics: z
        .array(z.string())
        .min(1)
        .describe('Список запрашиваемых метрик (минимум 1): views, contacts, presenceSpending и др.'),
      grouping: z
        .object({
          period: z.enum(['day', 'week', 'month']).optional(),
          itemId: z.boolean().optional(),
        })
        .passthrough()
        .describe('Способ группировки показателей: period (day|week|month), itemId (по объявлению) и/или по категории. Пустой объект — общие итоги (totals).'),
      limit: z.number().int().min(0).max(1000).describe('Максимум строк в ответе (0..1000) для пагинации.'),
      offset: z.number().int().min(0).describe('Смещение от начала выборки для пагинации (>= 0).'),
      filter: z
        .object({
          categoryIDs: z.array(z.number().int()).optional(),
          employeeIDs: z.array(z.number().int()).optional(),
        })
        .passthrough()
        .optional()
        .describe('Фильтры выборки: categoryIDs — массив ID категорий, employeeIDs — массив ID сотрудников. Без фильтра — весь профиль.'),
      sort: z
        .object({
          key: z.string(),
          order: z.enum(['asc', 'desc']),
        })
        .optional()
        .describe('Сортировка результатов: key — имя метрики, order — asc (по возрастанию) или desc (по убыванию).'),
      user_id: z.number().int().positive().optional().describe('ID пользователя-владельца. По умолчанию — Profile_id из .env.'),
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
    title: 'Расходы профиля',
    risk: 'read',
    description:
      'Возвращает ОТЧЁТ о расходах профиля за период по типам услуг (post_account_spendings) — сколько потрачено на vas/cpa/tariff и т.п. ' +
      'Read-only, денег не тратит (только показывает уже понесённые траты). Период dateFrom..dateTo (YYYY-MM-DD). ' +
      'Внимание: grouping здесь — СТРОКА "day"|"week"|"month" (НЕ объект, в отличие от items_post_item_analytics). Глубина данных не более 270 дней, не более 1 запроса в минуту. Обязательны: dateFrom, dateTo, spendingTypes, grouping.',
    method: 'POST',
    path: '/stats/v2/accounts/{user_id}/spendings',
    domain: 'stats',
    input: {
      dateFrom: z.string().describe('Начало периода включительно (YYYY-MM-DD); не далее 270 дней назад.'),
      dateTo: z.string().describe('Конец периода включительно (YYYY-MM-DD).'),
      spendingTypes: z
        .array(z.string())
        .min(1)
        .describe('Типы расходов для отчёта (минимум 1): vas, perf_vas, lf, cv, tariff, subscription, cpa, bundle.'),
      grouping: z
        .enum(['day', 'week', 'month'])
        .describe('Группировка расходов по периоду — строка (обязательно): day (по дням), week (по неделям), month (по месяцам).'),
      filter: z
        .object({
          categoryIDs: z.array(z.number().int()).optional().describe('Фильтр по ID категорий.'),
          itemIDs: z.array(z.number().int()).optional().describe('Фильтр по ID объявлений.'),
          locationIDs: z.array(z.number().int()).optional().describe('Фильтр по ID локаций.'),
        })
        .passthrough()
        .optional()
        .describe('Необязательные фильтры выборки: categoryIDs — ID категорий, itemIDs — ID объявлений, locationIDs — ID локаций. employeeIDs здесь НЕ поддерживается. Без фильтра — расходы всего профиля.'),
      user_id: z.number().int().positive().optional().describe('ID пользователя-владельца. По умолчанию — Profile_id из .env.'),
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
      'Меняет цену объявления (update_price). ⚠️ PUBLIC: новая цена сразу видна покупателям на сайте. Требует item_id и price (целое, в рублях). ' +
      'Доступно только для категорий Товары, Запчасти, Авто и Недвижимость (кроме краткосрочной аренды); в других категориях вернёт ошибку. ' +
      'Денег не тратит, но это боевое изменение публичного объявления — подтверждайте у пользователя. Лимит 150 запросов/мин.',
    method: 'POST',
    path: '/core/v1/items/{item_id}/update_price',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID объявления, цену которого нужно изменить.'),
      price: z.number().int().min(0).describe('Новая цена в рублях, целое число (>= 0). Сразу станет видна покупателям.'),
    },
    pathParams: ['item_id'],
    body: {
      contentType: 'application/json',
      fields: ['price'],
    },
  });

  defineTool(server, ctx, {
    name: 'items_put_item_vas',
    title: '⚠️ Применить VAS',
    risk: 'money',
    description:
      'Применяет ОДНУ дополнительную услугу продвижения (VAS) к объявлению (put_item_vas). ⚠️ MONEY: списывает деньги с баланса; необратимо. В ответе — данные об услуге и сумма списания. ' +
      'УСТАРЕЛО (deprecated): для одной или нескольких услуг предпочтительнее items_apply_vas (v2); для пакета услуг — items_put_item_vas_package_v2. ' +
      'Сначала вызовите items_post_vas_prices для актуального slug и цены. Подтверждайте у пользователя. Внимание: ошибка не гарантирует, что услуга не куплена — проверяйте через несколько минут.',
    method: 'PUT',
    path: '/core/v1/accounts/{user_id}/items/{item_id}/vas',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID объявления, к которому применяется услуга.'),
      vas_id: z.string().describe('Slug одной услуги VAS, например "highlight", "xl", "premium", "vip" (узнать доступные — items_post_vas_prices).'),
      user_id: z.number().int().positive().optional().describe('ID пользователя-владельца. По умолчанию — Profile_id из .env.'),
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
    title: '⚠️ Применить пакет VAS',
    risk: 'money',
    description:
      'Применяет ПАКЕТ услуг продвижения (VAS) к объявлению (put_item_vas_package_v2). ⚠️ MONEY: списывает деньги с баланса; необратимо. В ответе — сумма списания. ' +
      'В отличие от items_put_item_vas (одна услуга по slug) и items_apply_vas (произвольный набор услуг/значков), этот метод покупает заранее собранный пакет по его package_id. ' +
      'УСТАРЕЛО (deprecated), рекомендуемая замена — items_apply_vas (v2). Сначала уточните цену через items_post_vas_prices, подтверждайте у пользователя. Ошибка не гарантирует, что пакет не куплен — проверяйте через несколько минут.',
    method: 'PUT',
    path: '/core/v2/accounts/{user_id}/items/{item_id}/vas_packages',
    domain: 'core',
    input: {
      item_id: z.number().int().positive().describe('ID объявления, к которому применяется пакет услуг.'),
      package_id: z.string().describe('Идентификатор пакета услуг VAS (доступные пакеты — в ответе items_post_vas_prices).'),
      user_id: z.number().int().positive().optional().describe('ID пользователя-владельца. По умолчанию — Profile_id из .env.'),
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
    title: '⚠️ Применить услуги VAS',
    risk: 'money',
    description:
      'Применяет ОДНУ ИЛИ НЕСКОЛЬКО услуг продвижения (slugs) и/или значки (stickers) к опубликованному объявлению (apply_vas, v2 — актуальный метод). ⚠️ MONEY: списывает деньги; необратимо. В ответе — id операций покупки для отслеживания статуса. ' +
      'Предпочтительная замена устаревших items_put_item_vas (одна услуга) и items_put_item_vas_package_v2 (пакет). В одном запросе каждая услуга применяется только один раз; значки доступны лишь с услугой «XL-объявление», не более трёх. ' +
      'Сначала уточните доступные slug/значки и цену через items_post_vas_prices, подтверждайте у пользователя.',
    method: 'PUT',
    path: '/core/v2/items/{itemId}/vas/',
    domain: 'core',
    input: {
      itemId: z.number().int().positive().describe('ID опубликованного объявления, к которому применяются услуги.'),
      slugs: z
        .array(z.string())
        .min(1)
        .describe('Slug-и применяемых услуг продвижения, например ["highlight","xl"] (минимум 1; доступные — из items_post_vas_prices).'),
      stickers: z.array(z.string()).optional().describe('Slug-и значков, например «Без ДТП», «Срочно» (не более 3, доступны только вместе с услугой «XL-объявление»).'),
    },
    pathParams: ['itemId'],
    body: {
      contentType: 'application/json',
      fields: ['slugs', 'stickers'],
    },
  });
};
