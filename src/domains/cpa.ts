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
    description:
      'Возвращает запись (аудио) CPA-звонка по его идентификатору (v1, deprecated). Только чтение, денег не тратит. Устарел — предпочитайте cpa_get_call_by_id_v2 (или calltracking get_record_by_call_id), которые возвращают полную модель звонка вместе с записью. Лимит: 1 запрос/мин.',
    method: 'GET',
    path: '/cpa/v1/call/{call_id}',
    domain: 'cpa',
    input: {
      call_id: z.number().int().positive().describe('Идентификатор CPA-звонка (call_id), полученный из cpa_get_calls_by_time_v2 или из чата/действия.'),
    },
    pathParams: ['call_id'],
  });

  defineTool(server, ctx, {
    name: 'cpa_chat_by_action_id',
    title: 'CPA: чат по actionId',
    risk: 'read',
    description:
      'Возвращает модель CPA-чата по идентификатору целевого действия (actionId). Только чтение, денег не тратит. Используйте, когда уже есть actionId конкретного чата (из cpa_chats_by_time_v2); не для перебора по времени. Лимит: 3 запроса/мин.',
    method: 'GET',
    path: '/cpa/v1/chatByActionId/{actionId}',
    domain: 'cpa',
    input: {
      actionId: z.number().int().positive().describe('Идентификатор целевого действия CPA (actionId чата), полученный из cpa_chats_by_time_v2.'),
    },
    pathParams: ['actionId'],
  });

  defineTool(server, ctx, {
    name: 'cpa_chats_by_time_v1',
    title: 'CPA: чаты за период (v1, deprecated)',
    risk: 'read',
    description:
      'Возвращает список целевых CPA-чатов, созданных начиная с указанного момента, с пагинацией (v1, deprecated). Только чтение, денег не тратит. Устарел — предпочитайте cpa_chats_by_time_v2 (идентичная семантика, выше лимит запросов: 40 против 60/мин у v1, но v2 — актуальная версия).',
    method: 'POST',
    path: '/cpa/v1/chatsByTime',
    domain: 'cpa',
    input: {
      dateTimeFrom: z.string().describe('Момент, с которого искать чаты по полю date, в формате RFC3339, напр. "2021-01-02T15:04:05Z".'),
      limit: z.number().int().min(1).max(1000).describe('Размер выборки (количество чатов). API принимает не более 100.'),
      offset: z.number().int().min(0).describe('Смещение выборки (по умолчанию 0). Для производительности лучше передавать максимальный startTime/date чата из предыдущей выборки.'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_post_create_complaint',
    title: '⚠️ CPA: жалоба на звонок',
    risk: 'write',
    destructiveHint: true,
    description:
      '⚠️ Создаёт жалобу на CPA-звонок по его callId (запись действия) — например при оспаривании списания за нецелевой звонок. Необратимая запись: жалобу нельзя отозвать. Требует callId конкретного звонка из предшествующего вызова (cpa_get_calls_by_time_v2). Для жалоб и на звонки, и на чаты по единому actionId используйте cpa_create_complaint_by_action_id. Лимит: 1 запрос/мин.',
    method: 'POST',
    path: '/cpa/v1/createComplaint',
    domain: 'cpa',
    input: {
      callId: z.number().int().positive().describe('Идентификатор CPA-звонка (callId, int64), на который подаётся жалоба.'),
      message: z.string().min(1).describe('Текст жалобы — описание причины оспаривания целевого действия.'),
    },
    body: { contentType: 'application/json', fields: ['callId', 'message'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_create_complaint_by_action_id',
    title: '⚠️ CPA: жалоба по actionId',
    risk: 'write',
    destructiveHint: true,
    description:
      '⚠️ Создаёт жалобу на целевое действие CPA (звонок или чат) по его actionId — для оспаривания списания за нецелевое действие. Необратимая запись: жалобу нельзя отозвать. Требует actionId из предшествующего вызова (cpa_chats_by_time_v2 / cpa_get_calls_by_time_v2). Предпочтительнее cpa_post_create_complaint, так как покрывает и звонки, и чаты. Лимит: 3 запроса/мин.',
    method: 'POST',
    path: '/cpa/v1/createComplaintByActionId',
    domain: 'cpa',
    input: {
      actionId: z.number().int().positive().describe('Идентификатор целевого действия CPA (actionId звонка или чата, напр. 123456789), на которое подаётся жалоба.'),
      message: z.string().min(1).describe('Текст жалобы, прикрепляемый к действию, напр. "это не был обмен контактами в чате".'),
    },
    body: { contentType: 'application/json', fields: ['actionId', 'message'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_phones_info_from_chats',
    title: 'CPA: телефоны из чатов',
    risk: 'read',
    description:
      'Возвращает информацию по номерам телефонов, извлечённым из целевых CPA-чатов начиная с указанного момента, с пагинацией. Только чтение, денег не тратит. Используйте для выгрузки контактов клиентов из переписки за период. Лимит: 5 запросов/мин.',
    method: 'POST',
    path: '/cpa/v1/phonesInfoFromChats',
    domain: 'cpa',
    input: {
      dateTimeFrom: z.string().describe('Момент, с которого начинается поиск, в формате RFC3339, напр. "2021-01-02T15:04:05Z".'),
      limit: z.number().int().min(1).max(1000).describe('Размер выборки (количество записей).'),
      offset: z.number().int().min(0).describe('Смещение выборки (по умолчанию 0) для постраничного перебора.'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_balance_info_v2',
    title: 'CPA: баланс (v2, deprecated)',
    risk: 'read',
    description:
      'Возвращает баланс CPA-кошелька в копейках: баланс, долг и аванс текущего месяца (v2, deprecated). Только чтение, денег не тратит. Тело запроса пустое (`{}`). Устарел — предпочитайте cpa_balance_info_v3 (актуальная версия). Лимит: 1 запрос/мин.',
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
    description:
      'Возвращает полную модель CPA-звонка по callId, включая ссылку на запись (v2). Только чтение, денег не тратит. Используйте, когда уже известен callId (из cpa_get_calls_by_time_v2). Актуальная замена устаревшего cpa_get_call (v1).',
    method: 'POST',
    path: '/cpa/v2/callById',
    domain: 'cpa',
    input: {
      callId: z.number().int().positive().describe('Идентификатор CPA-звонка (callId, int64), полученный из cpa_get_calls_by_time_v2.'),
    },
    body: { contentType: 'application/json', fields: ['callId'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_get_calls_by_time_v2',
    title: 'CPA: звонки за период',
    risk: 'read',
    description:
      'Возвращает список CPA-звонков, созданных начиная с указанного момента (по startTime), с пагинацией (v2). Только чтение, денег не тратит. Используйте для перебора звонков за период; полученные callId/actionId далее подходят для cpa_get_call_by_id_v2 или подачи жалобы. Лимит: 1 запрос/мин.',
    method: 'POST',
    path: '/cpa/v2/callsByTime',
    domain: 'cpa',
    input: {
      dateTimeFrom: z.string().describe('Момент, с которого искать звонки по startTime, в формате RFC3339, напр. "2021-01-02T15:04:05Z".'),
      limit: z.number().int().min(1).max(1000).describe('Размер выборки (количество звонков).'),
      offset: z.number().int().min(0).optional().describe('Смещение выборки (по умолчанию 0). Для производительности лучше передавать максимальный startTime звонка из предыдущей выборки.'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_chats_by_time_v2',
    title: 'CPA: чаты за период',
    risk: 'read',
    description:
      'Возвращает список целевых CPA-чатов, созданных начиная с указанного момента (по полю date), с пагинацией (v2 — актуальная). Только чтение, денег не тратит. Предпочитайте этот метод устаревшему cpa_chats_by_time_v1. Полученные actionId далее подходят для cpa_chat_by_action_id или подачи жалобы. Лимит: 40 запросов/мин.',
    method: 'POST',
    path: '/cpa/v2/chatsByTime',
    domain: 'cpa',
    input: {
      dateTimeFrom: z.string().describe('Момент, с которого искать чаты по полю date, в формате RFC3339, напр. "2021-01-02T15:04:05Z".'),
      limit: z.number().int().min(1).max(1000).describe('Размер выборки (количество чатов). API принимает не более 100.'),
      offset: z.number().int().min(0).describe('Смещение выборки (по умолчанию 0). Для производительности лучше передавать максимальный date чата из предыдущей выборки.'),
    },
    body: { contentType: 'application/json', fields: ['dateTimeFrom', 'limit', 'offset'] },
  });

  defineTool(server, ctx, {
    name: 'cpa_balance_info_v3',
    title: 'CPA: баланс',
    risk: 'read',
    description:
      'Возвращает текущий баланс CPA-кошелька пользователя в копейках (v3 — актуальная). Только чтение, денег не тратит. Тело запроса пустое (`{}`). v3 отличается от v2 актуализированной структурой ответа — предпочитайте v3. Лимит: 1 запрос/мин.',
    method: 'POST',
    path: '/cpa/v3/balanceInfo',
    domain: 'cpa',
    input: {},
    body: { contentType: 'application/json', defaults: {} },
  });
};
