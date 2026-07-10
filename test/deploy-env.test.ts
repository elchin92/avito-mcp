import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parse } from 'dotenv';

const root = resolve(import.meta.dirname, '..');
const renderer = join(root, 'deploy', 'render-service-env.mjs');
const packageJson = join(root, 'package.json');
let cleanupRoot: string | undefined;

async function render(base: string, remote: string) {
  cleanupRoot = join(tmpdir(), `avito-deploy-env-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(cleanupRoot, { recursive: true });
  const baseFile = join(cleanupRoot, 'base.env');
  const remoteFile = join(cleanupRoot, 'remote.env');
  const output = join(cleanupRoot, 'service.env');
  await fs.writeFile(baseFile, base);
  await fs.writeFile(remoteFile, remote);
  const result = spawnSync(
    process.execPath,
    [renderer, packageJson, baseFile, remoteFile, output],
    {
      encoding: 'utf8',
    },
  );
  return { result, output };
}

afterEach(async () => {
  if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
  cleanupRoot = undefined;
});

describe('systemd deployment environment renderer', () => {
  it('parses dotenv syntax, allowlists runtime keys, and keeps remote overrides', async () => {
    const { result, output } = await render(
      'Client_id = "client id"\nClient_secret = "secret value"\nProfile_id = 123\nNPM_TOKEN=publish-canary\n',
      'AVITO_MCP_TRANSPORT = http\nAVITO_MCP_HTTP_HOST=0.0.0.0\nAVITO_MCP_HTTP_PORT=3456\nLOG_LEVEL=warn\nAVITO_TOKEN_FILE=/var/lib/avito-mcp/token.json\nAVITO_MCP_OAUTH_STORE_FILE=/var/lib/avito-mcp/oauth.json\nAVITO_MCP_WEBHOOK_LOG_FILE=/var/lib/avito-mcp/webhook.jsonl\nNPM_CONFIG_USERCONFIG=/secret/npmrc\n',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('http://127.0.0.1:3456');
    const raw = await fs.readFile(output, 'utf8');
    const env = parse(raw);
    expect(env).toMatchObject({
      Client_id: 'client id',
      Client_secret: 'secret value',
      Profile_id: '123',
      AVITO_MCP_TRANSPORT: 'http',
      LOG_LEVEL: 'warn',
      AVITO_TOKEN_FILE: '/var/lib/avito-mcp/token.json',
      AVITO_MCP_OAUTH_STORE_FILE: '/var/lib/avito-mcp/oauth.json',
      AVITO_MCP_WEBHOOK_LOG_FILE: '/var/lib/avito-mcp/webhook.jsonl',
    });
    expect(raw).not.toContain('publish-canary');
    expect(raw).not.toContain('NPM_CONFIG_USERCONFIG');
    if (process.platform !== 'win32') expect((await fs.stat(output)).mode & 0o077).toBe(0);

    for (const [key, value] of [
      ['AVITO_TOKEN_FILE', '/tmp/outside-state'],
      ['AVITO_MCP_OAUTH_STORE_FILE', 'relative-state.json'],
      ['AVITO_MCP_WEBHOOK_LOG_FILE', '/var/lib/avito-mcp/../outside-state'],
      ['AVITO_MCP_WEBHOOK_LOG_FILE', '/var/lib/avito-mcp'],
    ]) {
      await fs.rm(cleanupRoot!, { recursive: true, force: true });
      cleanupRoot = undefined;
      const invalid = await render(
        'Client_id=id\nClient_secret=secret\nProfile_id=100\n',
        `${key}=${value}\n`,
      );
      expect(invalid.result.status).not.toBe(0);
      expect(invalid.result.stderr).toContain(
        `${key} must be an absolute file path inside /var/lib/avito-mcp`,
      );
    }
  });

  it('fails closed instead of deploying without the full credential tuple', async () => {
    const { result, output } = await render(
      'Client_id=id\nClient_secret=secret\n',
      'LOG_LEVEL=info\n',
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('requires Client_id, Client_secret, and Profile_id');
    await expect(fs.access(output)).rejects.toThrow();
  });

  it('normalizes credential aliases and gives the remote file precedence', async () => {
    const { result, output } = await render(
      'Client_id=base-id\nClient_secret=base-secret\nProfile_id=100\n',
      'CLIENT_ID=remote-id\nCLIENT_SECRET=remote-secret\nPROFILE_ID=200\n',
    );
    expect(result.status, result.stderr).toBe(0);
    expect(parse(await fs.readFile(output, 'utf8'))).toMatchObject({
      Client_id: 'remote-id',
      Client_secret: 'remote-secret',
      Profile_id: '200',
    });
    expect(await fs.readFile(output, 'utf8')).not.toContain('CLIENT_ID=');
  });

  it('does not create an environment file when the probe port is invalid', async () => {
    const { result, output } = await render(
      'Client_id=id\nClient_secret=secret\nProfile_id=100\n',
      'AVITO_MCP_HTTP_PORT=70000\n',
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AVITO_MCP_HTTP_PORT must be an integer');
    await expect(fs.access(output)).rejects.toThrow();
  });

  it('round-trips systemd-safe punctuation and rejects control characters', async () => {
    const special = String.raw`ci\secret"$#value`;
    const safe = await render(
      `Client_id=id\nClient_secret='${special}'\nProfile_id=100\n`,
      'LOG_LEVEL=info\n',
    );
    expect(safe.result.status, safe.result.stderr).toBe(0);
    expect(await fs.readFile(safe.output, 'utf8')).toContain(
      `Client_secret=${JSON.stringify(special)}`,
    );

    await fs.rm(cleanupRoot!, { recursive: true, force: true });
    cleanupRoot = undefined;
    const controlValue = `secret${String.fromCharCode(9)}value`;
    const unsafe = await render(
      `Client_id=id\nClient_secret="${controlValue}"\nProfile_id=100\n`,
      'LOG_LEVEL=info\n',
    );
    expect(unsafe.result.status).not.toBe(0);
    expect(unsafe.result.stderr).toContain('contains a control character');
    await expect(fs.access(unsafe.output)).rejects.toThrow();
  });
});
