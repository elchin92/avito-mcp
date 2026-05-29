/**
 * MCP Resources (spec 2025-11-25). This module registers static and dynamic
 * resources on the server:
 *
 *   - `avito://docs/safety`              — markdown with safety modes and confirmation
 *   - `avito://manifest`                  — JSON registry of tools (dist/manifest.json)
 *   - `avito://state/config`              — sanitized snapshot of the active config (no secrets)
 *   - `avito://state/pending-actions`     — live JSON pending-actions (subscribable!)
 *   - `avito://state/rate-limits`         — latest rate-limit snapshot per domain
 *   - `avito://swaggers/{file}`           — raw swagger (template + list callback)
 *
 * `state/pending-actions` is the only one where the server emits `notifications/resources/updated`
 * when its contents change (pending created / confirmed / cancelled). This is achieved by
 * wiring an EventEmitter-like onChange from the PendingActionStore.
 *
 * All resources are read-only. Dependencies are the same as for tools: ctx.client (for rate-limits),
 * ctx.config (for the config snapshot and secret filtering), ctx.pendingStore (for pending).
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
 * Repository root. In dev mode (tsx) src/resources.ts → '..',
 * in a build (node) dist/resources.js → '..'. Same logic as in src/version.ts.
 */
const REPO_ROOT = resolve(here, '..');
const SAFETY_DOC = resolve(REPO_ROOT, 'docs', 'safety.md');
const MANIFEST = resolve(REPO_ROOT, 'dist', 'manifest.json');
const SWAGGERS_DIR = resolve(REPO_ROOT, 'swaggers');

/** Public URI for clients to subscribe to pending-actions updates. */
export const PENDING_ACTIONS_URI = 'avito://state/pending-actions';

/**
 * Removes from config the fields that must NEVER leak to the client:
 * client_id / client_secret / confirmation_secret / token_file path.
 *
 * For every redacted key we always emit an explicit marker: '[redacted]' if
 * the value was set, or null if it was not. The client sees this even when the
 * original field was undefined / absent — no surprises from a "lost" field.
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
  // Ensure all redacted keys are present, even if they were absent from cfg.
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
        'Markdown documentation for AVITO_MCP_MODE, AVITO_MCP_CONFIRMATION_MODE, ' +
        'AVITO_MCP_CONFIRMATION_SECRET and the upload guard. The same file as docs/safety.md.',
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
      title: 'Tools manifest (live tool registry)',
      description:
        'JSON catalogue of every registered MCP tool with its risk/domain/annotations. ' +
        'The same file as dist/manifest.json — generated via npm run generate:manifest.',
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
      title: 'Active server configuration',
      description:
        'Snapshot of the effective config (mode, allow/deny, confirmation, upload), without secrets. ' +
        'Use it to quickly understand which mode the server is running in.',
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
      title: 'Latest rate-limits snapshot',
      description:
        'Current X-RateLimit-Limit / Remaining / Reset per logical Avito API domain. ' +
        'Empty if no request has been made yet.',
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
  // subscribable: when the pending-store changes, the server sends resources/updated.
  server.registerResource(
    'pending-actions',
    PENDING_ACTIONS_URI,
    {
      title: 'Pending actions (live)',
      description:
        'Pending actions currently awaiting confirmation. Subscribable: a client can ' +
        'subscribe via resources/subscribe and receive notifications/resources/updated ' +
        'on every create/confirm/cancel/expire.',
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

  // The SDK McpServer does not register subscribe/unsubscribe automatically — we
  // declared the capability in server.ts, so the handlers must exist. We implement
  // it lightly: track a set of subscribers and, on a pending-actions change, notify only them.
  const subscribers = new Set<string>();
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribers.add(req.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribers.delete(req.params.uri);
    return {};
  });

  // Wire up the emitter: every change in PendingActionStore -> sendResourceUpdated,
  // if there is a subscriber for this URI.
  ctx.pendingStore.onChange(() => {
    if (!subscribers.has(PENDING_ACTIONS_URI)) return;
    server.server
      .sendResourceUpdated({ uri: PENDING_ACTIONS_URI })
      .catch((err: unknown) => {
        logger.debug({ err }, 'sendResourceUpdated failed');
      });
  });

  // ─────────── avito://swaggers/{file} ───────────
  // ResourceTemplate with a list callback — the client sees each swagger as a separate resource.
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
        'Raw swagger files from swaggers/. One resource per file. ' +
        'Use it to give an agent the full context of an endpoint without MCP tools.',
      mimeType: 'application/json',
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const slugRaw = Array.isArray(variables.slug) ? variables.slug[0] : variables.slug;
      const slug = decodeURIComponent(String(slugRaw ?? ''));
      // Path-traversal protection: disallow '..', '/' and null bytes.
      if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\0')) {
        throw new Error(`Invalid swagger slug: ${slug}`);
      }
      const filename = `${slug}.json`;
      const full = join(SWAGGERS_DIR, filename);
      // Verify the resolved path does not escape the directory.
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
