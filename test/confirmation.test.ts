/**
 * v0.4.0 confirmation flow:
 *   - money/public tools return a pending action instead of executing
 *   - meta_confirm_action executes the pending one-shot
 *   - double confirm fails
 *   - cancel removes the pending
 *   - expired confirm fails
 *   - policy is re-evaluated at confirm time
 *   - read/sensitive (when exposed) don't go through confirmation
 *   - all_destructive mode also catches write
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { AvitoClient } from '../src/core/client.js';
import { defineTool, type ToolContext } from '../src/core/tool-factory.js';
import { IdempotencyStore } from '../src/core/idempotency.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { register as registerMeta } from '../src/domains/meta.js';
import { register as registerMessenger } from '../src/domains/messenger.js';
import type { Config, ConfirmationMode } from '../src/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345,
    baseUrl: 'https://api.test.example',
    cpaSource: 'avito-mcp-test',
    tokenFile: join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
    logLevel: 'fatal',
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: false,
    allowedUploadDirs: [],
    maxUploadMb: 15,
    confirmationMode: 'money_public',
    confirmationTtlSec: 900,
    confirmationSecret: undefined,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    http: {
      transport: 'stdio',
      host: '127.0.0.1',
      port: 3000,
      publicUrl: 'http://127.0.0.1:3000',
      auth: 'oauth',
      authTokens: [],
      allowNoAuth: false,
      allowedHosts: [],
      allowedOrigins: [],
      maxSessions: 100,
      sessionIdleSec: 1800,
      oauthTokenTtlSec: 3600,
    },
    webhook: {
      enabled: false,
      publicUrl: 'http://127.0.0.1:3000',
      path: '/avito/webhook',
      bufferSize: 100,
    },
    ...overrides,
  };
}

async function makeRig(
  confirmationMode: ConfirmationMode,
  ttlSec = 900,
  extra: Partial<Config> = {},
  persistent?: { stateDir: string; namespace: string },
) {
  const cfg = makeConfig({ confirmationMode, confirmationTtlSec: ttlSec, ...extra });
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tk', expires_in: 3600, token_type: 'bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new AvitoClient(cfg, {
    retry: { retry429BaseMs: 1, max429Retries: 0, retry5xxBackoffMs: 1, max5xxRetries: 0 },
  });
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000, 1000, persistent);
  const idempotencyStore = new IdempotencyStore(cfg.idempotencyTtlSec * 1000, 10_000, persistent);
  const ctx: ToolContext = { client, config: cfg, pendingStore, idempotencyStore };

  const server = new McpServer({ name: 'test', version: '0.0.0' });
  // Register one tool per risk and the meta confirmation tools.
  defineTool(server, ctx, {
    name: 'read_tool',
    risk: 'read',
    description: 'reader',
    method: 'GET',
    path: '/anything',
  });
  defineTool(server, ctx, {
    name: 'write_tool',
    risk: 'write',
    description: 'writer',
    method: 'POST',
    path: '/anything',
    input: { x: z.number() },
    body: { contentType: 'application/json', fields: ['x'] },
  });
  defineTool(server, ctx, {
    name: 'money_tool',
    risk: 'money',
    description: 'spender',
    method: 'POST',
    path: '/anything',
    input: { item_id: z.number(), vas_id: z.string() },
    body: { contentType: 'application/json', fields: ['vas_id'] },
  });
  defineTool(server, ctx, {
    name: 'public_tool',
    risk: 'public',
    description: 'sender',
    method: 'POST',
    path: '/anything',
    input: { chat_id: z.string() },
    body: { contentType: 'application/json', fields: ['chat_id'] },
  });
  registerMeta(server, ctx);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client2 = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await client2.connect(b);
  return { server, client: client2, cfg, ctx, fetchMock, pendingStore };
}

async function makeUploadRig(confirmationMode: ConfirmationMode, extra: Partial<Config> = {}) {
  const uploadDir = await fs.mkdtemp(join(tmpdir(), 'avito-upload-confirm-'));
  const cfg = makeConfig({
    ...extra,
    confirmationMode,
    allowedUploadDirs: [uploadDir],
    tokenFile: join(tmpdir(), `avito-token-${randomBytes(6).toString('hex')}.json`),
  });
  const imagePath = join(uploadDir, 'one.png');
  await fs.writeFile(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    ),
  );

  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/token')) {
      return new Response(
        JSON.stringify({ access_token: 'tk', expires_in: 3600, token_type: 'bearer' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ uploaded: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const client = new AvitoClient(cfg, {
    retry: { retry429BaseMs: 1, max429Retries: 0, retry5xxBackoffMs: 1, max5xxRetries: 0 },
  });
  const pendingStore = new PendingActionStore(cfg.confirmationTtlSec * 1000);
  const idempotencyStore = new IdempotencyStore(cfg.idempotencyTtlSec * 1000);
  const ctx: ToolContext = { client, config: cfg, pendingStore, idempotencyStore };
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerMessenger(server, ctx);
  registerMeta(server, ctx);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client2 = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  await client2.connect(b);
  return { server, client: client2, cfg, ctx, fetchMock, pendingStore, uploadDir, imagePath };
}

function parseText(content: unknown): string {
  return (content as Array<{ type: string; text: string }>)[0]!.text;
}

function extractConfirmationId(text: string): string {
  const parsed = JSON.parse(text) as { confirmation_id?: string };
  if (!parsed.confirmation_id) throw new Error('no confirmation_id in pending payload');
  return parsed.confirmation_id;
}

describe('confirmation flow', () => {
  let cfg: Config;
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (cfg) await fs.rm(cfg.tokenFile, { force: true });
  });

  it('money tool returns requires_confirmation in money_public mode (Avito not called)', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const r = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'highlight' },
    });
    expect(r.isError).not.toBe(true);
    const payload = JSON.parse(parseText(r.content));
    expect(payload.requires_confirmation).toBe(true);
    expect(payload.tool).toBe('money_tool');
    expect(payload.risk).toBe('money');
    expect(rig.fetchMock).not.toHaveBeenCalled();
    expect(rig.pendingStore.size()).toBe(1);
    await rig.client.close();
  });

  it('coalesces concurrent pending creation for duplicate idempotency keys', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const args = { item_id: 1, vas_id: 'highlight', idempotencyKey: 'same-confirm-key' };
    const [first, second] = await Promise.all([
      rig.client.callTool({ name: 'money_tool', arguments: args }),
      rig.client.callTool({ name: 'money_tool', arguments: args }),
    ]);
    const firstId = extractConfirmationId(parseText(first.content));
    const secondId = extractConfirmationId(parseText(second.content));

    expect(secondId).toBe(firstId);
    expect(rig.pendingStore.size()).toBe(1);
    expect(rig.fetchMock).not.toHaveBeenCalled();

    const confirmed = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: firstId },
    });
    expect(confirmed.isError).not.toBe(true);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(rig.pendingStore.size()).toBe(0);
    await rig.client.close();
  });

  it('keeps an idempotency key reserved while its confirmed action is executing', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const rig = await makeRig('money_public', 900, { idempotencyTtlSec: 1 });
    cfg = rig.cfg;
    const args = { item_id: 1, vas_id: 'highlight', idempotencyKey: 'inflight-confirm-key' };
    const first = await rig.client.callTool({ name: 'money_tool', arguments: args });
    const confirmationId = extractConfirmationId(parseText(first.content));

    // The ledger TTL is intentionally shorter than the pending TTL. Expiry must
    // not reopen the slot while the confirmation is still waiting for approval.
    now += 2_000;
    const expiredButPending = await rig.client.callTool({ name: 'money_tool', arguments: args });
    expect(extractConfirmationId(parseText(expiredButPending.content))).toBe(confirmationId);

    let releaseOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let markOperationStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      markOperationStarted = resolve;
    });
    let operationCalls = 0;
    rig.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/token')) {
        return new Response(
          JSON.stringify({ access_token: 'tk', expires_in: 3600, token_type: 'bearer' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      operationCalls += 1;
      markOperationStarted();
      await operationGate;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const confirmation = rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: confirmationId },
    });
    await operationStarted;

    // take() has removed the action from the confirmable list, but its lifecycle
    // remains active until execution + the final idempotency remember complete.
    expect(rig.pendingStore.size()).toBe(0);
    expect(rig.pendingStore.isActive(confirmationId)).toBe(true);
    const duringExecution = await rig.client.callTool({ name: 'money_tool', arguments: args });
    expect(extractConfirmationId(parseText(duringExecution.content))).toBe(confirmationId);
    expect(duringExecution.structuredContent).toMatchObject({ idempotent_replay: true });
    expect(operationCalls).toBe(1);

    releaseOperation();
    const confirmed = await confirmation;
    expect(confirmed.isError).not.toBe(true);
    expect(rig.pendingStore.isActive(confirmationId)).toBe(false);

    const completedReplay = await rig.client.callTool({ name: 'money_tool', arguments: args });
    expect(parseText(completedReplay.content)).not.toContain('requires_confirmation');
    expect(completedReplay.structuredContent).toMatchObject({
      ok: true,
      idempotent_replay: true,
    });
    expect(operationCalls).toBe(1);

    now += 2_000;
    const afterFinalTtl = await rig.client.callTool({ name: 'money_tool', arguments: args });
    expect(extractConfirmationId(parseText(afterFinalTtl.content))).not.toBe(confirmationId);
    expect(afterFinalTtl.structuredContent).not.toMatchObject({ idempotent_replay: true });
    expect(operationCalls).toBe(1);
    await rig.client.close();
  });

  it('a cancelled pending does not wedge the idempotency key — retry creates a fresh, confirmable pending', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const args = { item_id: 1, vas_id: 'highlight', idempotencyKey: 'wedge-key' };

    const first = await rig.client.callTool({ name: 'money_tool', arguments: args });
    const firstId = extractConfirmationId(parseText(first.content));
    expect(rig.pendingStore.size()).toBe(1);

    // Discard the pending action. The idempotency entry must NOT keep replaying the
    // now-dead confirmation_id (the v1.0.3 stale-replay wedge).
    await rig.client.callTool({
      name: 'meta_cancel_action',
      arguments: { confirmation_id: firstId },
    });
    expect(rig.pendingStore.size()).toBe(0);

    // Retry with the SAME key → a FRESH pending, not a stale replay of the dead id.
    const retry = await rig.client.callTool({ name: 'money_tool', arguments: args });
    const retryId = extractConfirmationId(parseText(retry.content));
    expect(retryId).not.toBe(firstId);
    expect(rig.pendingStore.size()).toBe(1);

    // The fresh pending confirms and executes end-to-end.
    const confirmed = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: retryId },
    });
    expect(confirmed.isError).not.toBe(true);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(rig.pendingStore.size()).toBe(0);
    await rig.client.close();
  });

  it('does not replay durable confirmation ids after cancellation or lockout', async () => {
    const stateDir = await fs.mkdtemp(join(tmpdir(), 'avito-confirm-replay-'));
    const persistent = { stateDir, namespace: 'account-a' };
    const secret = 'persistent-lockout-secret-1234567890';
    const argsAfterCancel = {
      item_id: 1,
      vas_id: 'cancelled',
      idempotencyKey: 'persistent-cancel-key',
    };
    const argsAfterLockout = {
      item_id: 2,
      vas_id: 'locked',
      idempotencyKey: 'persistent-lockout-key',
    };
    let firstRig: Awaited<ReturnType<typeof makeRig>> | undefined;
    let restartedRig: Awaited<ReturnType<typeof makeRig>> | undefined;
    const tokenFiles: string[] = [];
    try {
      firstRig = await makeRig('money_public', 900, { confirmationSecret: secret }, persistent);
      cfg = firstRig.cfg;
      tokenFiles.push(firstRig.cfg.tokenFile);
      const cancelledPending = await firstRig.client.callTool({
        name: 'money_tool',
        arguments: argsAfterCancel,
      });
      const cancelledId = extractConfirmationId(parseText(cancelledPending.content));
      await firstRig.client.callTool({
        name: 'meta_cancel_action',
        arguments: { confirmation_id: cancelledId },
      });

      const lockedPending = await firstRig.client.callTool({
        name: 'money_tool',
        arguments: argsAfterLockout,
      });
      const lockedId = extractConfirmationId(parseText(lockedPending.content));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await firstRig.client.callTool({
          name: 'meta_confirm_action',
          arguments: {
            confirmation_id: lockedId,
            confirmation_secret: `wrong-${attempt}`,
          },
        });
      }
      await firstRig.client.close();

      restartedRig = await makeRig('money_public', 900, { confirmationSecret: secret }, persistent);
      cfg = restartedRig.cfg;
      tokenFiles.push(restartedRig.cfg.tokenFile);
      const retriedCancelled = await restartedRig.client.callTool({
        name: 'money_tool',
        arguments: argsAfterCancel,
      });
      const retriedLocked = await restartedRig.client.callTool({
        name: 'money_tool',
        arguments: argsAfterLockout,
      });

      expect(extractConfirmationId(parseText(retriedCancelled.content))).not.toBe(cancelledId);
      expect(extractConfirmationId(parseText(retriedLocked.content))).not.toBe(lockedId);
      expect(retriedCancelled.structuredContent).not.toMatchObject({ idempotent_replay: true });
      expect(retriedLocked.structuredContent).not.toMatchObject({ idempotent_replay: true });
    } finally {
      await firstRig?.client.close().catch(() => undefined);
      await restartedRig?.client.close().catch(() => undefined);
      await Promise.all(tokenFiles.map((file) => fs.rm(file, { force: true })));
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('retains an active persistent approval after the idempotency TTL expires', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const stateDir = await fs.mkdtemp(join(tmpdir(), 'avito-confirm-ledger-ttl-'));
    const persistent = { stateDir, namespace: 'account-a' };
    const args = {
      item_id: 4,
      vas_id: 'pending',
      idempotencyKey: 'persistent-expired-ledger-key',
    };
    let firstRig: Awaited<ReturnType<typeof makeRig>> | undefined;
    let restartedRig: Awaited<ReturnType<typeof makeRig>> | undefined;
    const tokenFiles: string[] = [];
    try {
      firstRig = await makeRig('money_public', 900, { idempotencyTtlSec: 0.001 }, persistent);
      cfg = firstRig.cfg;
      tokenFiles.push(firstRig.cfg.tokenFile);
      const first = await firstRig.client.callTool({ name: 'money_tool', arguments: args });
      const confirmationId = extractConfirmationId(parseText(first.content));
      await firstRig.client.close();

      now += 2_000;
      restartedRig = await makeRig('money_public', 900, { idempotencyTtlSec: 0.001 }, persistent);
      cfg = restartedRig.cfg;
      tokenFiles.push(restartedRig.cfg.tokenFile);
      const retry = await restartedRig.client.callTool({ name: 'money_tool', arguments: args });

      expect(extractConfirmationId(parseText(retry.content))).toBe(confirmationId);
      expect(retry.structuredContent).toMatchObject({ idempotent_replay: true });
      expect(await restartedRig.pendingStore.listPersistent()).toHaveLength(1);
    } finally {
      await firstRig?.client.close().catch(() => undefined);
      await restartedRig?.client.close().catch(() => undefined);
      await Promise.all(tokenFiles.map((file) => fs.rm(file, { force: true })));
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('does not reopen an idempotency slot while another process executes its claim', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const stateDir = await fs.mkdtemp(join(tmpdir(), 'avito-confirm-inflight-'));
    const persistent = { stateDir, namespace: 'account-a' };
    const secret = 'persistent-inflight-secret-123456789';
    const args = {
      item_id: 3,
      vas_id: 'inflight',
      idempotencyKey: 'persistent-inflight-key',
    };
    let firstRig: Awaited<ReturnType<typeof makeRig>> | undefined;
    let restartedRig: Awaited<ReturnType<typeof makeRig>> | undefined;
    let releaseOperation: (() => void) | undefined;
    let confirmation: Promise<unknown> | undefined;
    const tokenFiles: string[] = [];
    try {
      firstRig = await makeRig(
        'money_public',
        1,
        { confirmationSecret: secret, idempotencyTtlSec: 0.001 },
        persistent,
      );
      cfg = firstRig.cfg;
      tokenFiles.push(firstRig.cfg.tokenFile);
      const pending = await firstRig.client.callTool({ name: 'money_tool', arguments: args });
      const confirmationId = extractConfirmationId(parseText(pending.content));

      const operationGate = new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });
      let markOperationStarted!: () => void;
      const operationStarted = new Promise<void>((resolve) => {
        markOperationStarted = resolve;
      });
      firstRig.fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/token')) {
          return new Response(
            JSON.stringify({ access_token: 'tk', expires_in: 3600, token_type: 'bearer' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        markOperationStarted();
        await operationGate;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      confirmation = firstRig.client.callTool({
        name: 'meta_confirm_action',
        arguments: { confirmation_id: confirmationId, confirmation_secret: secret },
      });
      await operationStarted;
      now += 2_000;

      restartedRig = await makeRig(
        'money_public',
        1,
        { confirmationSecret: secret, idempotencyTtlSec: 0.001 },
        persistent,
      );
      cfg = restartedRig.cfg;
      tokenFiles.push(restartedRig.cfg.tokenFile);
      const retry = await restartedRig.client.callTool({ name: 'money_tool', arguments: args });

      expect(extractConfirmationId(parseText(retry.content))).toBe(confirmationId);
      expect(retry.structuredContent).toMatchObject({ idempotent_replay: true });
      expect(await restartedRig.pendingStore.listPersistent()).toEqual([]);
      expect(restartedRig.fetchMock).not.toHaveBeenCalled();

      releaseOperation?.();
      releaseOperation = undefined;
      await confirmation;
      confirmation = undefined;

      const completed = await restartedRig.client.callTool({ name: 'money_tool', arguments: args });
      expect(parseText(completed.content)).not.toContain('requires_confirmation');
      expect(completed.structuredContent).toMatchObject({ ok: true, idempotent_replay: true });
    } finally {
      releaseOperation?.();
      await confirmation?.catch(() => undefined);
      await firstRig?.client.close().catch(() => undefined);
      await restartedRig?.client.close().catch(() => undefined);
      await Promise.all(tokenFiles.map((file) => fs.rm(file, { force: true })));
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('write tool does NOT require confirmation in money_public mode', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const r = await rig.client.callTool({ name: 'write_tool', arguments: { x: 1 } });
    expect(r.isError).not.toBe(true);
    // write_tool should execute (fetch called for token + actual call)
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(rig.pendingStore.size()).toBe(0);
    await rig.client.close();
  });

  it('write tool DOES require confirmation in all_destructive mode', async () => {
    const rig = await makeRig('all_destructive');
    cfg = rig.cfg;
    const r = await rig.client.callTool({ name: 'write_tool', arguments: { x: 1 } });
    expect(JSON.parse(parseText(r.content)).requires_confirmation).toBe(true);
    expect(rig.fetchMock).not.toHaveBeenCalled();
    await rig.client.close();
  });

  it('custom messenger_upload_images requires confirmation in all_destructive mode', async () => {
    const rig = await makeUploadRig('all_destructive');
    cfg = rig.cfg;

    const first = await rig.client.callTool({
      name: 'messenger_upload_images',
      arguments: { paths: [rig.imagePath] },
    });

    const payload = JSON.parse(parseText(first.content));
    expect(payload.requires_confirmation).toBe(true);
    expect(payload.tool).toBe('messenger_upload_images');
    expect(payload.risk).toBe('write');
    expect(rig.fetchMock).not.toHaveBeenCalled();
    expect(rig.pendingStore.size()).toBe(1);

    const confirmed = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: payload.confirmation_id },
    });
    expect(confirmed.isError).not.toBe(true);
    expect(parseText(confirmed.content)).toMatch(/status=200/);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(0);

    await rig.client.close();
    await fs.rm(rig.uploadDir, { recursive: true, force: true });
  });

  it('custom upload uses the common dry-run and idempotency pipeline', async () => {
    const rig = await makeUploadRig('off');
    cfg = rig.cfg;
    const preview = await rig.client.callTool({
      name: 'messenger_upload_images',
      arguments: { paths: [rig.imagePath], dryRun: true },
    });
    expect(preview.isError).not.toBe(true);
    expect(JSON.stringify(preview)).not.toContain(rig.uploadDir);
    expect(preview.structuredContent).toMatchObject({
      dryRun: true,
      request_preview: { body: { file_count: 1, filenames: ['one.png'] } },
    });
    expect(rig.fetchMock).not.toHaveBeenCalled();

    const args = {
      paths: [rig.imagePath],
      idempotencyKey: 'upload-idempotency-key',
    };
    const first = await rig.client.callTool({ name: 'messenger_upload_images', arguments: args });
    const calls = rig.fetchMock.mock.calls.length;
    const second = await rig.client.callTool({ name: 'messenger_upload_images', arguments: args });
    expect(first.isError).not.toBe(true);
    expect(second.structuredContent).toMatchObject({ idempotent_replay: true });
    expect(rig.fetchMock).toHaveBeenCalledTimes(calls);
    await rig.client.close();
    await fs.rm(rig.uploadDir, { recursive: true, force: true });
  });

  it('rejects duplicate files and aggregate batches over maxUploadMb before HTTP', async () => {
    const rig = await makeUploadRig('off', { maxUploadMb: 1 });
    cfg = rig.cfg;
    const duplicate = await rig.client.callTool({
      name: 'messenger_upload_images',
      arguments: { paths: [rig.imagePath, rig.imagePath] },
    });
    expect(duplicate.isError).toBe(true);
    expect(JSON.stringify(duplicate)).toContain('duplicate_file');

    const largeA = join(rig.uploadDir, 'large-a.png');
    const largeB = join(rig.uploadDir, 'large-b.png');
    const pngPrefix = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const payload = Buffer.concat([pngPrefix, Buffer.alloc(600 * 1024)]);
    await fs.writeFile(largeA, payload);
    await fs.writeFile(largeB, payload);
    const aggregate = await rig.client.callTool({
      name: 'messenger_upload_images',
      arguments: { paths: [largeA, largeB] },
    });
    expect(aggregate.isError).toBe(true);
    expect(JSON.stringify(aggregate)).toContain('batch_too_large');
    expect(rig.fetchMock).not.toHaveBeenCalled();
    await rig.client.close();
    await fs.rm(rig.uploadDir, { recursive: true, force: true });
  });

  it('confirmation_mode=off skips the gate entirely', async () => {
    const rig = await makeRig('off');
    cfg = rig.cfg;
    const r = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'highlight' },
    });
    // confirmation off → tool executes; response is "status=200\n..." not the pending JSON shape
    expect(parseText(r.content)).not.toContain('requires_confirmation');
    expect(parseText(r.content)).toMatch(/status=200/);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(0);
    await rig.client.close();
  });

  it('meta_confirm_action executes the pending then removes it (one-shot)', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'highlight' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const fetchCallsBefore = rig.fetchMock.mock.calls.length;

    const confirmed = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id },
    });
    expect(confirmed.isError).not.toBe(true);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(fetchCallsBefore);
    expect(rig.pendingStore.size()).toBe(0);

    const again = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id },
    });
    expect(again.isError).toBe(true);
    expect(parseText(again.content)).toMatch(/not found/);
    await rig.client.close();
  });

  it('meta_cancel_action removes the pending (no execution, no double-cancel error)', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'public_tool',
      arguments: { chat_id: 'c1' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const fetchCallsBefore = rig.fetchMock.mock.calls.length;

    const cancelled = await rig.client.callTool({
      name: 'meta_cancel_action',
      arguments: { confirmation_id: id },
    });
    expect(cancelled.isError).not.toBe(true);
    expect(parseText(cancelled.content)).toMatch(/cancelled/);
    expect(rig.fetchMock.mock.calls.length).toBe(fetchCallsBefore);

    // Re-cancel returns informational, not isError
    const again = await rig.client.callTool({
      name: 'meta_cancel_action',
      arguments: { confirmation_id: id },
    });
    expect(again.isError).not.toBe(true);
    await rig.client.close();
  });

  it('expired pending: confirm fails after TTL', async () => {
    const rig = await makeRig('money_public', 1); // 1 second TTL
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    // Manually expire by reaching into the store (faster than real wait)
    const action = (
      rig.pendingStore as unknown as {
        actions: Map<string, { expiresAt: number }>;
      }
    ).actions.get(id)!;
    action.expiresAt = Date.now() - 1;
    const r = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id },
    });
    expect(r.isError).toBe(true);
    expect(parseText(r.content)).toMatch(/not found|expired/);
    await rig.client.close();
  });

  it('meta_list_pending_actions shows summary, no args, no execute', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 999, vas_id: 'premium' },
    });
    const list = await rig.client.callTool({
      name: 'meta_list_pending_actions',
      arguments: {},
    });
    const text = parseText(list.content);
    expect(text).toContain('money_tool');
    expect(text).toContain('item_id=999');
    expect(text).toContain('vas_id=premium');
    // Should NOT dump the raw args record
    expect(text).not.toContain('"args"');
    await rig.client.close();
  });

  it('confirmation tools are NOT registered when confirmation_mode=off', async () => {
    const rig = await makeRig('off');
    cfg = rig.cfg;
    const { tools } = await rig.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('meta_confirm_action');
    expect(names).not.toContain('meta_cancel_action');
    expect(names).not.toContain('meta_list_pending_actions');
    await rig.client.close();
  });

  it('confirmation tools ARE registered when confirmation_mode != off', async () => {
    const rig = await makeRig('money_public');
    cfg = rig.cfg;
    const { tools } = await rig.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('meta_confirm_action');
    expect(names).toContain('meta_cancel_action');
    expect(names).toContain('meta_list_pending_actions');
    await rig.client.close();
  });
});

describe('hard-confirmation (AVITO_MCP_CONFIRMATION_SECRET)', () => {
  let cfg: Config;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (cfg) await fs.rm(cfg.tokenFile, { force: true });
  });

  it('confirm without secret is rejected and pending NOT deleted', async () => {
    const rig = await makeRig('money_public', 900, {
      confirmationSecret: 'topsecret123456789012345678901234',
    });
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'highlight' },
    });
    const id = extractConfirmationId(parseText(first.content));
    expect(rig.pendingStore.size()).toBe(1);

    const noSecret = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id },
    });
    expect(noSecret.isError).toBe(true);
    expect(parseText(noSecret.content)).toMatch(/Bad or missing confirmation_secret/);
    // Pending action should still exist — bad secret doesn't burn it (allows retry).
    expect(rig.pendingStore.size()).toBe(1);
    await rig.client.close();
  });

  it('confirm with wrong secret is rejected, pending NOT deleted', async () => {
    const rig = await makeRig('money_public', 900, {
      confirmationSecret: 'real-secret-123456789012345678901',
    });
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const r = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'wrong-guess' },
    });
    expect(r.isError).toBe(true);
    expect(rig.pendingStore.size()).toBe(1);
    await rig.client.close();
  });

  it('confirm with correct secret executes and burns pending', async () => {
    const rig = await makeRig('money_public', 900, {
      confirmationSecret: 'a-strong-secret-123456789012345678',
    });
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const fetchBefore = rig.fetchMock.mock.calls.length;
    const r = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'a-strong-secret-123456789012345678' },
    });
    expect(r.isError).not.toBe(true);
    expect(rig.fetchMock.mock.calls.length).toBeGreaterThan(fetchBefore);
    expect(rig.pendingStore.size()).toBe(0);
    await rig.client.close();
  });

  it('checks pending id before secret to avoid a global secret oracle', async () => {
    const rig = await makeRig('money_public', 900, {
      confirmationSecret: 'oracle-secret-123456789012345678',
    });
    cfg = rig.cfg;
    const wrong = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: '0000000000000000', confirmation_secret: 'wrong-guess' },
    });
    const correct = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: {
        confirmation_id: '0000000000000000',
        confirmation_secret: 'oracle-secret-123456789012345678',
      },
    });
    expect(wrong.isError).toBe(true);
    expect(correct.isError).toBe(true);
    expect(parseText(wrong.content)).toEqual(parseText(correct.content));
    expect(parseText(wrong.content)).toMatch(/not found/);
    await rig.client.close();
  });

  it('deletes a pending action after too many bad secret attempts', async () => {
    const rig = await makeRig('money_public', 900, {
      confirmationSecret: 'lockout-secret-12345678901234567',
    });
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    for (let i = 0; i < 4; i++) {
      const r = await rig.client.callTool({
        name: 'meta_confirm_action',
        arguments: { confirmation_id: id, confirmation_secret: `wrong-${i}` },
      });
      expect(r.isError).toBe(true);
      expect(rig.pendingStore.size()).toBe(1);
    }
    const locked = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'wrong-4' },
    });
    expect(locked.isError).toBe(true);
    expect(parseText(locked.content)).toMatch(/Too many/);
    expect(rig.pendingStore.size()).toBe(0);
    await rig.client.close();
  });

  it('shares the hard-confirmation lockout across MCP server sessions', async () => {
    const rig = await makeRig('money_public', 900, {
      confirmationSecret: 'shared-lockout-secret-1234567890123',
    });
    cfg = rig.cfg;

    const secondServer = new McpServer({ name: 'second-session', version: '0.0.0' });
    registerMeta(secondServer, rig.ctx);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await secondServer.connect(serverTransport);
    const secondClient = new Client(
      { name: 'second-session-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await secondClient.connect(clientTransport);

    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const clients = [rig.client, secondClient, rig.client, secondClient];
    for (const [index, sessionClient] of clients.entries()) {
      const rejected = await sessionClient.callTool({
        name: 'meta_confirm_action',
        arguments: { confirmation_id: id, confirmation_secret: `wrong-${index}` },
      });
      expect(rejected.isError).toBe(true);
      expect(rig.pendingStore.size()).toBe(1);
    }
    const locked = await secondClient.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'wrong-final' },
    });
    expect(locked.isError).toBe(true);
    expect(parseText(locked.content)).toMatch(/Too many/);
    expect(rig.pendingStore.size()).toBe(0);

    await secondClient.close();
    await secondServer.close();
    await rig.client.close();
  });

  it('shares hard-confirmation lockout attempts across MCP sessions', async () => {
    const rig = await makeRig('money_public', 900, {
      confirmationSecret: 'cross-session-secret-1234567890123',
    });
    cfg = rig.cfg;

    const secondServer = new McpServer({ name: 'test-second', version: '0.0.0' });
    registerMeta(secondServer, rig.ctx);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await secondServer.connect(serverTransport);
    const secondClient = new Client(
      { name: 'test-second', version: '0.0.0' },
      { capabilities: {} },
    );
    await secondClient.connect(clientTransport);

    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    for (let i = 0; i < 3; i++) {
      await rig.client.callTool({
        name: 'meta_confirm_action',
        arguments: { confirmation_id: id, confirmation_secret: `first-${i}` },
      });
    }
    expect(rig.pendingStore.size()).toBe(1);
    await secondClient.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'second-0' },
    });
    const locked = await secondClient.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'second-1' },
    });
    expect(locked.isError).toBe(true);
    expect(parseText(locked.content)).toMatch(/Too many/);
    expect(rig.pendingStore.size()).toBe(0);

    await secondClient.close();
    await secondServer.close();
    await rig.client.close();
  });

  it('atomically executes a confirmation only once across concurrent sessions', async () => {
    const secret = 'concurrent-secret-1234567890123456';
    const rig = await makeRig('money_public', 900, { confirmationSecret: secret });
    cfg = rig.cfg;

    const secondServer = new McpServer({ name: 'test-concurrent', version: '0.0.0' });
    registerMeta(secondServer, rig.ctx);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await secondServer.connect(serverTransport);
    const secondClient = new Client(
      { name: 'test-concurrent', version: '0.0.0' },
      { capabilities: {} },
    );
    await secondClient.connect(clientTransport);

    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    const results = await Promise.all([
      rig.client.callTool({
        name: 'meta_confirm_action',
        arguments: { confirmation_id: id, confirmation_secret: secret },
      }),
      secondClient.callTool({
        name: 'meta_confirm_action',
        arguments: { confirmation_id: id, confirmation_secret: secret },
      }),
    ]);

    expect(results.filter((result) => result.isError !== true)).toHaveLength(1);
    expect(results.filter((result) => result.isError === true)).toHaveLength(1);
    expect(rig.pendingStore.size()).toBe(0);

    await secondClient.close();
    await secondServer.close();
    await rig.client.close();
  });

  it('rejects length-mismatch without timing leak (different-length secret)', async () => {
    const rig = await makeRig('money_public', 900, {
      confirmationSecret: 'same-length-secret-123456789012345',
    });
    cfg = rig.cfg;
    const first = await rig.client.callTool({
      name: 'money_tool',
      arguments: { item_id: 1, vas_id: 'x' },
    });
    const id = extractConfirmationId(parseText(first.content));
    // Same length, different content
    const sameLen = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'WRONG-length-secret-1234567890123' },
    });
    expect(sameLen.isError).toBe(true);
    // Different length
    const diffLen = await rig.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: id, confirmation_secret: 'short' },
    });
    expect(diffLen.isError).toBe(true);
    await rig.client.close();
  });
});

describe('v0.5.1: meta_* tools go through allow/deny policy', () => {
  let cfg: Config;
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (cfg) await fs.rm(cfg.tokenFile, { force: true });
  });

  it('allowlist that excludes meta_confirm_action hides it', async () => {
    const rig = await makeRig('money_public', 900, { allowTools: ['money_tool'] });
    cfg = rig.cfg;
    const names = (await rig.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('money_tool');
    expect(names).not.toContain('meta_confirm_action');
    expect(names).not.toContain('meta_cancel_action');
    expect(names).not.toContain('meta_list_pending_actions');
    await rig.client.close();
  });

  it('denylist that includes meta_confirm_action hides it (deny wins)', async () => {
    const rig = await makeRig('money_public', 900, { denyTools: ['meta_confirm_action'] });
    cfg = rig.cfg;
    const names = (await rig.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('meta_confirm_action');
    // Cancel and list still visible — they weren't denied.
    expect(names).toContain('meta_cancel_action');
    expect(names).toContain('meta_list_pending_actions');
    await rig.client.close();
  });

  it('denylist on all three confirmation tools hides them all', async () => {
    const rig = await makeRig('money_public', 900, {
      denyTools: ['meta_confirm_action', 'meta_cancel_action', 'meta_list_pending_actions'],
    });
    cfg = rig.cfg;
    const names = (await rig.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('meta_confirm_action');
    expect(names).not.toContain('meta_cancel_action');
    expect(names).not.toContain('meta_list_pending_actions');
    await rig.client.close();
  });

  it('read_only mode hides write meta tools (confirm + cancel) but keeps read meta_list', async () => {
    // money_public confirmation is the ONLY reason confirm tools are even potentially registered;
    // read_only mode then filters out write-class ones. list_pending is risk=read so survives.
    const rig = await makeRig('money_public', 900, { mode: 'read_only' });
    cfg = rig.cfg;
    const names = (await rig.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('meta_confirm_action');
    expect(names).not.toContain('meta_cancel_action');
    expect(names).toContain('meta_list_pending_actions');
    await rig.client.close();
  });
});
