/**
 * v0.9.0: server-construction factory, extracted from src/server.ts so the same
 * fully-wired McpServer can back BOTH the stdio transport and every Streamable
 * HTTP session.
 *
 * Heavy/stateful singletons (AvitoClient, the pending/idempotency/webhook stores)
 * live in the shared `baseCtx` created once in server.ts. Each call here builds a
 * fresh McpServer and a per-call ctx that shares those singletons but carries its
 * own `server` reference — so an HTTP deployment can hold many concurrent sessions
 * without duplicating the Avito client or token cache.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Config } from './config.js';
import type { ToolContext } from './core/tool-factory.js';
import { domains } from './meta/domain-registry.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { PACKAGE_NAME, VERSION } from './version.js';
import { hasConfiguredCredentials } from './core/credentials.js';

/**
 * Builds a fully-registered McpServer (all domains, resources, prompts) wired to
 * the shared context. `baseCtx` provides the singletons; this returns a new
 * server each call with its own per-session ctx.
 */
export function buildMcpServer(baseCtx: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: PACKAGE_NAME,
      title: 'Avito MCP',
      version: VERSION,
      description:
        '148 tools for the Avito API: listings, messenger, orders, delivery, ' +
        'promotion, autoload, analytics, webhook events. With a safety policy (read_only / guarded / ' +
        'full_access), a confirmation flow for money/public operations, and hard-confirmation via ' +
        'AVITO_MCP_CONFIRMATION_SECRET.',
      websiteUrl: 'https://github.com/elchin92/avito-mcp',
    },
    {
      capabilities: {
        logging: {},
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: false },
        tools: { listChanged: false },
      },
      instructions:
        'Avito MCP — a server for the live (production) Avito API. Before any write/money/public ' +
        'operation, always confirm the action with a human; in confirmation_mode=money_public ' +
        '(default) the server returns a confirmation_id and requires a meta_confirm_action call. ' +
        'Full reference on the safety modes is in the avito://docs/safety resource. The list of tools ' +
        'with their risk classification is in avito://manifest. Pending actions are in ' +
        'avito://state/pending-actions (you can subscribe via resources/subscribe). Received Avito ' +
        'webhook events (if the receiver is enabled) are in avito://webhook/events (subscribable).',
    },
  );

  // Per-session ctx: shares the singletons in baseCtx, but binds this server so
  // resources/prompts/logging target the right session.
  const ctx: ToolContext = { ...baseCtx, server };

  for (const register of domains) {
    register(server, ctx);
  }
  registerResources(server, ctx);
  registerPrompts(server, ctx);

  return server;
}

/**
 * The rich local JSON snapshot returned by `--health`.
 * Pure (no I/O, no Avito call): safe for docker healthchecks and quick diagnostics.
 */
export function healthPayload(config: Config): Record<string, unknown> {
  return {
    ok: true,
    name: PACKAGE_NAME,
    version: VERSION,
    timestamp: new Date().toISOString(),
    safety: {
      mode: config.mode,
      confirmationMode: config.confirmationMode,
      hardConfirmation: !!config.confirmationSecret,
      dryRunDefault: config.dryRunDefault,
      exposeAuthTools: config.exposeAuthTools,
      allowToolsCount: config.allowTools.length,
      denyToolsCount: config.denyTools.length,
    },
    transport: config.http.transport,
    http: {
      enabled: config.http.transport === 'http' || config.http.transport === 'both',
      auth: config.http.auth,
      publicUrl: config.http.publicUrl,
    },
    webhook: {
      enabled: config.webhook.enabled,
      publicUrl: config.webhook.enabled ? config.webhook.publicUrl : null,
    },
    credentialsConfigured: hasConfiguredCredentials(config),
    baseUrl: config.baseUrl,
  };
}
