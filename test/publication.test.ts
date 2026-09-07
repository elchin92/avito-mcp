import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../scripts/check-publication.mjs');

function check(
  files: Record<string, string>,
  allowlist = ['dist/', 'docs/safety.md', 'README.md', '.env.example'],
  tracked = Object.keys(files),
  options: { npmCliFixture?: boolean; omitNpmExecPath?: boolean } = {},
) {
  const root = mkdtempSync(resolve(tmpdir(), 'avito-publication-test-'));
  try {
    const content: Record<string, string> = {
      'package.json': JSON.stringify({
        name: 'publication-fixture',
        version: '1.0.0',
        files: allowlist,
      }),
      'README.md': '# Public server\n',
      '.env.example': 'Client_id=your_client_id\n',
      'docs/safety.md': '# Confirm changes\nAn assistant must request confirmation.\n',
      'dist/server.js': 'export const version = "1.0.0";\n',
      'dist/manifest.json': '{}\n',
      ...files,
    };
    for (const [path, text] of Object.entries(content)) {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), text);
    }
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync(
      'git',
      ['add', 'package.json', 'README.md', '.env.example', 'docs/safety.md', ...tracked],
      { cwd: root },
    );
    const env = { ...process.env };
    if (options.omitNpmExecPath) delete env.npm_execpath;
    if (options.npmCliFixture) {
      // Spaces and '&' are valid on Windows. A shell invocation would split
      // this executable path; direct Node execution must preserve it and argv.
      const npmCli = resolve(root, 'npm path & fixture/npm-cli.js');
      mkdirSync(dirname(npmCli), { recursive: true });
      writeFileSync(
        npmCli,
        `const expected = ['pack', '--dry-run', '--ignore-scripts', '--json'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(23);
process.stdout.write(JSON.stringify([{ files: [{ path: 'README.md' }] }]));
`,
      );
      env.npm_execpath = npmCli;
    }
    return spawnSync(process.execPath, [script, root], { encoding: 'utf8', env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('publication boundaries', () => {
  it('executes the npm JavaScript entry point with an intact path and argument list', () => {
    const result = check({}, undefined, [], { npmCliFixture: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('1 npm files.');
    expect(result.stdout).toBe('');
  });

  it('finds npm when invoked directly without npm lifecycle variables', () => {
    const result = check({}, undefined, [], { omitNpmExecPath: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Publication check passed');
    expect(result.stdout).toBe('');
  });

  it('ships explicit public files and compiled code while excluding adjacent local notes', () => {
    const result = check(
      {
        'docs/conversation-2026-09-07.md': '# Local conversation\n',
        'docs/mcp-2026-07-28/spec-core.md': '# Research\n',
        'PROJECT_AUDIT.md': '# Local audit\n',
      },
      undefined,
      [],
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('Publication check passed');
    expect(result.stdout).toBe('');
  });

  it('rejects a broad Markdown glob that would publish an untracked conversation', () => {
    const result = check(
      { 'docs/conversation-2026-09-07.md': '# Local conversation\n' },
      ['dist/', 'docs/*.md'],
      [],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected an explicit relative file');
    expect(result.stderr).toContain('private/local path docs/conversation-2026-09-07.md');
  });

  it('rejects a tracked conversation even when npm would exclude it', () => {
    const result = check({ 'conversations/session.md': '# Local conversation\n' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Git: private/local path conversations/session.md');
  });

  it('rejects conversation acknowledgements inside an otherwise public ADR', () => {
    const result = check({
      'docs/adr/0001-decision.md':
        '# Decision\n## Owner acknowledgement\nRecorded from a conversation.\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('conversation acknowledgement in docs/adr/0001-decision.md');
  });

  it('rejects state and notes accidentally copied into compiled output', () => {
    const result = check(
      { 'dist/server.log': 'local log\n', 'dist/notes.md': '# Local note\n' },
      undefined,
      [],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private/local path dist/server.log');
    expect(result.stderr).toContain('outside the publication allowlist: dist/notes.md');
  });

  it('rejects a private file even if it is explicitly listed for publication', () => {
    const result = check({ '.env': 'Client_id=local_fixture\n' }, ['dist/', '.env']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private/local path .env');
  });
});
