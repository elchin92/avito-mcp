/**
 * MCP Resources (spec 2025-11-25). Этот модуль регистрирует на сервере
 * статические и динамические ресурсы:
 *
 *   - `avito://docs/safety`              — markdown с safety-режимами и confirmation
 *   - `avito://manifest`                  — json реестр tool'ов (dist/manifest.json)
 *   - `avito://state/config`              — sanitized snapshot активного config (без секретов)
 *   - `avito://state/pending-actions`     — live JSON pending-actions (subscribable!)
 *   - `avito://state/rate-limits`         — последний снимок rate-limits по доменам
 *   - `avito://swaggers/{file}`           — raw swagger (template + list callback)
 *
 * `state/pending-actions` единственный, где сервер посылает `notifications/resources/updated`,
 * когда содержимое меняется (создан / подтверждён / отменён pending). Достигается путём
 * прокидывания EventEmitter-подобного onChange из PendingActionStore.
 *
 * Все ресурсы read-only. Зависимости — те же что и у tool-ов: ctx.client (для rate-limits),
 * ctx.config (для config snapshot и фильтрации секретов), ctx.pendingStore (для pending).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type ReadResourceResult,
  type ListResourcesResult,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from './logger.js';
import type { ToolContext } from './core/tool-factory.js';
import { PACKAGE_NAME, VERSION } from './version.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Корень репозитория. В dev-режиме (tsx) src/resources.ts → '..',
 * в build (node) dist/resources.js → '..'. Та же логика что в src/version.ts.
 */
const REPO_ROOT = resolve(here, '..');
const SAFETY_DOC = resolve(REPO_ROOT, 'docs', 'safety.md');
const MANIFEST = resolve(REPO_ROOT, 'dist', 'manifest.json');
const SWAGGERS_DIR = resolve(REPO_ROOT, 'swaggers');

/** Public URI для подписки клиентов на pending-actions updates. */
export const PENDING_ACTIONS_URI = 'avito://state/pending-actions';

/**
 * Удаляет из config поля, которые НИКОГДА не должны утечь клиенту:
 * client_id / client_secret / confirmation_secret / token_file path.
 *
 * Для каждого redacted-ключа всегда эмитим явный маркер: '[redacted]' если
 * value было задано или null если нет. Это видно клиенту даже когда исходный
 * field был undefined / отсутствовал — без сюрпризов "потерянного" поля.
 */
function sanitizeConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const REDACTED_KEYS = ['clientId', 'clientSecret', 'confirmationSecret', 'tokenFile'] as const;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if ((REDACTED_KEYS as readonly string[]).includes(k)) {
      out[k] = v === undefined || v === '' || v === null ? null : '[redacted]';
    } else {
      out[k] = v;
    }
  }
  // Гарантируем что все redacted-ключи присутствуют, даже если их не было в cfg.
  for (const k of REDACTED_KEYS) {
    if (!(k in out)) out[k] = null;
  }
  return out;
}

