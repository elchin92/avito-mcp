import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, type CallToolResult } from '@modelcontextprotocol/server';

import { AvitoClient, type RequestOptions } from '../src/core/client.js';
import { AvitoTransportError } from '../src/core/errors.js';
import { IdempotencyStore, fingerprintIdempotencyKey, hashArgs } from '../src/core/idempotency.js';
import { safeStatePart } from '../src/core/runtime-state.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import { defineTool, type ToolContext } from '../src/core/tool-factory.js';
import { register as registerMeta } from '../src/domains/meta.js';
import { register as registerPromotion } from '../src/domains/promotion.js';
import { startFakeAvito } from './support/fake-avito.js';
import { makeConfig } from './support/config-fixture.js';
import { createSandbox, removeSandbox } from './support/sandbox.js';

const TOOL = 'mutation_probe';
const PATH = '/core/v1/accounts/12345/items/42/vas';
const KEY = 'transport-outcome-test-key';
const NAMESPACE = 'transport-outcome';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function rig(
  options: {
    durable?: boolean;
    confirmation?: boolean;
    custom?: boolean;
    warmToken?: boolean;
    requestTimeoutMs?: number;
  } = {},
) {
  const directory = await createSandbox('mutation-transport');
  cleanups.push(() => removeSandbox(directory));
  const upstream = await startFakeAvito();
  cleanups.push(() => upstream.close());
  const config = makeConfig({
    baseUrl: upstream.baseUrl,
    tokenFile: join(directory, 'token.json'),
    runtimeStateDir: directory,
    confirmationMode: options.confirmation ? 'money_public' : 'off',
  });
  const storeOptions = options.durable ? { stateDir: directory, namespace: NAMESPACE } : {};
  const store = new IdempotencyStore(3_600_000, 100, storeOptions);
  const pendingStore = new PendingActionStore(
    900_000,
    100,
    options.durable ? (storeOptions as { stateDir: string; namespace: string }) : undefined,
  );
  const avito = new AvitoClient(config, { retry: { max429Retries: 0, max5xxRetries: 0 } });
  // Finish token acquisition and its durable write before starting the measured
  // mutation. Otherwise coverage/parallel filesystem load can exhaust a short
  // deadline before dispatch, exercising a different outcome than this suite intends.
  // The explicit pre-dispatch failure cases opt out of warmup.
  if (options.warmToken !== false) await avito.tokenStore.getToken();
  // Keep real loopback HTTP and the real internal deadline. Only the intentional
  // hung-response cases shorten it; disconnect and setup cases get a generous budget.
  const request = avito.request.bind(avito);
  vi.spyOn(avito, 'request').mockImplementation(<T>(opts: RequestOptions) =>
    request<T>({ ...opts, timeoutMs: options.requestTimeoutMs ?? 10_000 }),
  );
  const ctx: ToolContext = { config, client: avito, pendingStore, idempotencyStore: store };
  const server = new McpServer({ name: 'mutation-outcome-test', version: '1' });
  defineTool(server, ctx, {
    name: TOOL,
    description: 'Loopback mutation',
    risk: 'money',
    method: 'PUT',
    path: PATH,
    ...(options.custom
      ? {
          customExecute: (_args, toolCtx, execution) =>
            toolCtx.client.request({ ...execution, method: 'PUT', path: PATH }),
        }
      : {}),
  });
  defineTool(server, ctx, {
    name: 'read_probe',
    description: 'Read probe',
    risk: 'read',
    method: 'GET',
    path: '/read',
  });
  registerMeta(server, ctx);
  registerPromotion(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await client.connect(b);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = (key: string | null = KEY) =>
    client.callTool({
      name: TOOL,
      arguments: key ? { idempotencyKey: key } : {},
    }) as Promise<CallToolResult>;
  const record = async () =>
    JSON.parse(
      await fs.readFile(
        join(
          directory,
          NAMESPACE,
          'idempotency',
          safeStatePart(TOOL),
          `${fingerprintIdempotencyKey(KEY)}.json`,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
  return { upstream, avito, ctx, store, directory, client, call, record, storeOptions };
}

function error(result: CallToolResult): Record<string, unknown> {
  return structured(result).error as Record<string, unknown>;
}

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

describe('mutations with an unknown transport outcome', () => {
  for (const durable of [false, true]) {
    for (const mode of ['hang', 'disconnect'] as const) {
      it(`${mode}: holds the ${durable ? 'durable' : 'memory'} key instead of replaying a retryable error`, async () => {
        const r = await rig({ durable, requestTimeoutMs: mode === 'hang' ? 5_000 : 10_000 });
        r.upstream.setMode(mode);
        expect(error(await r.call())).toMatchObject({ type: 'OUTCOME_UNKNOWN', retryable: false });
        r.upstream.setMode('ok');
        const second = await r.call();
        expect(error(second)).toMatchObject({
          code: 'IDEMPOTENCY_HELD/transport_failure_after_dispatch',
          retryable: false,
        });
        expect(structured(second).idempotent_replay).toBeUndefined();
        expect(r.store.list()).toHaveLength(0);
        expect(r.upstream.mutations).toHaveLength(1);
        // Time alone is not evidence that Avito did not apply a mutation.
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7_200_000);
        expect(error(await r.call())).toMatchObject({ type: 'IDEMPOTENCY_HELD' });
        vi.restoreAllMocks();
        if (durable) {
          expect(await r.record()).toMatchObject({
            state: 'indeterminate',
            holdReason: 'transport_failure_after_dispatch',
          });
          expect((await r.record()).result).toBeUndefined();
          const other = new IdempotencyStore(3_600_000, 100, r.storeOptions);
          const run = vi.fn();
          await expect(other.runExclusive(KEY, TOOL, hashArgs({}), run)).rejects.toMatchObject({
            reason: 'transport_failure_after_dispatch',
          });
          expect(run).not.toHaveBeenCalled();
        }
        expect(await r.store.releaseHold(KEY, TOOL)).toBe(true);
        // Operator release is explicit; no automatic second request occurred.
        expect(r.upstream.mutations).toHaveLength(1);
      }, 20_000);
    }
  }

  it('returns a non-retryable outcome without a key', async () => {
    const r = await rig();
    r.upstream.setMode('disconnect');
    expect(error(await r.call(null))).toMatchObject({ type: 'OUTCOME_UNKNOWN', retryable: false });
    expect(r.store.size()).toBe(0);
    expect(r.upstream.mutations).toHaveLength(1);
  });

  it('releases a key when token acquisition fails before the mutation is sent', async () => {
    const r = await rig({ durable: true, warmToken: false });
    r.upstream.setTokenMode('disconnect');
    expect(error(await r.call())).toMatchObject({ type: 'NETWORK_ERROR', retryable: true });
    expect(r.upstream.mutations).toHaveLength(0);
    await expect(r.record()).rejects.toMatchObject({ code: 'ENOENT' });
    r.upstream.setTokenMode('ok');
    expect((await r.call()).isError).toBeFalsy();
    expect(r.upstream.mutations).toHaveLength(1);
  });

  it('does not confuse a known 401 plus failed refresh with an unknown mutation', async () => {
    const r = await rig();
    await r.avito.tokenStore.getToken();
    r.upstream.setMode('401');
    r.upstream.setTokenMode('disconnect');
    expect(error(await r.call())).toMatchObject({ type: 'NETWORK_ERROR', retryable: true });
    r.upstream.setTokenMode('ok');
    r.upstream.setMode('ok');
    expect((await r.call()).isError).toBeFalsy();
    expect(r.upstream.mutations).toHaveLength(2); // rejected attempt + successful attempt
  });

  it('keeps a complete upstream error replayable', async () => {
    const r = await rig();
    r.upstream.setMode('502');
    expect(error(await r.call())).toMatchObject({ type: 'AVITO_SERVER_ERROR' });
    expect(structured(await r.call()).idempotent_replay).toBe(true);
    expect(r.upstream.mutations).toHaveLength(1);
  });

  it('keeps read-only transport failures retryable', async () => {
    const r = await rig();
    vi.spyOn(r.avito, 'request').mockRejectedValue(
      new AvitoTransportError(
        { method: 'GET', url: 'https://api.test.example/read' },
        new Error('Request timeout'),
      ),
    );
    const result = (await r.client.callTool({
      name: 'read_probe',
      arguments: {},
    })) as CallToolResult;
    expect(error(result)).toMatchObject({ type: 'TIMEOUT', retryable: true });
  });

  it('tracks dispatch in custom mutating executors too', async () => {
    const r = await rig({ custom: true });
    r.upstream.setMode('disconnect');
    expect(error(await r.call())).toMatchObject({ type: 'OUTCOME_UNKNOWN', retryable: false });
    expect(error(await r.call())).toMatchObject({ type: 'IDEMPOTENCY_HELD', retryable: false });
    expect(r.upstream.mutations).toHaveLength(1);
  });

  for (const durable of [false, true]) {
    for (const withKey of [false, true]) {
      it(`keeps an unknown confirmation claimed (${durable ? 'durable' : 'memory'}, ${withKey ? 'key' : 'no key'})`, async () => {
        const r = await rig({ durable, confirmation: true });
        const pending = await r.call(withKey ? KEY : null);
        const confirmationId = structured(pending).confirmation_id as string;
        r.upstream.setMode('disconnect');
        const result = (await r.client.callTool({
          name: 'meta_confirm_action',
          arguments: { confirmation_id: confirmationId },
        })) as CallToolResult;
        expect(error(result)).toMatchObject({ type: 'OUTCOME_UNKNOWN', retryable: false });
        expect(await r.ctx.pendingStore.isActivePersistent(confirmationId)).toBe(true);
        const repeated = await r.client.callTool({
          name: 'meta_confirm_action',
          arguments: { confirmation_id: confirmationId },
        });
        expect(repeated.isError).toBe(true);
        if (withKey) expect(error(await r.call())).toMatchObject({ type: 'IDEMPOTENCY_HELD' });
        expect(r.upstream.mutations).toHaveLength(1);
      });
    }
  }

  it('allows a fresh confirmation after a failure before dispatch with the same key', async () => {
    const r = await rig({ durable: true, confirmation: true, warmToken: false });
    const first = await r.call();
    const confirmationId = structured(first).confirmation_id as string;
    r.upstream.setTokenMode('disconnect');
    const result = (await r.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: confirmationId },
    })) as CallToolResult;
    expect(error(result)).toMatchObject({ retryable: true });
    expect(await r.ctx.pendingStore.isActivePersistent(confirmationId)).toBe(false);
    const next = await r.call();
    expect(structured(next).requires_confirmation).toBe(true);
    expect(structured(next).confirmation_id).not.toBe(confirmationId);
    r.upstream.setTokenMode('ok');
    const confirmed = await r.client.callTool({
      name: 'meta_confirm_action',
      arguments: { confirmation_id: structured(next).confirmation_id },
    });
    expect(confirmed.isError).toBeFalsy();
    expect(r.upstream.mutations).toHaveLength(1);
  });

  it('preserves a known BBIP order when subsequent read-only status polling fails', async () => {
    const r = await rig();
    const requests: string[] = [];
    vi.spyOn(r.avito, 'request').mockImplementation(async (opts) => {
      requests.push(opts.path);
      opts.onDispatch?.();
      if (opts.path.endsWith('/create'))
        return {
          status: 200,
          data: { orderId: 'known-order', status: 'initialized' },
          headers: new Headers(),
        } as never;
      throw new AvitoTransportError(
        { method: 'POST', url: 'https://api.test.example/status' },
        new Error('Request timeout'),
      );
    });
    const args = {
      items: [{ itemId: 42, duration: 1, oldPrice: 100, price: 100 }],
      idempotencyKey: KEY,
    };
    const first = (await r.client.callTool({
      name: 'promotion_create_bbip_order_for_items_v1',
      arguments: args,
    })) as CallToolResult;
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({ orderId: 'known-order', outcome: 'pending' });
    await r.client.callTool({ name: 'promotion_create_bbip_order_for_items_v1', arguments: args });
    expect(requests.filter((path) => path.endsWith('/create'))).toHaveLength(1);
  });
});
