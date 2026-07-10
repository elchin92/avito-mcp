import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { bindMcpLogger, logger, runWithMcpLogger } from '../src/logger.js';

function fakeServer() {
  return {
    sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as McpServer;
}

describe('MCP log session sinks', () => {
  it('redacts top-level secrets in the real pino stderr stream', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "const {logger}=await import('./src/logger.ts');logger.info({accessToken:'stderr-canary'},'stderr-redaction');logger.flush();",
      ],
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LOG_LEVEL: 'info' },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('stderr-redaction');
    expect(result.stderr).toContain('[redacted]');
    expect(result.stderr).not.toContain('stderr-canary');
  });

  it('mirrors to every active sink, redacts secrets and tears down independently', async () => {
    const first = fakeServer();
    const second = fakeServer();
    const stopFirst = bindMcpLogger(first);
    const stopSecond = bindMcpLogger(second);

    logger.info(
      {
        accessToken: 'token-canary',
        nested: {
          'set-cookie': 'cookie-canary',
          apiKey: 'api-key-canary',
          tokenFile: '/private/token-file-canary',
        },
        visible: 1,
      },
      'sink-test-active',
    );
    await vi.waitFor(() => {
      expect(first.sendLoggingMessage).toHaveBeenCalled();
      expect(second.sendLoggingMessage).toHaveBeenCalled();
    });

    const firstMessage = vi
      .mocked(first.sendLoggingMessage)
      .mock.calls.find(
        ([message]) => (message.data as { msg?: string }).msg === 'sink-test-active',
      )?.[0];
    expect(firstMessage?.data).toMatchObject({
      accessToken: '[redacted]',
      nested: { 'set-cookie': '[redacted]', apiKey: '[redacted]', tokenFile: '[redacted]' },
      visible: 1,
    });
    expect(JSON.stringify(firstMessage)).not.toMatch(/(?:token|cookie|api-key|token-file)-canary/);

    stopFirst();
    vi.mocked(first.sendLoggingMessage).mockClear();
    vi.mocked(second.sendLoggingMessage).mockClear();
    logger.warn('sink-test-after-teardown');
    await vi.waitFor(() => expect(second.sendLoggingMessage).toHaveBeenCalled());
    expect(first.sendLoggingMessage).not.toHaveBeenCalled();

    stopSecond();
  });

  it('isolates request-scoped HTTP logs and does not broadcast background events', async () => {
    const first = fakeServer();
    const second = fakeServer();
    const stopFirst = bindMcpLogger(first, { background: false });
    const stopSecond = bindMcpLogger(second, { background: false });
    try {
      await Promise.all([
        runWithMcpLogger(first, async () => {
          await Promise.resolve();
          logger.info({ request: 'first' }, 'request-first');
        }),
        runWithMcpLogger(second, async () => {
          await Promise.resolve();
          logger.info({ request: 'second' }, 'request-second');
        }),
      ]);
      logger.info('background-http-event');

      await vi.waitFor(() => {
        expect(first.sendLoggingMessage).toHaveBeenCalledTimes(1);
        expect(second.sendLoggingMessage).toHaveBeenCalledTimes(1);
      });
      expect(first.sendLoggingMessage).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ msg: 'request-first' }) }),
      );
      expect(second.sendLoggingMessage).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ msg: 'request-second' }) }),
      );
    } finally {
      stopFirst();
      stopSecond();
    }
  });

  it('redacts configured secret-key variants from stderr', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "const {logger}=await import('./src/logger.ts');logger.info({confirmationSecret:'confirm-canary',http:{authTokens:['auth-canary']},deep:{a:{b:{c:{d:{e:{f:{apiKey:'deep-canary'}}}}}}}},'variant-redaction');logger.flush();",
      ],
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, LOG_LEVEL: 'info' },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('confirm-canary');
    expect(result.stderr).not.toContain('auth-canary');
    expect(result.stderr).not.toContain('deep-canary');
  });
});