function jsonResource(uri: string, payload: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function textResource(uri: string, mimeType: string, text: string): ReadResourceResult {
  return { contents: [{ uri, mimeType, text }] };
}

function safeReadFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function registerResources(server: McpServer, ctx: ToolContext): void {
  // ─────────── avito://docs/safety ───────────
  server.registerResource(
    'safety-docs',
    'avito://docs/safety',
    {
      title: 'Safety modes & confirmation guide',
      description:
        'Markdown-документация по AVITO_MCP_MODE, AVITO_MCP_CONFIRMATION_MODE, ' +
        'AVITO_MCP_CONFIRMATION_SECRET и upload guard. Тот же файл что docs/safety.md.',
      mimeType: 'text/markdown',
    },
    async (uri): Promise<ReadResourceResult> => {
      const body = safeReadFile(SAFETY_DOC);
      if (body === null) {
        return textResource(
          uri.toString(),
          'text/markdown',
          '# Safety docs not found\n\nFile docs/safety.md is missing in this build.',
        );
      }
      return textResource(uri.toString(), 'text/markdown', body);
    },
  );

  // ─────────── avito://manifest ───────────
  server.registerResource(
    'tools-manifest',
    'avito://manifest',
    {
      title: 'Tools manifest (живой реестр tool-ов)',
      description:
        'JSON-каталог всех зарегистрированных MCP tool с их risk/domain/annotations. ' +
        'Тот же файл, что dist/manifest.json — генерируется через npm run generate:manifest.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const body = safeReadFile(MANIFEST);
      if (body === null) {
        return jsonResource(uri.toString(), {
          error: 'manifest_missing',
          hint: 'Run npm run generate:manifest first',
          name: PACKAGE_NAME,
          version: VERSION,
        });
      }
      return {
        contents: [
          { uri: uri.toString(), mimeType: 'application/json', text: body },
        ],
      };
    },
  );

  // ─────────── avito://state/config ───────────
  server.registerResource(
    'config-snapshot',
    'avito://state/config',
    {
      title: 'Активная конфигурация сервера',
      description:
        'Снимок effective config (mode, allow/deny, confirmation, upload), без секретов. ' +
        'Используйте чтобы быстро понять, в каком режиме работает сервер.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      return jsonResource(uri.toString(), {
        name: PACKAGE_NAME,
        version: VERSION,
        config: sanitizeConfig(ctx.config as unknown as Record<string, unknown>),
      });
    },
  );

  // ─────────── avito://state/rate-limits ───────────
  server.registerResource(
    'rate-limits',
    'avito://state/rate-limits',
    {
      title: 'Последний снимок rate-limits',
      description:
        'Текущие X-RateLimit-Limit / Remaining / Reset по логическим доменам Avito API. ' +
        'Пусто, если ни одного запроса ещё не было.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const snaps = ctx.client.rateLimiter.getStatus();
      return jsonResource(uri.toString(), {
        observed_at: new Date().toISOString(),
        snapshots: snaps,
        count: snaps.length,
      });
    },
  );

  // ─────────── avito://state/pending-actions ───────────
  // subscribable: при изменении pending-store сервер шлёт resources/updated.
  server.registerResource(
    'pending-actions',
    PENDING_ACTIONS_URI,
    {
      title: 'Pending actions (live)',
      description:
        'Текущие отложенные действия ожидающие confirmation. Subscribable: клиент может ' +
        'подписаться через resources/subscribe и получать notifications/resources/updated ' +
        'при каждом create/confirm/cancel/expire.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const items = ctx.pendingStore.list();
      return jsonResource(uri.toString(), {
        count: items.length,
        confirmation_mode: ctx.config.confirmationMode,
        confirmation_ttl_sec: ctx.config.confirmationTtlSec,
        hard_confirmation: !!ctx.config.confirmationSecret,
        pending: items.map((a) => ({
          id: a.id,
          tool: a.toolName,
          risk: a.risk,
          summary: a.summary,
          created_at: new Date(a.createdAt).toISOString(),
          expires_at: new Date(a.expiresAt).toISOString(),
        })),
      });
    },
  );

  // SDK McpServer не регистрирует subscribe/unsubscribe автоматически — capability
  // мы заявили в server.ts, обработчики обязаны быть. Реализуем тонко:
  // отслеживаем set подписчиков, при изменении pending-actions шлём только им.
  const subscribers = new Set<string>();
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribers.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribers.delete(req.params.uri);
    return {};
  });

  // Подключаем emitter: каждое change в PendingActionStore -> sendResourceUpdated,
  // если есть подписчик на этот URI.
  ctx.pendingStore.onChange(() => {
    if (!subscribers.has(PENDING_ACTIONS_URI)) return;
    server.server
      .sendResourceUpdated({ uri: PENDING_ACTIONS_URI })
      .catch((err: unknown) => {
        logger.debug({ err }, 'sendResourceUpdated failed');
      });
  });

  // ─────────── avito://swaggers/{file} ───────────
  // ResourceTemplate с list callback — клиент видит каждый swagger как отдельный resource.
  const swaggerFiles = existsSync(SWAGGERS_DIR)
    ? readdirSync(SWAGGERS_DIR).filter((f) => f.toLowerCase().endsWith('.json'))
    : [];
  const swaggerSlug = (filename: string): string =>
    encodeURIComponent(filename.replace(/\.json$/i, ''));

  server.registerResource(
    'swagger-file',
    new ResourceTemplate('avito://swaggers/{slug}', {
      list: async (): Promise<ListResourcesResult> => ({
        resources: swaggerFiles.map((f) => ({
          uri: `avito://swaggers/${swaggerSlug(f)}`,
          name: f.replace(/\.json$/i, ''),
          title: f.replace(/\.json$/i, ''),
          mimeType: 'application/json',
          description: `Raw Avito swagger ${f}`,
        })),
      }),
      complete: {
        slug: async (value: string): Promise<string[]> =>
          swaggerFiles
            .map((f) => swaggerSlug(f))
            .filter((s) => s.toLowerCase().startsWith(value.toLowerCase()))
            .slice(0, 100),
      },
    }),
    {
      title: 'Avito swagger (raw OpenAPI)',
      description:
        'Сырые swagger-файлы из swaggers/. По одному resource на каждый файл. ' +
        'Используйте чтобы дать агенту полный контекст endpoint-а без mcp tools.',
      mimeType: 'application/json',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const slugRaw = Array.isArray(variables.slug) ? variables.slug[0] : variables.slug;
      const slug = decodeURIComponent(String(slugRaw ?? ''));
      // Защита от path-traversal: не пускаем '..', '/' и нулевые байты.
      if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\0')) {
        throw new Error(`Invalid swagger slug: ${slug}`);
      }
      const filename = `${slug}.json`;
      const full = join(SWAGGERS_DIR, filename);
      // Проверяем что разрешённый путь не выходит за пределы каталога.
      if (!resolve(full).startsWith(resolve(SWAGGERS_DIR) + '/')) {
        throw new Error(`Swagger path escapes directory: ${slug}`);
      }
      const body = safeReadFile(full);
      if (body === null) {
        throw new Error(`Swagger '${slug}' not found. Available: ${swaggerFiles.join(', ')}`);
      }
      return {
        contents: [
          { uri: uri.toString(), mimeType: 'application/json', text: body },
        ],
      };
    },
  );

  logger.info(
    { resourceCount: 5, swaggerCount: swaggerFiles.length },
    'MCP resources registered',
  );
}
