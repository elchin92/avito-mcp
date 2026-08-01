import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  EnvValidationError,
  parseBool,
  parseChoice,
  parsePositiveInt,
  requireStrongSecret,
} from '../src/config.js';

describe('strict environment parsing', () => {
  it('accepts explicit boolean spellings', () => {
    expect(parseBool('true')).toBe(true);
    expect(parseBool('ON')).toBe(true);
    expect(parseBool('0')).toBe(false);
    expect(parseBool('no')).toBe(false);
  });

  it('rejects unknown booleans instead of silently disabling a guard', () => {
    expect(() => parseBool('treu', false, 'DRY_RUN')).toThrow(EnvValidationError);
  });

  it('rejects partial, unsafe and out-of-range integers', () => {
    expect(() => parsePositiveInt('12garbage', 1, 'PORT')).toThrow(EnvValidationError);
    expect(() => parsePositiveInt('0', 1, 'PORT')).toThrow(EnvValidationError);
    expect(() => parsePositiveInt('65536', 1, 'PORT', 65_535)).toThrow(EnvValidationError);
  });

  it('rejects unknown enum values instead of applying a fallback', () => {
    expect(() =>
      parseChoice('htpt', 'stdio', 'TRANSPORT', ['stdio', 'http', 'both'] as const),
    ).toThrow(EnvValidationError);
  });

  it('requires at least 32 bytes for network-facing secrets', () => {
    expect(() => requireStrongSecret('short', 'SECRET')).toThrow(EnvValidationError);
    expect(() => requireStrongSecret('x'.repeat(32), 'SECRET')).not.toThrow();
  });

  it('fails startup for an invalid transport instead of falling back to stdio', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', "await import('./src/config.ts')"],
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AVITO_ENV_FILE: '/dev/null',
          AVITO_MCP_TRANSPORT: 'htpt',
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AVITO_MCP_TRANSPORT must be one of');
  });

  it('fails HTTP startup configuration for a weak owner password', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', "await import('./src/config.ts')"],
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AVITO_ENV_FILE: '/dev/null',
          AVITO_MCP_TRANSPORT: 'http',
          AVITO_MCP_HTTP_AUTH: 'oauth',
          AVITO_MCP_OAUTH_OWNER_PASSWORD: 'weak',
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'AVITO_MCP_OAUTH_OWNER_PASSWORD must contain at least 32 bytes',
    );
  });

  it('fails for an invalid webhook flag even when no secret is configured', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', "await import('./src/config.ts')"],
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AVITO_ENV_FILE: '/dev/null',
          AVITO_MCP_WEBHOOK_ENABLED: 'flase',
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AVITO_MCP_WEBHOOK_ENABLED must be one of');
  });

  // ── M3.1: AVITO_MCP_PROTOCOL_ERA ─────────────────────────────────────────
  //
  // Read through a spawned process rather than by importing config.ts: the
  // module is a singleton evaluated at first import, so a same-process test
  // could only ever observe the era the very first test file happened to set.
  const readEra = (value?: string): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "const m = await import('./src/config.ts'); process.stdout.write(JSON.stringify({ raw: m.config.protocolEra, resolved: m.protocolEraOf(m.config) }));",
      ],
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AVITO_ENV_FILE: '/dev/null',
          ...(value === undefined ? {} : { AVITO_MCP_PROTOCOL_ERA: value }),
        },
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it('defaults the protocol era to legacy when the variable is unset', () => {
    const result = readEra();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ raw: 'legacy', resolved: 'legacy' });
  });

  it.each(['legacy', 'dual', 'modern'] as const)('accepts protocol era %s', (era) => {
    const result = readEra(era);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ raw: era, resolved: era });
  });

  it('fails startup for an unknown protocol era instead of falling back to legacy', () => {
    // A typo must be loud. Silently serving `legacy` when the operator asked for
    // `dual` would make a canary look healthy while proving nothing.
    const result = readEra('duel');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AVITO_MCP_PROTOCOL_ERA must be one of: legacy, dual, modern');
  });

  it('documents approval and runtime-state settings in --help', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts', '--help'], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('AVITO_MCP_APPROVAL_MODE');
    expect(result.stdout).toContain('AVITO_MCP_RUNTIME_STATE_DIR');
    expect(result.stdout).toContain('AVITO_MCP_PROTOCOL_ERA');
  });
});
