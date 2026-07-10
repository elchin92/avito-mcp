import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HttpConfig } from '../src/config.js';
import type { ToolContext } from '../src/core/tool-factory.js';

let releaseConnect: (() => void) | undefined;
let markConnectEntered: (() => void) | undefined;

vi.mock('../src/build-server.js', () => ({
  buildMcpServer: () => ({
    connect: async () => {
      markConnectEntered?.();
      await new Promise<void>((resolve) => {
        releaseConnect = resolve;
      });
      throw new Error('intentional connect stop');
    },
    close: async () => undefined,
  }),
}));

const { createMcpHttpHandler } = await import('../src/http/mcp-http.js');

function config(): HttpConfig {
  return {
    transport: 'http',
    host: '127.0.0.1',
    port: 3000,
    publicUrl: 'https://mcp.example.com',
    auth: 'none',
    authTokens: [],
    allowNoAuth: true,
    allowedHosts: [],
    allowedOrigins: [],
    maxSessions: 1,
    sessionIdleSec: 1800,
    oauthTokenTtlSec: 3600,
  };
}

function initialize(base: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'concurrency-test', version: '1' },
      },
    }),
  });
}

describe('MCP HTTP initialization reservations', () => {
  let server: import('node:http').Server | undefined;
  let closeHandler: (() => Promise<void>) | undefined;

  afterEach(async () => {
    releaseConnect?.();
    await closeHandler?.();
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    server = undefined;
    closeHandler = undefined;
    releaseConnect = undefined;
    markConnectEntered = undefined;
  });

  it('rejects a second initialize while the first is still connecting', async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    markConnectEntered = () => enteredResolve?.();

    const handler = createMcpHttpHandler({} as ToolContext, config());
    closeHandler = handler.closeAll;
    const app = express();
    app.use(express.json());
    app.all('/mcp', handler.handleRequest);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const first = initialize(base);
    await entered;
    const second = await initialize(base);
    expect(second.status).toBe(503);
    expect(await second.json()).toMatchObject({
      error: { message: expect.stringContaining('Too many concurrent sessions') },
    });

    releaseConnect?.();
    expect((await first).status).toBe(500);
  });
});
