/**
 * Домен `calltracking` — swaggers/CallTracking[КТ].json (3 endpoints).
 * Колл-трекинг: получение информации о звонках и аудиозаписях.
 *
 * Quirks:
 *   - getRecordByCallId возвращает БИНАРНОЕ audio (mp3/wav). MCP-tool отдаст raw как text.
 *     Для бинарных файлов используйте прямой curl с токеном.
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'calltracking_get_call_by_id',
    risk: 'read',
    description: 'Информация о звонке по callId (метаданные, длительность, статус).',
    method: 'POST',
    path: '/calltracking/v1/getCallById/',
    domain: 'calltracking',
    input: {
      callId: z.number().int().positive().describe('ID звонка.'),
    },
    body: { contentType: 'application/json', fields: ['callId'] },
  });

  defineTool(server, ctx, {
    name: 'calltracking_get_calls',
    risk: 'read',
    description:
      'Список звонков за период с пагинацией. dateTimeFrom/To — ISO 8601. ' +
      'limit, offset — обязательные.',
    method: 'POST',
    path: '/calltracking/v1/getCalls/',
    domain: 'calltracking',
    input: {
      dateTimeFrom: z.string().describe('Начало периода (ISO 8601).'),
      dateTimeTo: z.string().optional().describe('Конец периода (ISO 8601).'),
      limit: z.number().int().min(1).max(1000).describe('Сколько звонков вернуть.'),
      offset: z.number().int().min(0).describe('Смещение пагинации.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['dateTimeFrom', 'dateTimeTo', 'limit', 'offset'],
    },
  });

  defineTool(server, ctx, {
    name: 'calltracking_get_record_by_call_id',
    risk: 'read',
    description:
      'Получение аудиозаписи звонка по callId. Возвращает БИНАРНЫЕ данные (mp3/wav) ' +
      'как text — используйте прямой curl с токеном для сохранения файла.',
    method: 'GET',
    path: '/calltracking/v1/getRecordByCallId/',
    domain: 'calltracking',
    input: {
      callId: z.number().int().positive().describe('ID звонка.'),
    },
    queryParams: ['callId'],
  });
};
