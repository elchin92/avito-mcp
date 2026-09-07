/** A scripted MCP walkthrough backed only by an in-process loopback fixture. */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LEGACY_PROTOCOL_VERSION } from './version.js';

export async function runDemo(json = false): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'avito-mcp-demo-'));
  let mutations = 0;
  let listingPages = 0;
  const fixture = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let result: unknown;
    if (request.method === 'POST' && url.pathname === '/token') {
      result = { access_token: 'fictional-demo-token', expires_in: 3600 };
    } else if (request.method === 'GET' && url.pathname.endsWith('/balance/')) {
      result = { real: 5000, bonus: 0 };
    } else if (request.method === 'GET' && url.pathname === '/core/v1/items') {
      listingPages++;
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get('per_page') ?? 50);
      const resources = Array.from({ length: 53 }, (_, index) => ({
        id: index + 1,
        status: 'active',
        title: `Demo listing ${index + 1}`,
      })).slice((page - 1) * size, page * size);
      result = { resources, meta: { page, per_page: size } };
    } else if (request.method === 'GET' && url.pathname.endsWith('/chats')) {
      result = { chats: [{ id: 'demo-chat-1' }, { id: 'demo-chat-2' }] };
    } else if (request.method === 'POST' && url.pathname === '/core/v1/items/1/update_price') {
      mutations++;
      result = { result: { success: true } };
    } else {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Unsupported demo route' }));
      return;
    }
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const port = (fixture.address() as AddressInfo).port;
    const envFile = join(directory, 'empty.env');
    await writeFile(envFile, '');
    const entry = fileURLToPath(
      new URL(import.meta.url.endsWith('.ts') ? './server.ts' : './server.js', import.meta.url),
    );
    const args = entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx'), entry] : [entry];
    // Do not inherit Avito credentials, NODE_OPTIONS, HTTP/webhook settings, or
    // an operator's dotenv path. The real server talks only to this fixture.
    const child = spawn(process.execPath, args, {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: directory,
        TMP: directory,
        Client_id: 'fictional-demo-client',
        Client_secret: 'fictional-demo-secret',
        Profile_id: '1',
        AVITO_ENV_FILE: envFile,
        AVITO_BASE_URL: `http://127.0.0.1:${port}`,
        AVITO_TOKEN_FILE: join(directory, 'token.json'),
        AVITO_MCP_RUNTIME_STATE_DIR: directory,
        AVITO_MCP_TRANSPORT: 'stdio',
        AVITO_MCP_PROTOCOL_ERA: 'legacy',
        AVITO_MCP_CONFIRMATION_MODE: 'all_destructive',
        LOG_LEVEL: 'fatal',
        AVITO_MCP_ALLOW_TOOLS: [
          'user_get_user_balance',
          'items_get_items_info',
          'messenger_get_chats_v2',
          'items_update_price',
          'meta_confirm_action',
          'meta_list_pending_actions',
          'meta_cancel_action',
        ].join(','),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit').catch(() => undefined);
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    const pending = new Map<
      number,
      { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
    >();
    let nextId = 0;
    const rejectPending = (error: Error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    lines.on('line', (line) => {
      let frame: {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      try {
        frame = JSON.parse(line) as typeof frame;
        if (!frame || typeof frame !== 'object') throw new Error('Invalid frame');
      } catch {
        rejectPending(new Error('Demo server returned an invalid JSON-RPC frame'));
        return;
      }
      if (frame.id === undefined) return;
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(new Error(frame.error.message));
      else waiter.resolve(frame.result ?? {});
    });
    child.on('error', rejectPending);
    child.stdin.on('error', rejectPending);
    child.on('exit', () => rejectPending(new Error('Demo server exited before answering')));
    const rpc = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) {
          reject(new Error('Demo server is not running'));
          return;
        }
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Demo timed out: ${method}`));
        }, 20_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    const call = async (name: string, arguments_: Record<string, unknown> = {}) => {
      const result = await rpc('tools/call', { name, arguments: arguments_ });
      assert.notEqual(result.isError, true, `Demo tool failed: ${name}`);
      return result.structuredContent as Record<string, unknown>;
    };
    try {
      await rpc('initialize', {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'avito-mcp-demo', version: '1.0.0' },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
      const tools = await rpc('tools/list', {});
      const balance = await call('user_get_user_balance');
      const listingIds = new Set<number>();
      for (let page = 1; page <= 10; page++) {
        const result = await call('items_get_items_info', { status: 'active', per_page: 50, page });
        const listings = result.resources as Array<{ id: number }>;
        listings.forEach((listing) => listingIds.add(listing.id));
        if (listings.length < 50) break;
      }
      const chats = await call('messenger_get_chats_v2', { unread_only: true, limit: 20 });
      await call('items_update_price', { item_id: 1, price: 1400, dryRun: true });
      assert.equal(mutations, 0, 'Dry run must not send a mutation');
      const proposed = await call('items_update_price', {
        item_id: 1,
        price: 1400,
        idempotencyKey: 'demo-price-1',
      });
      assert.equal(proposed.requires_confirmation, true);
      assert.equal(mutations, 0, 'An unconfirmed proposal must not send a mutation');
      await call('meta_confirm_action', { confirmation_id: proposed.confirmation_id });
      const replay = await call('items_update_price', {
        item_id: 1,
        price: 1400,
        idempotencyKey: 'demo-price-1',
      });
      assert.equal(replay.idempotent_replay, true);
      assert.equal(mutations, 1, 'Retry must reuse the confirmed result');
      assert.equal(listingIds.size, 53);
      const report = {
        fixture: true,
        externalNetwork: false,
        tools: (tools.tools as unknown[]).length,
        balanceRubles: balance.real,
        activeListings: listingIds.size,
        listingPages,
        unreadChats: (chats.chats as unknown[]).length,
        dryRunMutations: 0,
        beforeConfirmationMutations: 0,
        confirmedMutations: mutations,
        idempotentReplay: replay.idempotent_replay,
      };
      process.stdout.write(
        json
          ? JSON.stringify(report, null, 2) + '\n'
          : [
              'AVITO MCP — local demo with fictional data',
              'Real MCP calls; loopback fixture only. No Avito credentials or AI subscription required.',
              '',
              `Balance: ${report.balanceRubles} RUB`,
              `Active listings: ${report.activeListings} across ${report.listingPages} pages`,
              `Unread chats: ${report.unreadChats}`,
              'Price preview: 1400 RUB — no change sent',
              'Proposed change: waiting for confirmation — no change sent',
              'Demo approval: exactly one fixture change',
              'Retry with the same key: cached result — still one change',
              '',
              'Next: https://github.com/elchin92/avito-mcp/blob/main/docs/clients.md',
              '',
            ].join('\n'),
      );
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const forceStop = setTimeout(() => child.kill('SIGKILL'), 3000);
      forceStop.unref();
      await exited;
      clearTimeout(forceStop);
    }
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
