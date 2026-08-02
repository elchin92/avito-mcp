/**
 * M6.8 acceptance: the rollback criteria are measurable, and the document that
 * states them is re-derived from this repository rather than believed.
 *
 * A rollback runbook is the one document nobody reads until the worst possible
 * moment, which is also the moment at which discovering that it cites a log
 * field the server stopped writing costs the most. Every other guard in this
 * suite exists because a claim about the repository rots silently;
 * `docs/adr/0007-rollback-criteria.md` is nothing BUT claims about the
 * repository — that a message is logged, that a field is on it, that a status
 * set is what a recorded 1.3.3 answered, that two services share one symlink —
 * and it has no test of its own to rot against.
 *
 * So this file re-derives them:
 *
 *   • every criterion carries a NUMBER, a window and its own command — the
 *     three columns whose absence is what made §7.3 of the plan unusable and
 *     what M6.8 was written to fix;
 *   • every pino `msg` the commands select on is a message literal in `src/`,
 *     and every field named next to it appears in the SAME logger call — this
 *     is the assertion that answers "не выдумывай метрики, которых нет", and it
 *     goes red on a rename rather than on an incident;
 *   • the statuses the document calls "what the 1.3.3 wire produced" are
 *     recomputed from `test/baselines/legacy-1.3.3-wire.json`, so R1's
 *     allow-list cannot drift away from the bench that recorded it;
 *   • the release-rollback procedure names BOTH services that execute from
 *     `/opt/avito-mcp/current`, because `deploy/install-services.sh` knows only
 *     one of them and a procedure copied from the installer would restart half
 *     the deployment;
 *   • the instrument the commands parse is actually enabled in the deployment
 *     example, with the two directives that stop Caddy's default logger from
 *     sampling the access log away.
 *
 * What it deliberately does NOT assert: that the thresholds are the right
 * numbers. No test can know that. It asserts that a number is there, that it is
 * computed from something this deployment writes, and that the command written
 * next to it names that thing.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

const DOC = 'docs/adr/0007-rollback-criteria.md';
const BASELINE = 'test/baselines/legacy-1.3.3-wire.json';
const CADDYFILE = 'deploy/Caddyfile.example';

const runbook = read(DOC);

/** The `msg` Caddy stamps on an access-log entry; not one of ours. */
const PROXY_MESSAGE = 'handled request';

interface Section {
  id: string;
  title: string;
  body: string;
}

