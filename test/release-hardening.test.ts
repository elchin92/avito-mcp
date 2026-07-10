import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('release and deployment hardening', () => {
  it('uses supported Node lines and a non-root container', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('FROM node:24-alpine');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('avito-mcp-healthcheck');
    const healthcheck = read('deploy/container-healthcheck.sh');
    expect(healthcheck).toContain('/readyz');
    expect(healthcheck).toContain('AVITO_MCP_HTTP_HOST');
    expect(healthcheck).toContain('probe_host="[$probe_host]"');
    expect(dockerfile).toContain('chmod -R a-w /app/node_modules');
    expect(dockerfile).not.toContain('COPY --chown=node:node');
    expect(dockerfile).toContain('-p 127.0.0.1:3000:3000');
    expect(dockerfile).not.toMatch(/^\s*#\s*-p 3000:3000/m);

    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe('>=22.12.0');
  });

  it('runs both systemd services as dedicated users with sandboxing', () => {
    const app = read('deploy/avito-mcp.service');
    expect(app).toContain('User=avito-mcp');
    expect(app).toContain('UMask=0077');
    expect(app).toContain('NoNewPrivileges=true');
    expect(app).toContain('ProtectSystem=strict');
    expect(app).toContain('WorkingDirectory=/opt/avito-mcp/current');
    expect(app).toContain('EnvironmentFile=/etc/avito-mcp/avito-mcp.env');
    expect(app).not.toContain('User=root');

    const caddy = read('deploy/caddy.service');
    expect(caddy).toContain('User=caddy');
    expect(caddy).toContain('CapabilityBoundingSet=CAP_NET_BIND_SERVICE');
    expect(caddy).toContain('NoNewPrivileges=true');
    expect(caddy).not.toContain('User=root');
  });

  it('installs immutable versioned releases and rolls back failed deployments', () => {
    const installer = read('deploy/install-services.sh');
    expect(installer).toContain('RELEASES_DIR=$INSTALL_ROOT/releases');
    expect(installer).toContain('BASH_SOURCE[0]');
    expect(installer).toContain('flock -n 9');
    expect(installer).toContain("trap 'on_signal 143' TERM");
    expect(installer).toContain('mv -Tf "$next_link" "$CURRENT_LINK"');
    expect(installer).toContain('npm ci --prefix "$STAGING_DIR" --omit=dev');
    expect(installer).toContain('rollback_release');
    expect(installer).not.toContain('app_was_active -eq 1 &&');
    expect(installer).not.toContain('caddy_was_active -eq 1 &&');
    expect(installer).toContain('render-service-env.mjs');
    expect(installer).toContain('--connect-timeout 1 --max-time 2');
    expect(installer).not.toContain('EnvironmentFile=/srv/avito_mcp/.env');
    expect(installer).toContain('/readyz');
    expect(installer).toContain('systemctl restart avito-mcp.service');
  });

  it('keeps dependency and secret scans blocking and actions SHA-pinned', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toContain('continue-on-error');
    expect(ci).toContain('node-version: [22.x, 24.x]');
    expect(ci).toContain('npm run typecheck:tests');
    expect(ci).toContain('npm run test:coverage');
    expect(ci).toContain('npm pack --json');
    expect(ci).not.toContain('npm pack --silent');
    expect(ci).toContain('deploy-gate:');
    expect(ci).toContain('bash deploy/install-services.sh --start');
    expect(ci).toContain('invalid redeploy unexpectedly succeeded');
    expect(ci).toContain('systemctl restart avito-mcp.service');
    expect(ci).toContain('PROJECT_AUDIT\\.md');
    expect(ci).toContain('\\.remote\\.env[^/]*');
    expect(ci).toContain('\\.mcp\\.json[^/]*');
    expect(ci).toContain('sudo install -m 0755 /bin/true /usr/local/bin/caddy');
    expect(ci).toContain('npm audit --audit-level=high');
    expect(ci).toContain('npm audit --omit=dev --audit-level=high');
    expect(ci).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(ci).toMatch(/actions\/setup-node@[0-9a-f]{40}/);
    expect(ci).toMatch(/gitleaks\/gitleaks-action@[0-9a-f]{40}/);

    const release = read('.github/workflows/release.yml');
    expect(release).toContain('id-token: write');
    expect(release).toContain('npm@11.15.0');
    expect(release).toContain('npm audit --audit-level=high');
    expect(read('package.json')).toContain('check:release-version');
    expect(read('scripts/check-release-version.mjs')).toContain('server.json.packages[0].version');
    expect(release).toMatch(/actions\/checkout@[0-9a-f]{40}/);
    expect(release).toMatch(/actions\/setup-node@[0-9a-f]{40}/);

    const dockerignore = read('.dockerignore');
    expect(dockerignore).toContain('.env*');
    expect(dockerignore).toContain('!.env.example');
    expect(dockerignore).toContain('.remote.env*');
    expect(dockerignore).toContain('.mcp.json*');
    expect(dockerignore).toContain('*.pem');
  });

  it('keeps the service installer executable', () => {
    expect(statSync(resolve(root, 'deploy/install-services.sh')).mode & 0o111).not.toBe(0);
  });
});
