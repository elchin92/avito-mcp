/**
 * Мета-tools — не относятся к swagger, нужны для observability самого MCP-сервера.
 * Сейчас один: `meta_get_rate_limits` — последние увиденные X-RateLimit-* по доменам.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  server.registerTool(
    'meta_get_rate_limits',
    {
      description:
        'Возвращает последние увиденные значения X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset, ' +
        'сгруппированные по логическим доменам API (core, messenger, items и т.д.). ' +
        'Полезно для диагностики "почему меня троттлят" — Avito выставляет лимит на минуту.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (): Promise<CallToolResult> => {
      const snaps = ctx.client.rateLimiter.getStatus();
      if (snaps.length === 0) {
        return {
          content: [{ type: 'text', text: 'Нет данных: ни одного запроса к Avito ещё не сделано.' }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(snaps, null, 2) }],
      };
    },
  );
};