/** `### R3 — any 5xx on /mcp, on either leg`, up to the next heading. */
function criteria(markdown: string): Section[] {
  const found: Section[] = [];
  const headings = [...markdown.matchAll(/^### (R\d+) — (.+)$/gm)];
  for (const [index, heading] of headings.entries()) {
    const from = heading.index! + heading[0].length;
    const next = headings[index + 1];
    const to =
      next !== undefined
        ? next.index!
        : (markdown.slice(from).search(/^## /m) + from + 1 || markdown.length);
    found.push({ id: heading[1]!, title: heading[2]!, body: markdown.slice(from, to) });
  }
  return found;
}

/** Every fenced block, whatever its language tag. */
function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]!);
}

interface LoggedLine {
  message: string;
  fields: string[];
  file: string;
}

/**
 * The «what this deployment logs» table of §1: `msg` | fields | source file.
 * Only rows whose first cell is a backticked string and whose third cell is a
 * backticked path under `src/` are taken, so the prose tables around it (the
 * §5 verdicts, the §7 observation form) are skipped without a marker.
 */
function loggedLines(markdown: string): LoggedLine[] {
  const rows: LoggedLine[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 3) continue;
    const message = /^`([^`]+)`$/.exec(cells[0]!)?.[1];
    const file = /^`(src\/[\w./-]+)`$/.exec(cells[2]!)?.[1];
    if (message === undefined || file === undefined) continue;
    rows.push({
      message,
      fields: [...cells[1]!.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((match) => match[1]!),
      file,
    });
  }
  return rows;
}

/**
 * The text of the `logger.<level>(…)` call that ends in `literal`, so a field
 * is checked against ITS OWN call site rather than against the whole file. A
 * fixed-width window would pass on any field mentioned anywhere nearby, which
 * on `src/http/mcp-http.ts` is most of them.
 */
function callSiteOf(source: string, literal: string): string | undefined {
  const quoted = [`'${literal}'`, `"${literal}"`];
  for (const needle of quoted) {
    const at = source.indexOf(needle);
    if (at === -1) continue;
    const opens = source.lastIndexOf('logger.', at);
    if (opens === -1) return undefined;
    return source.slice(opens, at + needle.length);
  }
  return undefined;
}

/** Every `.msg == "…"` a command in the runbook selects on. */
function selectedMessages(markdown: string): string[] {
  const found = new Set<string>();
  for (const block of fencedBlocks(markdown)) {
    for (const match of block.matchAll(/\.msg\s*==\s*"([^"]+)"/g)) found.add(match[1]!);
  }
  return [...found];
}

/** The HTTP statuses a real 1.3.3 answered across the recorded 42-step plan. */
function recordedLegacyStatuses(): number[] {
  const baseline = JSON.parse(read(BASELINE)) as {
    steps: Record<string, { status: number }>;
  };
  return [...new Set(Object.values(baseline.steps).map((step) => step.status))].sort(
    (left, right) => left - right,
  );
}

const sections = criteria(runbook);
const table = loggedLines(runbook);

describe('M6.8 — the rollback criteria are checkable, not merely written', () => {
  it('states a criterion for every level of the observation it defines', () => {
    // A floor, so that deleting the criteria to make the rest of this file pass
    // is not an available move.
    expect(sections.map((section) => section.id)).toEqual([
      'R1',
      'R2',
      'R3',
      'R4',
      'R5',
      'R6',
      'R7',
    ]);
  });

  it('gives every criterion a numeric threshold, an observation window and a command', () => {
    // The three columns §7.3 of the plan did not have, and the reason a
    // criterion phrased as "if the error rate grows" cannot be acted on.
    const incomplete: string[] = [];
    for (const section of sections) {
      const trigger = /^- \*\*Trigger:\*\*([\s\S]*?)(?=\n- \*\*|\n```|\n$)/m.exec(section.body);
      if (trigger === null) incomplete.push(`${section.id}: no **Trigger:**`);
      else if (!/\d/.test(trigger[1]!))
        incomplete.push(`${section.id}: the trigger carries no number`);
      if (!/^- \*\*Window:\*\*/m.test(section.body)) incomplete.push(`${section.id}: no **Window:**`);
      if (!/^- \*\*Rollback level:\*\*/m.test(section.body))
        incomplete.push(`${section.id}: no **Rollback level:**`);
      if (fencedBlocks(section.body).length === 0)
        incomplete.push(`${section.id}: no command to compute it with`);
    }
    expect(incomplete).toEqual([]);
  });

  it('selects only log messages this server actually emits', () => {
    // THE assertion this file exists for. A command that greps for a message
    // string nobody writes returns zero rows, and zero rows is what a healthy
    // deployment also returns — so the criterion reads green forever and the
    // failure it was written to catch goes unseen.
    const missing: string[] = [];
    for (const row of table) {
      expect(existsSync(join(root, row.file)), `${row.file} does not exist`).toBe(true);
      const site = callSiteOf(read(row.file), row.message);
      if (site === undefined) missing.push(`"${row.message}" is not logged by ${row.file}`);
    }
    expect(missing).toEqual([]);
  });

  it('selects only log fields this server actually writes, on the line it claims', () => {
    const missing: string[] = [];
    for (const row of table) {
      const site = callSiteOf(read(row.file), row.message);
      if (site === undefined) continue;
      expect(row.fields.length, `"${row.message}" is listed with no field`).toBeGreaterThan(0);
      for (const field of row.fields) {
        if (!new RegExp(`\\b${field}\\b`).test(site))
          missing.push(`"${row.message}" does not carry ${field} in ${row.file}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('reads no message that the table of logged lines does not account for', () => {
    // The other direction: a command may select on a message only if the table
    // has re-derived it from `src/`. The proxy's own message is the single
    // exemption, and it is named rather than pattern-matched.
    const accounted = new Set([...table.map((row) => row.message), PROXY_MESSAGE]);
    const unaccounted = selectedMessages(runbook).filter((message) => !accounted.has(message));
    expect(unaccounted).toEqual([]);
  });

  it('bounds the legacy status set by what the recorded 1.3.3 wire answered', () => {
    // R1's allow-list is the one threshold in the document that is not a
    // judgement call: it is a property of a recorded artifact. Recomputing it
    // here means a probe added to the bench that draws a sixth status turns
    // this red instead of turning R1 into a false alarm generator.
    const recorded = recordedLegacyStatuses();
    expect(recorded.length).toBeGreaterThan(3);
    expect(runbook).toContain(`**${recorded.join(', ')}**`);

    const r1 = sections.find((section) => section.id === 'R1')!;
    const allowed = /\[([\d, ]+)\]\s*\|\s*index\(\.status\)/.exec(r1.body);
    expect(allowed, 'R1 does not filter on an explicit status allow-list').not.toBeNull();
    const list = allowed![1]!.split(',').map((value) => Number(value.trim()));
    // Everything the bench recorded must be tolerated, or R1 fires on traffic
    // 1.3.3 itself produced.
    for (const status of recorded) expect(list, `R1 would fire on ${status}`).toContain(status);
    // And nothing may be tolerated without being either recorded or explained
    // in the prose above the command.
    for (const status of list) {
      if (recorded.includes(status)) continue;
      expect(r1.body, `R1 tolerates ${status} without saying why`).toMatch(
        new RegExp(`\\*\\*${status}\\*\\*`),
      );
    }
  });

  it('names both services that run from the shared release symlink', () => {
    // `deploy/install-services.sh` manages avito-mcp.service and caddy.service
    // and has never heard of avito-mcp-mondigo.service — which executes the
    // same /opt/avito-mcp/current/dist/server.js. A release rollback that
    // restarts only the unit the installer knows leaves the two halves of the
    // deployment on different code.
    const installer = read('deploy/install-services.sh');
    expect(installer).not.toContain('avito-mcp-mondigo');

    const level2 = /^### 6\.2 [\s\S]*?(?=\n### |\n## )/m.exec(runbook)?.[0] ?? '';
    expect(level2, 'the release rollback has no §6.2 section').not.toBe('');
    for (const unit of ['avito-mcp.service', 'avito-mcp-mondigo.service']) {
      expect(level2, `§6.2 never restarts ${unit}`).toContain(`systemctl restart ${unit}`);
    }
    expect(level2).toContain('/proc/$pid/cwd');
  });

  it('rolls the era back with the variable and the value the code parses', () => {
    const config = read('src/config.ts');
    expect(config).toContain('AVITO_MCP_PROTOCOL_ERA');
    expect(config).toMatch(/z\.enum\(\['legacy', 'dual', 'modern'\]\)\.default\('legacy'\)/);

    const level1 = /^### 6\.1 [\s\S]*?(?=\n### |\n## )/m.exec(runbook)?.[0] ?? '';
    expect(level1, 'the era rollback has no §6.1 section').not.toBe('');
    expect(level1).toContain('AVITO_MCP_PROTOCOL_ERA');
    expect(level1).toContain('/etc/avito-mcp/avito-mcp.env');
    expect(level1).toContain('systemctl restart avito-mcp.service');
    // Verification on the process, not on the file: the file states what the
    // NEXT start will read.
    expect(level1).toContain('/proc/$pid/environ');
  });

  it('ships the access log its commands parse, unsampled, in the deployment example', () => {
    // Caddy's shared default logger drops entries under light load (30 requests
    // → 3 lines, measured on v2.11.3), so a bare `log` would leave every ratio
    // and percentile in the document computed over a sample nobody chose.
    const caddyfile = read(CADDYFILE);
    const block = /log\s*\{([\s\S]*?)\}/.exec(caddyfile);
    expect(block, `${CADDYFILE} enables no access log`).not.toBeNull();
    expect(block![1]).toContain('output stderr');
    expect(block![1]).toContain('format json');

    // And the commands must read it from where that block sends it.
    expect(runbook).toContain('journalctl -u caddy');
  });

  it('accounts for every criterion of the plan it did not keep', () => {
    // M6.8's own rule: a criterion that cannot be computed is either given an
    // instrument or struck off — never left on the list unmeasured. Four of the
    // six were struck off or rewritten, and the accounting is the deliverable.
    const dropped = /^## 5\. [\s\S]*?(?=\n## )/m.exec(runbook)?.[0] ?? '';
    expect(dropped, 'the document accounts for nothing it dropped').not.toBe('');
    const verdicts = dropped
      .split('\n')
      .filter((line) => line.startsWith('|') && /\*\*(Kept|Replaced|Removed)/.test(line));
    expect(verdicts.length, 'fewer verdicts than the plan has criteria').toBeGreaterThanOrEqual(6);
    // The one that is removed rather than replaced has to name where it went.
    expect(dropped).toContain('M1.15');
  });

  it('does not present an observation window it has not run', () => {
    // The failure this pins: a runbook that quietly reads as complete because
    // the section meant to hold seven days of readings is a table nobody
    // filled. While it is empty it must say so, in the section that lists what
    // is still open.
    const outstanding = /^## 8\. [\s\S]*/m.exec(runbook)?.[0] ?? '';
    expect(outstanding, 'the document closes without saying what it left open').not.toBe('');
    expect(outstanding).toMatch(/M7\.7/);
    expect(outstanding).toMatch(/M7\.8/);
  });
});
