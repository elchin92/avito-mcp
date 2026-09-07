import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const checker = join(root, 'deploy', 'verify-webhook-secret.mjs');
const packageJson = join(root, 'package.json');

const LIVE_SECRET = 'f'.repeat(64);
const STALE_SECRET = '1'.repeat(48);
const PUBLIC_URL = 'https://mcp.example.test';
const RECEIVER_PREFIX = `${PUBLIC_URL}/avito/webhook/`;

let cleanupRoot: string | undefined;
let api: Server | undefined;

/**
 * A stand-in for the Avito API. The checker must ask it for a token and for the
 * account's subscription list; `subscribedSecret` decides which address that list
 * claims Avito is delivering to.
 */
async function startApi(subscribedSecret: string | undefined) {
  const server = createServer((request, response) => {
    if (request.url === '/token') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'test-token', expires_in: 86400 }));
      return;
    }
    if (request.url === '/messenger/v1/subscriptions') {
      // The account always carries a foreign integration's subscription too: the
      // checker must judge only the URLs under our own receiver prefix.
      const subscriptions = [{ url: 'https://other.example.test/callback.php', version: 'v3' }];
      if (subscribedSecret !== undefined) {
        subscriptions.push({ url: `${RECEIVER_PREFIX}${subscribedSecret}`, version: 'v3' });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ subscriptions }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  api = server;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function run(options: {
  checkoutSecret?: string;
  installedSecret?: string | null;
  subscribedSecret?: string | null;
  env?: Record<string, string>;
}) {
  const apiBase = await startApi(
    options.subscribedSecret === null ? undefined : (options.subscribedSecret ?? LIVE_SECRET),
  );
  cleanupRoot = join(tmpdir(), `avito-webhook-check-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(cleanupRoot, { recursive: true });
  const baseFile = join(cleanupRoot, 'base.env');
  const remoteFile = join(cleanupRoot, 'remote.env');
  const serviceFile = join(cleanupRoot, 'service.env');
  await fs.writeFile(baseFile, 'Client_id=id\nClient_secret=secret\nProfile_id=1\n');
  const checkoutSecret = options.checkoutSecret ?? LIVE_SECRET;
  await fs.writeFile(
    remoteFile,
    `AVITO_BASE_URL=${apiBase}\nAVITO_MCP_WEBHOOK_PUBLIC_URL=${PUBLIC_URL}\n` +
      (checkoutSecret === '' ? '' : `AVITO_MCP_WEBHOOK_SECRET=${checkoutSecret}\n`),
  );
  if (options.installedSecret !== null) {
    await fs.writeFile(
      serviceFile,
      `AVITO_MCP_WEBHOOK_SECRET="${options.installedSecret ?? LIVE_SECRET}"\n`,
    );
  }
  // spawn, not spawnSync: the stub API above lives in THIS process's event loop,
  // and a synchronous child would block it until the checker's own timeout fires.
  return await new Promise<{ status: number | null; stderr: string }>((done) => {
    const child = spawn(
      process.execPath,
      [checker, packageJson, baseFile, remoteFile, serviceFile],
      {
        env: { ...process.env, AVITO_MCP_DEPLOY_CHECK_TIMEOUT_MS: '4000', ...(options.env ?? {}) },
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => done({ status, stderr }));
  });
}

afterEach(async () => {
  if (api) await new Promise<void>((done) => api!.close(() => done()));
  api = undefined;
  if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
  cleanupRoot = undefined;
});

describe('webhook secret deployment check', () => {
  it('passes when the deploy keeps the address Avito already delivers to', async () => {
    const result = await run({});
    expect(result.stderr).toContain('the live subscription matches');
    expect(result.status).toBe(0);
  });

  it('refuses a deploy that would move the receiver address, without printing secrets', async () => {
    const result = await run({ checkoutSecret: STALE_SECRET });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('differs from the one the service is running with');
    expect(result.stderr).not.toContain(STALE_SECRET);
    expect(result.stderr).not.toContain(LIVE_SECRET);
  });

  it('refuses when the running service agrees but Avito delivers elsewhere', async () => {
    // The 2026-09-07 shape once the bad env had already been installed: nothing on
    // the host disagrees, and only the account's own subscription can tell.
    const result = await run({ checkoutSecret: STALE_SECRET, installedSecret: STALE_SECRET });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('with a DIFFERENT secret');
    expect(result.stderr).not.toContain(STALE_SECRET);
  });

  it('allows a declared rotation and demands a re-subscribe', async () => {
    const result = await run({
      checkoutSecret: STALE_SECRET,
      env: { AVITO_MCP_DEPLOY_ALLOW_WEBHOOK_SECRET_CHANGE: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('re-subscribe');
  });

  it('only warns when no subscription points at this receiver', async () => {
    const result = await run({ subscribedSecret: null });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('no subscription points at');
  });

  it('is a no-op when the checkout configures no receiver', async () => {
    const result = await run({ checkoutSecret: '', installedSecret: null });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('nothing to check');
  });

  it('can be switched off entirely', async () => {
    const result = await run({
      checkoutSecret: STALE_SECRET,
      env: { AVITO_MCP_DEPLOY_SKIP_WEBHOOK_CHECK: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('skipped by');
  });
});
