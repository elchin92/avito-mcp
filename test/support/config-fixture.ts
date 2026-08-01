/**
 * The one place a test `Config` is built.
 *
 * Before this fixture the same ~40-line literal was pasted into fourteen test
 * files; every field added to `Config` had to be added fourteen times, and the
 * copies had already drifted (some carried `confirmationSecret: undefined`, two
 * cast with `as Config` to paper over the gap).
 *
 * Two properties matter beyond deduplication:
 *
 *  1. Defaults mirror `ConfigSchema` in src/config.ts wherever the schema has a
 *     default, so a fixture config looks like a config a user could actually
 *     load. Only the fields a schema default cannot supply sensibly for a test —
 *     credentials, the API host, the log level and the on-disk state paths —
 *     deviate, and they deviate towards values that cannot touch production.
 *
 *  2. Every config gets its OWN directory on the repository filesystem. The old
 *     literals put `tokenFile` in `os.tmpdir()` and left `runtimeStateDir`
 *     unset, so `runtimeStateDirectory()` collapsed all of them onto
 *     `os.tmpdir()/runtime` — and the namespace under it is a hash of
 *     baseUrl + clientId + profileId, which the literals had copied too. Every
 *     parallel vitest worker therefore contended for one lease directory. Here
 *     `tokenFile` lives in a private sandbox and `runtimeStateDir` is derived
 *     from it by exactly the rule production uses, so the isolation is real and
 *     the derivation stays observable: overriding `tokenFile` alone still moves
 *     the runtime directory with it.
 *
 * Not named *.test.ts, so vitest's include pattern does not collect it.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Config, HttpConfig, WebhookConfig } from '../../src/config.js';
import { createSandboxSync } from './sandbox.js';

/**
 * Overrides are optional all the way down: `http` and `webhook` take a partial of
 * their own, so a caller that only cares about `http.port` does not have to
 * restate the other eleven HTTP fields.
 */
export interface ConfigOverrides extends Partial<Omit<Config, 'http' | 'webhook'>> {
  http?: Partial<HttpConfig>;
  webhook?: Partial<WebhookConfig>;
}

/** One private root per worker process; each config gets a numbered child of it. */
let processRoot: string | undefined;
let configSeq = 0;

function configHome(): string {
  processRoot ??= createSandboxSync(`config-${process.pid}`);
  const home = join(processRoot, `cfg-${++configSeq}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/** HTTP block with the defaults `buildHttpConfig()` produces from an empty env. */
export function makeHttpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
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
    // M3.8. The modern leg's budgets, at the values buildHttpConfig() defaults
    // them to (AVITO_MCP_HTTP_MAX_INFLIGHT / _MAX_STREAMS, 64 and 32). Required
    // on HttpConfig, so every caller of this fixture needs them; before the
    // fixture existed each of the fourteen literals carried its own copy, which
    // is precisely the duplication this file was created to end.
    maxInflight: 64,
    maxStreams: 32,
    oauthTokenTtlSec: 3600,
    ...overrides,
  };
}

/** Webhook block with the defaults `buildWebhookConfig()` produces from an empty env. */
export function makeWebhookConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    enabled: false,
    publicUrl: 'http://127.0.0.1:3000',
    path: '/avito/webhook',
    bufferSize: 100,
    ...overrides,
  };
}

/**
 * A complete `Config` for tests. `approvalMode` is deliberately left unset — it is
 * optional on `Config`, none of the replaced literals set it, and leaving it out
 * keeps the "unset" branch of the approval code exercised.
 */
export function makeConfig(overrides: ConfigOverrides = {}): Config {
  const { http, webhook, ...rest } = overrides;
  const tokenFile = rest.tokenFile ?? join(configHome(), 'token.json');
  return {
    clientId: 'cid',
    clientSecret: 'sec',
    profileId: 12345,
    baseUrl: 'https://api.test.example',
    cpaSource: 'avito-mcp-test',
    logLevel: 'fatal',
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: false,
    allowedUploadDirs: [],
    maxUploadMb: 15,
    confirmationMode: 'money_public',
    confirmationTtlSec: 900,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    ...rest,
    tokenFile,
    // The same rule runtimeStateDirectory() applies in src/core/runtime-state.ts,
    // applied eagerly so the directory is private per config rather than shared.
    runtimeStateDir: rest.runtimeStateDir ?? join(dirname(tokenFile), 'runtime'),
    http: makeHttpConfig(http),
    webhook: makeWebhookConfig(webhook),
  };
}
