/**
 * The stdio half of the era-2026 test seam (M3.9).
 *
 * `test/support/modern-rig.ts` covers the HTTP leg through `handler.fetch`.
 * There is no equivalent in-process entry for stdio: `serveStdio` owns a
 * process's stdin/stdout and decides the connection's era from the messages it
 * reads, so the only honest way to observe it is to SPAWN the real
 * `src/server.ts` and talk newline-delimited JSON-RPC to it.
 *
 * What this buys that an in-process `McpServer` cannot:
 *   • the era decision is made by `serveStdio`, not by the test;
 *   • stderr is a first-class observable — the era-pin diagnostic (M3.10) is a
 *     stderr line and nothing else, because a stdio connection's stdout is the
 *     protocol and must stay uncontaminated;
 *   • a connection is a real, long-lived thing, so "the second message on an
 *     already-pinned connection" is expressible at all.
 *
 * Not named *.test.ts, so vitest's include pattern does not collect it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import { resolve } from 'node:path';

import { createSandboxSync, removeSandbox } from './sandbox.js';
import { MODERN_PROTOCOL_VERSION } from '../../src/version.js';
import type { ProtocolEraMode } from '../../src/config.js';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** One JSON-RPC frame read off the child's stdout. */
export interface StdioFrame {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface StdioConnection {
  /** Writes one newline-delimited JSON-RPC message to the child's stdin. */
  send(message: unknown): void;
  /** Resolves with the next stdout frame, or rejects on timeout. */
  next(timeoutMs?: number): Promise<StdioFrame>;
  /** Everything the child has written to stderr so far. */
  stderr(): string;
  /** Resolves once a stderr line matches, or rejects on timeout. */
  waitForStderr(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Kills the child and waits for it to exit. */
  close(): Promise<void>;
}

/** A well-formed 2026-07-28 request body for the stdio wire (no headers exist here). */
export function modernMessage(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  metaOverrides: Record<string, unknown> = {},
): unknown {
  const meta: Record<string, unknown> = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: {},
    [CLIENT_INFO_META_KEY]: { name: 'stdio-rig', version: '1.0.0' },
    ...metaOverrides,
  };
  for (const [key, value] of Object.entries(metaOverrides)) {
    if (value === undefined) delete meta[key];
  }
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } };
}

/** A 2025-era message: no envelope at all, which is what pins a dual connection. */
export function legacyMessage(
  id: number | undefined,
  method: string,
  params: Record<string, unknown> = {},
): unknown {
  return {
    jsonrpc: '2.0',
    ...(id !== undefined ? { id } : {}),
    method,
    params,
  };
}

const live: Array<{ child: ChildProcessWithoutNullStreams; lines: Interface; sandbox: string }> =
  [];

export async function startStdio(
  era: ProtocolEraMode,
  env: Record<string, string> = {},
): Promise<StdioConnection> {
  const sandbox = createSandboxSync('stdio-rig');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AVITO_ENV_FILE: '/dev/null',
      CLIENT_ID: 'cid',
      CLIENT_SECRET: 'sec',
      PROFILE_ID: '12345678',
      AVITO_TOKEN_FILE: `${sandbox}/token.json`,
      AVITO_MCP_RUNTIME_STATE_DIR: sandbox,
      AVITO_MCP_TRANSPORT: 'stdio',
      AVITO_MCP_PROTOCOL_ERA: era,
      LOG_LEVEL: 'fatal',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines = createInterface({ input: child.stdout });
  const frames: StdioFrame[] = [];
  let delivered = 0;
  const waiters: Array<{ resolve: (f: StdioFrame) => void; reject: (e: Error) => void }> = [];
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let frame: StdioFrame;
    try {
      frame = JSON.parse(line) as StdioFrame;
    } catch {
      return;
    }
    frames.push(frame);
    while (waiters.length > 0 && delivered < frames.length) {
      waiters.shift()!.resolve(frames[delivered++]!);
    }
  });

  let stderrText = '';
  const stderrWaiters: Array<{
    pattern: RegExp;
    resolve: (line: string) => void;
  }> = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
    for (let i = stderrWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = stderrWaiters[i]!;
      const match = waiter.pattern.exec(stderrText);
      if (match) {
        stderrWaiters.splice(i, 1);
        waiter.resolve(match[0]);
      }
    }
  });

  live.push({ child, lines, sandbox });

  return {
    send: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    next: (timeoutMs = 20_000) =>
      new Promise<StdioFrame>((resolvePromise, reject) => {
        if (delivered < frames.length) {
          resolvePromise(frames[delivered++]!);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`no stdout frame within ${timeoutMs}ms; stderr=${stderrText}`)),
          timeoutMs,
        );
        waiters.push({
          resolve: (f) => {
            clearTimeout(timer);
            resolvePromise(f);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      }),
    stderr: () => stderrText,
    waitForStderr: (pattern, timeoutMs = 20_000) =>
      new Promise<string>((resolvePromise, reject) => {
        const existing = pattern.exec(stderrText);
        if (existing) {
          resolvePromise(existing[0]);
          return;
        }
        const waiter = { pattern, resolve: resolvePromise };
        stderrWaiters.push(waiter);
        setTimeout(() => {
          const index = stderrWaiters.indexOf(waiter);
          if (index !== -1) stderrWaiters.splice(index, 1);
          reject(new Error(`no stderr line matching ${pattern} within ${timeoutMs}ms`));
        }, timeoutMs).unref();
      }),
    close: () => teardown({ child, lines, sandbox }),
  };
}

/**
 * Kills one child and waits for it. `exitCode`/`signalCode` are checked first:
 * `once(child, 'exit')` on a process that has ALREADY exited never resolves,
 * which turns a second teardown (an explicit `close()` followed by the
 * `afterEach` sweep) into a hung hook.
 */
async function teardown(entry: {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  sandbox: string;
}): Promise<void> {
  const index = live.indexOf(entry);
  if (index !== -1) live.splice(index, 1);
  entry.lines.close();
  if (entry.child.exitCode === null && entry.child.signalCode === null) {
    entry.child.kill('SIGKILL');
    await once(entry.child, 'exit').catch(() => undefined);
  }
  await removeSandbox(entry.sandbox).catch(() => undefined);
}

/** For `afterEach`: tears down every child this module started. */
export async function closeStdioConnections(): Promise<void> {
  for (const entry of live.splice(0)) await teardown(entry);
}
