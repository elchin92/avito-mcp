/**
 * A REAL HTTP server that stands in for Avito, and counts what reaches it.
 *
 * The suites that use this are about money: "did a second mutation go out?" is
 * the whole assertion, and a `vi.stubGlobal('fetch', …)` cannot answer it
 * honestly — a mock counts the calls the code MEANT to make, on a code path
 * where the request never became bytes and never had a socket to be cancelled
 * on. Here the server under test dials a loopback port, the request is a real
 * one, and the counter is incremented by the receiving end.
 *
 * Nothing in this file, and nothing that uses it, contacts api.avito.ru.
 *
 * Serves exactly what the fixture needs:
 *   POST /token                                 → a client-credentials token
 *   PUT  /core/v1/accounts/:uid/items/:iid/vas  → the money mutation (items_put_item_vas)
 *
 * Both are mode-switchable at runtime so one server can play the hung upstream,
 * the healthy one and the failing one within a single test without a restart.
 *
 * Not named *.test.ts, so vitest's include pattern does not collect it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type UpstreamMode = 'ok' | 'hang' | '502';
export type TokenMode = 'ok' | 'hang';

export interface MutationRecord {
  seq: number;
  method: string;
  url: string;
  body: string;
  at: number;
  mode: UpstreamMode;
}

export interface FakeAvito {
  port: number;
  baseUrl: string;
  /** Every mutating request that reached the fake Avito, in arrival order. */
  mutations: MutationRecord[];
  tokenCalls: () => number;
  setMode(mode: UpstreamMode): void;
  setTokenMode(mode: TokenMode): void;
  /** Answers every request currently parked by mode 'hang'. */
  releaseHung(): void;
  close(): Promise<void>;
}

const MUTATION_PATH = /^\/core\/v1\/accounts\/\d+\/items\/\d+\/vas$/;

export async function startFakeAvito(): Promise<FakeAvito> {
  const mutations: MutationRecord[] = [];
  let tokens = 0;
  let mode: UpstreamMode = 'ok';
  let tokenMode: TokenMode = 'ok';
  const hung: ServerResponse[] = [];
  const sockets = new Set<Socket>();

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += String(chunk)));
      req.on('end', () => resolve(data));
      req.on('error', () => resolve(data));
    });

  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const url = (req.url ?? '').split('?')[0] ?? '';

      if (req.method === 'POST' && url.startsWith('/token')) {
        tokens += 1;
        if (tokenMode === 'hang') {
          hung.push(res);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }));
        return;
      }

      if (req.method === 'PUT' && MUTATION_PATH.test(url)) {
        mutations.push({
          seq: mutations.length + 1,
          method: req.method,
          url,
          body,
          at: Date.now(),
          mode,
        });
        if (mode === 'hang') {
          hung.push(res); // deliberately never answered until releaseHung()
          return;
        }
        if (mode === '502') {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 502, message: 'fake upstream is down' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ result: { success: true, mutation_seq: mutations.length } }),
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, message: `no fake route for ${req.method} ${url}` } }));
    })();
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    mutations,
    tokenCalls: () => tokens,
    setMode(next: UpstreamMode) {
      mode = next;
    },
    setTokenMode(next: TokenMode) {
      tokenMode = next;
    },
    releaseHung() {
      while (hung.length > 0) {
        const res = hung.shift()!;
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: { success: true, released: true } }));
        } catch {
          // the socket may already be gone; the test does not depend on this answer
        }
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hung.splice(0)) res.destroy();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
