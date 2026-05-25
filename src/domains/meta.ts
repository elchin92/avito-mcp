/**
 * Мета-tools — не относятся к swagger, нужны для observability самого MCP-сервера.
 * Сейчас один: `meta_get_rate_limits` — последние увиденные X-RateLimit-* по доменам.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { logger } from '../logger.js';
import type { DomainRegister } from '../core/tool-factory.js';
import { evaluatePolicy } from '../core/policy.js';

export const register: DomainRegister = (server, ctx) => {
  // Even though meta_get_rate_limits is risk='read' (and so passes mode checks),
  // it can still be hidden by allowlist/denylist policy.
  const decision = evaluatePolicy('meta_get_rate_limits', 'read', ctx.config);
  if (!decision.allowed) {
    logger.info(
      { tool: 'meta_get_rate_limits', risk: 'read', reason: decision.reason },
      'tool hidden by policy',
    );
    return;
  }
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
      _meta: { risk: 'read' },
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
