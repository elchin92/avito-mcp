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
    title: 'Автозагрузка: получить профиль (v1, deprecated)',
    risk: 'read',
    description:
      'Возвращает настройки профиля автозагрузки (v1): autoload_enabled, report_email, расписание (schedule) и устаревшее поле upload_url. ' +
      'Только чтение, без параметров. УСТАРЕЛО: с 23.12.2024 поле upload_url заменено на feeds_data — используйте autoload_get_profile_v2, ' +
      'который возвращает массив фидов. Предпочитайте v2.',
    method: 'GET',
    path: '/autoload/v1/profile',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_create_or_update_profile',
    title: 'Автозагрузка: сохранить профиль (v1, deprecated)',
    risk: 'write',
    description:
      'Создаёт или обновляет (upsert) профиль автозагрузки v1 одним URL-фидом. Изменяет настройки на стороне Avito; ' +
      'при отсутствии профиля создаёт его. УСТАРЕЛО: с 23.12.2024 одиночный upload_url заменён на массив feeds_data — ' +
      'используйте autoload_create_or_update_profile_v2 (поддержка нескольких фидов). Предпочитайте v2.',
    method: 'POST',
    path: '/autoload/v1/profile',
    domain: 'autoload',
    input: {
      autoload_enabled: z.boolean().describe('Статус автозагрузки: true — включена, false — выключена. Обязательное.'),
      report_email: z.string().email().describe('Email, на который Avito будет присылать отчёты о выгрузках. Обязательное.'),
      upload_url: z.string().url().describe('URL-адрес XML/YML-фида с объявлениями для регулярных выгрузок. Должен начинаться с http или https. Обязательное.'),
      schedule: z
        .record(z.string(), z.unknown())
        .describe(
          'Расписание регулярных выгрузок (массив периодов): каждый элемент = {rate: число объявлений за период, weekdays: [0-6, где 0=понедельник], time_slots: [0-23, где 0 = промежуток 00:00-01:00]}. Время по Москве. Обязательное. См. схему ExportSchedule в swagger Автозагрузка.json.',
        ),
      agreement: z
        .boolean()
        .optional()
        .describe('Согласие с правилами использования Авито Автозагрузки. Обязательно только при первом создании профиля; при обновлении можно опустить.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['autoload_enabled', 'report_email', 'upload_url', 'schedule', 'agreement'],
    },
  });

  // ────────────────────────────── UPLOAD ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_upload',
    title: '⚠️ Автозагрузка: запустить выгрузку',
    risk: 'write',
    description:
      '⚠️ Немедленно ЗАПУСКАЕТ внеплановую выгрузку объявлений из фида по URL, указанному в настройках профиля (autoload_create_or_update_profile_v2). ' +
      'Побочный эффект: публикует/обновляет/активирует объявления на Avito; на эту выгрузку НЕ распространяются лимиты публикаций из настроек — будут обработаны все объявления из файла. ' +
      'Лимит: одна выгрузка в час. Без параметров. Возвращает только подтверждение запуска; результат смотрите позже через autoload_get_last_completed_report_v3.',
    method: 'POST',
    path: '/autoload/v1/upload',
    domain: 'autoload',
    input: {},
  });

  // ────────────────────────────── USER DOCS (справочник категорий) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_user_docs_tree',
    title: 'Автозагрузка: дерево категорий',
    risk: 'read',
    description:
      'Возвращает полное дерево категорий Avito (массив узлов с name, slug/id и вложенными nested) для подготовки фида автозагрузки. ' +
      'Только чтение, без параметров. Используйте, чтобы найти slug нужной категории, а затем передать его в autoload_user_docs_node_fields для получения полей. ' +
      'Справочник кэшируемый и меняется редко.',
    method: 'GET',
    path: '/autoload/v1/user-docs/tree',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_user_docs_node_fields',
    title: 'Автозагрузка: поля категории',
    risk: 'read',
    description:
      'Возвращает поля (теги) конкретной категории для заполнения фида: их типы (input/select/checkbox), обязательность, зависимости между полями, допустимые значения и ссылки на каталоги. ' +
      'Только чтение. Сначала найдите slug категории через autoload_user_docs_tree, затем вызовите этот метод. ' +
      'Используйте при подготовке XML/Excel-файла, чтобы знать какие теги обязательны для категории.',
    method: 'GET',
    path: '/autoload/v1/user-docs/node/{node_slug}/fields',
    domain: 'autoload',
    input: {
      node_slug: z
        .string()
        .describe('Slug (уникальный идентификатор) категории из дерева autoload_user_docs_tree, например "remont". Обязательное.'),
    },
    pathParams: ['node_slug'],
  });

  // ────────────────────────────── ID MAPPING ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_ad_ids_by_avito_ids',
    title: 'Автозагрузка: Ad ID по Avito ID',
    risk: 'read',
    description:
      'Возвращает идентификаторы объявлений из файла автозагрузки (ad_id) по их идентификаторам на Avito (avito_id) — сопоставление avito_id → ad_id. ' +
      'Только чтение. Используйте, когда есть Avito ID и нужно найти соответствующий ID из исходного фида. Обратное направление — autoload_get_avito_ids_by_ad_ids.',
    method: 'GET',
    path: '/autoload/v2/items/ad_ids',
    domain: 'autoload',
    input: {
      query: z
        .string()
        .describe('Список Avito ID объявлений, перечисленных через «,» или «|» (например "12345,6789"). Обязательное.'),
    },
    queryParams: ['query'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_avito_ids_by_ad_ids',
    title: 'Автозагрузка: Avito ID по Ad ID',
    risk: 'read',
    description:
      'Возвращает идентификаторы объявлений на Avito (avito_id) по их идентификаторам из файла автозагрузки (ad_id) — сопоставление ad_id → avito_id. ' +
      'Только чтение. Используйте, когда есть ID из фида и нужно найти опубликованное объявление на Avito. Обратное направление — autoload_get_ad_ids_by_avito_ids.',
    method: 'GET',
    path: '/autoload/v2/items/avito_ids',
    domain: 'autoload',
    input: {
      query: z
        .string()
        .describe('Список ID объявлений из файла (параметр Id фида), перечисленных через «,» или «|». Обязательное.'),
    },
    queryParams: ['query'],
  });

  // ────────────────────────────── PROFILE V2 ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_profile_v2',
    title: 'Автозагрузка: профиль',
    risk: 'read',
    description:
      'Возвращает настройки профиля автозагрузки (v2, актуальная версия): autoload_enabled, report_email, расписание (schedule) и массив фидов feeds_data (название + ссылка на файл). ' +
      'Только чтение, без параметров. Предпочитайте этот метод вместо autoload_get_profile (v1): v2 отдаёт feeds_data вместо устаревшего одиночного upload_url.',
    method: 'GET',
    path: '/autoload/v2/profile',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_create_or_update_profile_v2',
    title: 'Автозагрузка: сохранить профиль',
    risk: 'write',
    description:
      'Создаёт или обновляет (upsert) профиль автозагрузки (v2, актуальная версия). Изменяет настройки на стороне Avito; при отсутствии профиля создаёт его. ' +
      'Поддерживает несколько фидов через feeds_data (в отличие от v1 с одним upload_url) — предпочитайте этот метод. ' +
      'Запуск самих выгрузок выполняется по расписанию schedule либо вручную через autoload_upload.',
    method: 'POST',
    path: '/autoload/v2/profile',
    domain: 'autoload',
    input: {
      autoload_enabled: z.boolean().describe('Статус автозагрузки: true — включена, false — выключена. Обязательное.'),
      report_email: z.string().email().describe('Email, на который Avito будет присылать отчёты о выгрузках. Обязательное.'),
      feeds_data: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          'Массив фидов (минимум один). Каждый элемент = {feed_name: название фида для отчёта, feed_url: URL файла с объявлениями, начинается с http/https}. Обязательное. См. схему FeedsData в swagger Автозагрузка.json.',
        ),
      schedule: z
        .record(z.string(), z.unknown())
        .describe(
          'Расписание регулярных выгрузок (массив периодов): каждый элемент = {rate: число объявлений за период, weekdays: [0-6, где 0=понедельник], time_slots: [0-23, где 0 = промежуток 00:00-01:00]}. Время по Москве. Обязательное. См. схему ExportSchedule в swagger Автозагрузка.json.',
        ),
      agreement: z
        .boolean()
        .optional()
        .describe('Согласие с правилами использования Авито Автозагрузки. Обязательно только при первом создании профиля; при обновлении можно опустить.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['autoload_enabled', 'report_email', 'feeds_data', 'schedule', 'agreement'],
    },
  });

  // ────────────────────────────── REPORTS V2 ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_reports_v2',
    title: 'Автозагрузка: список отчётов',
    risk: 'read',
    description:
      'Возвращает список отчётов автозагрузки (id, started_at, finished_at, status) с пагинацией и фильтром по дате создания. ' +
      'Отсортирован по убыванию: самый свежий отчёт первым. Только чтение, ответ содержит блок meta с total/pages. ' +
      'Используйте, чтобы найти report_id, затем берите детали через autoload_get_report_by_id_v3 / autoload_get_report_items_by_id.',
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
        .describe('Количество отчётов на странице. По умолчанию 50; в API допустимо до 200, но здесь ограничено 100.'),
      page: z.number().int().min(1).optional().describe('Номер страницы (целое ≥ 1). По умолчанию первая страница.'),
      date_from: z
        .string()
        .optional()
        .describe('Фильтр по дате создания отчёта «от» (включительно), формат RFC3339, например "2022-05-27T14:48:50.52Z".'),
      date_to: z
        .string()
        .optional()
        .describe('Фильтр по дате создания отчёта «до» (включительно), формат RFC3339, например "2022-05-27T14:48:50.52Z".'),
    },
    queryParams: ['per_page', 'page', 'date_from', 'date_to'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_autoload_items_info_v2',
    title: 'Автозагрузка: инфо об объявлениях',
    risk: 'read',
    description:
      'Возвращает текущее состояние объявлений в автозагрузке по их ID из файла: avito_id, avito_status, раздел отчёта, ошибки/предупреждения (messages), информацию о списании и дату обработки. ' +
      'Только чтение, не привязано к конкретному отчёту — отдаёт актуальный статус. Используйте для точечной проверки выбранных объявлений (1–100 за запрос).',
    method: 'GET',
    path: '/autoload/v2/reports/items',
    domain: 'autoload',
    input: {
      query: z
        .string()
        .describe('Идентификаторы объявлений из файла (параметр Id фида): от 1 до 100, перечисленных через «,» или «|». Обязательное.'),
    },
    queryParams: ['query'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_last_completed_report',
    title: 'Автозагрузка: последний отчёт (v1, deprecated)',
    risk: 'read',
    description:
      'Возвращает сводную статистику последней завершённой выгрузки (v2-формат): счётчики по разделам (section_stats), списания (listing_fees), события и ссылку feed_url. ' +
      'Только чтение, без параметров. УСТАРЕЛО: с 23.12.2024 одиночный feed_url заменён на feeds_urls — используйте autoload_get_last_completed_report_v3. Предпочитайте v3.',
    method: 'GET',
    path: '/autoload/v2/reports/last_completed_report',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_by_id_v2',
    title: 'Автозагрузка: отчёт по ID (v2, deprecated)',
    risk: 'read',
    description:
      'Возвращает сводную статистику конкретной выгрузки по её report_id (v2-формат): section_stats, listing_fees, события, статус и ссылку feed_url. ' +
      'Только чтение. report_id берите из autoload_get_reports_v2. УСТАРЕЛО: с 23.12.2024 feed_url заменён на feeds_urls — используйте autoload_get_report_by_id_v3. Предпочитайте v3.',
    method: 'GET',
    path: '/autoload/v2/reports/{report_id}',
    domain: 'autoload',
    input: {
      report_id: z
        .number()
        .int()
        .positive()
        .describe('Идентификатор отчёта (ID) автозагрузки; получить через autoload_get_reports_v2. Обязательное.'),
    },
    pathParams: ['report_id'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_items_by_id',
    title: 'Автозагрузка: объявления выгрузки',
    risk: 'read',
    description:
      'Возвращает результат обработки каждого объявления в конкретной выгрузке (по report_id): ad_id, avito_id, avito_status, раздел отчёта, ошибки/предупреждения и ссылку. ' +
      'Только чтение, с пагинацией (ответ содержит meta с total/pages). Используйте для построчного разбора выгрузки; сводку по выгрузке смотрите в autoload_get_report_by_id_v3. ' +
      'Список доступных разделов для фильтра sections возьмите из section_stats отчёта.',
    method: 'GET',
    path: '/autoload/v2/reports/{report_id}/items',
    domain: 'autoload',
    input: {
      report_id: z
        .number()
        .int()
        .positive()
        .describe('Идентификатор отчёта (ID) автозагрузки; получить через autoload_get_reports_v2. Обязательное.'),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Количество объявлений на странице. По умолчанию 50; в API допустимо до 200, но здесь ограничено 100.'),
      page: z.number().int().min(1).optional().describe('Номер страницы (целое ≥ 1). По умолчанию первая страница.'),
      query: z
        .string()
        .optional()
        .describe('Фильтр по ID объявления: один или несколько ID из файла или Avito ID, перечисленных через «,» или «|».'),
      sections: z
        .string()
        .optional()
        .describe('Фильтр по разделам отчёта: slug-идентификаторы разделов через «,» или «|» (slug берите из section_stats отчёта, например через autoload_get_report_by_id_v3).'),
    },
    pathParams: ['report_id'],
    queryParams: ['per_page', 'page', 'query', 'sections'],
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_items_fees_by_id',
    title: 'Автозагрузка: списания за выгрузку',
    risk: 'read',
    description:
      'Возвращает списания за размещение каждого объявления в конкретной выгрузке (по report_id): ad_id, avito_id, тип списания (single — из кошелька / package — из пакета), сумму или ID пакета. ' +
      'Только чтение, с пагинацией (meta с total/pages). Используйте для разбора затрат на выгрузку; для обработки/статусов объявлений берите autoload_get_report_items_by_id.',
    method: 'GET',
    path: '/autoload/v2/reports/{report_id}/items/fees',
    domain: 'autoload',
    input: {
      report_id: z
        .number()
        .int()
        .positive()
        .describe('Идентификатор отчёта (ID) автозагрузки; получить через autoload_get_reports_v2. Обязательное.'),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Количество списаний на странице. По умолчанию 100 (в API допустимо до 200).'),
      page: z.number().int().min(1).optional().describe('Номер страницы (целое ≥ 1). По умолчанию первая страница.'),
      ad_ids: z
        .string()
        .optional()
        .describe('Фильтр по ID объявлений из файла (параметр Id фида), перечисленных через «,» или «|».'),
      avito_ids: z
        .string()
        .optional()
        .describe('Фильтр по Avito ID объявлений, перечисленных через «,» или «|».'),
    },
    pathParams: ['report_id'],
    queryParams: ['per_page', 'page', 'ad_ids', 'avito_ids'],
  });

  // ────────────────────────────── REPORTS V3 (актуальные) ──────────────────────────────

  defineTool(server, ctx, {
    name: 'autoload_get_last_completed_report_v3',
    title: 'Автозагрузка: последний отчёт',
    risk: 'read',
    description:
      'Возвращает сводную статистику последней завершённой выгрузки (v3, актуальный формат): счётчики по разделам (section_stats), списания (listing_fees), события и массив ссылок feeds_urls. ' +
      'Только чтение, без параметров. Используйте после того как выгрузка обработана (status success/success_warning/error); для конкретного отчёта берите autoload_get_report_by_id_v3. ' +
      'v3 отличается от v2 поддержкой нескольких фидов (feeds_urls вместо одиночного feed_url) — предпочитайте v3.',
    method: 'GET',
    path: '/autoload/v3/reports/last_completed_report',
    domain: 'autoload',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'autoload_get_report_by_id_v3',
    title: 'Автозагрузка: отчёт по ID',
    risk: 'read',
    description:
      'Возвращает сводную статистику конкретной выгрузки по её report_id (v3, актуальный формат): section_stats, listing_fees, события, статус и массив ссылок feeds_urls. ' +
      'Только чтение. report_id берите из autoload_get_reports_v2; построчный разбор объявлений — в autoload_get_report_items_by_id. ' +
      'v3 отличается от v2 поддержкой нескольких фидов (feeds_urls вместо одиночного feed_url) — предпочитайте v3.',
    method: 'GET',
    path: '/autoload/v3/reports/{report_id}',
    domain: 'autoload',
    input: {
      report_id: z
        .number()
        .int()
        .positive()
        .describe('Идентификатор отчёта (ID) автозагрузки; получить через autoload_get_reports_v2. Обязательное.'),
    },
    pathParams: ['report_id'],
  });
};
