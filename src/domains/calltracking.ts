/**
 * Домен `calltracking` — swaggers/CallTracking[КТ].json (3 endpoints).
 * Колл-трекинг: получение информации о звонках и аудиозаписях.
 *
 * Quirks:
 *   - getRecordByCallId возвращает БИНАРНОЕ audio (mp3/wav). С v0.5.0 client.ts
 *     детектит non-JSON/non-text content и оборачивает в { mimeType, sizeBytes, base64 }.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'calltracking_get_call_by_id',
    title: 'Колтрекинг: звонок по ID',
    risk: 'read',
    description:
      'Возвращает метаданные одного звонка по коллтрекингу по его callId (read-only): время звонка, длительности разговора и ожидания, номера покупателя/продавца, защитный (виртуальный) номер, itemId объявления. ' +
      'Используйте, когда известен конкретный callId; для выборки за период — calltracking_get_calls, для аудиозаписи разговора — calltracking_get_record_by_call_id.',
    method: 'POST',
    path: '/calltracking/v1/getCallById/',
    domain: 'calltracking',
    input: {
      callId: z
        .number()
        .int()
        .positive()
        .describe('Идентификатор звонка (callId), полученный из calltracking_get_calls.'),
    },
    body: { contentType: 'application/json', fields: ['callId'] },
  });

  defineTool(server, ctx, {
    name: 'calltracking_get_calls',
    title: 'Колтрекинг: список звонков',
    risk: 'read',
    description:
      'Возвращает список звонков по коллтрекингу за период с фильтром по времени звонка (callTime), с пагинацией (read-only). Требует временное окно в формате RFC3339. ' +
      'Для одного звонка по id используйте calltracking_get_call_by_id; запись разговора — calltracking_get_record_by_call_id.',
    method: 'POST',
    path: '/calltracking/v1/getCalls/',
    domain: 'calltracking',
    input: {
      dateTimeFrom: z
        .string()
        .describe(
          'Начало периода поиска по времени звонка (callTime), строка в формате RFC3339, например "2021-01-02T00:00:00Z". Обязательно.',
        ),
      dateTimeTo: z
        .string()
        .optional()
        .describe(
          'Конец периода поиска по callTime (RFC3339, например "2021-03-02T23:59:59Z"). Если не указан, берётся dateTimeFrom + 1 месяц; максимум — dateTimeFrom + 3 месяца.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe('Размер выборки — сколько звонков вернуть за один запрос (по API не более 100).'),
      offset: z
        .number()
        .int()
        .min(0)
        .describe('Смещение выборки для пагинации (число пропускаемых записей с начала, от 0).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['dateTimeFrom', 'dateTimeTo', 'limit', 'offset'],
    },
  });

  defineTool(server, ctx, {
    name: 'calltracking_get_record_by_call_id',
    title: 'Колтрекинг: аудиозапись звонка',
    risk: 'read',
    description:
      'Скачивает аудиозапись разговора по коллтрекингу для конкретного callId (read-only). Возвращает структурированный binary-ответ {mimeType: "audio/mpeg" (или wav), sizeBytes, base64}; декодируйте base64 для сохранения файла (размер может быть несколько MB). ' +
      'Запись становится доступна с задержкой до 30 минут после звонка и хранится 3 месяца; если запись ещё не готова, API вернёт ошибку (HTTP 425, код 1005). Для метаданных звонка используйте calltracking_get_call_by_id, для списка за период — calltracking_get_calls.',
    method: 'GET',
    path: '/calltracking/v1/getRecordByCallId/',
    domain: 'calltracking',
    input: {
      callId: z
        .number()
        .int()
        .positive()
        .describe('Идентификатор звонка (callId), для которого нужна аудиозапись разговора.'),
    },
    queryParams: ['callId'],
  });
};
