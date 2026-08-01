/**
 * The shape of a failure, on both eras, side by side.
 *
 * `test/legacy-wire-regression.test.ts` proves the LEGACY leg answers what
 * 1.3.3 answered. It cannot say anything about the modern leg, and that is the
 * half where the interesting risk lives: the cheapest way to make the legacy
 * bench green is to drag 1.3.3's shapes onto the 2026 wire as well, which would
 * be a regression dressed up as a fix. Revision 2026-07-28 has opinions here —
 * `resources/read` on a missing URI is `-32602` WITH `data.uri`, and it forbids
 * the `-32002` that used to carry that meaning — and a `MCP error -32602: `
 * prefix inside `error.message` is an SDK v1 artefact that has no business on a
 * new wire.
 *
 * So every case below is asserted TWICE against one `dual` deployment: what the
 * 2025 client gets, what the 2026 client gets, and — where they differ — that
 * they differ. One rig, one process, two eras, so nothing can pass by testing
 * two differently-configured servers.
 *
 * The one case that is NOT an era difference is the reflected URI: a caller's
 * raw `../../` never comes back on either wire. That is a security property,
 * not a compatibility one, so it is asserted as an equality between the eras.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  closeRigs,
  errorOf,
  initializeMessage,
  legacyPost,
  modernPost,
  resultOf,
  startRig,
  type Answer,
  type Rig,
} from './support/modern-rig.js';
import { displayableResourceUri } from '../src/core/wire-errors.js';

afterEach(closeRigs);

/** Opens a 2025 session and returns its id. */
async function openLegacySession(rig: Rig): Promise<string> {
  const init = await legacyPost(rig, initializeMessage());
  const sid = init.sessionId;
  expect(sid).toBeTruthy();
  await legacyPost(rig, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  return sid!;
}

/** A 2025-era request on an open session. */
async function legacyCall(
  rig: Rig,
  sid: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Answer> {
  return legacyPost(rig, { jsonrpc: '2.0', id: 'probe', method, params }, sid);
}

/** The single text block of a tool-error result, or `undefined`. */
function toolErrorText(answer: Answer): string | undefined {
  const result = resultOf(answer);
  if (result?.isError !== true) return undefined;
  const content = result.content as Array<{ type?: string; text?: string }> | undefined;
  return content?.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined;
}

const TRAVERSAL_URI = 'avito://swaggers/../../etc/passwd';
/** What `URL` normalisation collapses the traversal attempt to. */
const TRAVERSAL_NORMALISED = 'avito://swaggers/etc/passwd';

describe('the URI a resources/read failure reflects', () => {
  it('is the normalised form, never the caller’s raw path, on either era', async () => {
    const rig = await startRig('dual');
    const sid = await openLegacySession(rig);

    const legacy = await legacyCall(rig, sid, 'resources/read', { uri: TRAVERSAL_URI });
    const modern = await modernPost(rig, 'resources/read', { uri: TRAVERSAL_URI });

    // The regression: SDK v2 throws `new ResourceNotFoundError(request.params.uri)`
    // — the RAW string — where v1 interpolated the parsed `URL`. Traversal
    // segments came back to the caller verbatim, into their logs and their UI.
    for (const answer of [legacy, modern]) {
      const rendered = JSON.stringify(answer.body);
      expect(rendered).not.toContain('..');
      expect(rendered).toContain(TRAVERSAL_NORMALISED);
    }

    // And the modern era's machine-readable half carries the same normalised
    // value, not just the prose.
    expect((errorOf(modern)!.data as { uri?: string }).uri).toBe(TRAVERSAL_NORMALISED);
  }, 30_000);

  it('bounds and sweeps a URI that does not parse at all', () => {
    // The unparseable branch cannot be normalised, so it is the one where a
    // sweep matters: `URL` percent-encodes control characters, a non-URI does
    // not go through `URL` at all.
    // Written as escapes on purpose: a literal NUL in a source file makes git
    // treat it as binary, and a test nobody can read in a diff is not review.
    expect(displayableResourceUri('not a uri\u0000\u001b[2J')).toBe('not a uri[2J');
    const huge = `avito://${'a'.repeat(1000)}`;
    expect(displayableResourceUri(huge).length).toBeLessThanOrEqual(201);
  });
});

describe('resources/read on an unregistered URI', () => {
  it('answers 1.3.3’s wording on the 2025 wire and the revision’s shape on the 2026 one', async () => {
    const rig = await startRig('dual');
    const sid = await openLegacySession(rig);

    const legacy = errorOf(await legacyCall(rig, sid, 'resources/read', { uri: 'avito://nope' }))!;
    const modern = errorOf(await modernPost(rig, 'resources/read', { uri: 'avito://nope' }))!;

    // Same condition, same code — everything else is era.
    expect(legacy.code).toBe(-32602);
    expect(modern.code).toBe(-32602);

    // 2025: v1's `McpError` wording, including the prefix its constructor put
    // in front of every message, and no `data` (v1 never attached one).
    expect(legacy.message).toBe('MCP error -32602: Resource avito://nope not found');
    expect(legacy.data).toBeUndefined();

    // 2026: `ResourceNotFoundError`. The revision reassigns "resource not
    // found" to -32602 (it forbids the -32002 that used to mean it) and pairs
    // it with a machine-readable `data.uri` — a client should not have to parse
    // prose to learn which URI failed.
    expect(modern.message).toBe('Resource not found: avito://nope');
    expect(modern.data).toEqual({ uri: 'avito://nope' });

    // Stated as a difference, so "make the bench green by copying legacy onto
    // the modern wire" cannot pass.
    expect(modern.message).not.toBe(legacy.message);
    expect(modern.message).not.toContain('MCP error');
  }, 30_000);
});

describe('tools/call naming a tool that does not exist', () => {
  it('is tool output on the 2025 wire and a JSON-RPC error on the 2026 one', async () => {
    const rig = await startRig('dual');
    const sid = await openLegacySession(rig);

    const legacy = await legacyCall(rig, sid, 'tools/call', {
      name: 'no_such_tool',
      arguments: {},
    });
    const modern = await modernPost(rig, 'tools/call', { name: 'no_such_tool', arguments: {} });

    // 2025, verbatim 1.3.3: v1 raised the lookup failure inside its own try, so
    // the client received a RESULT it could read and act on. The difference is
    // not cosmetic — an SDK client turns a JSON-RPC error into a thrown
    // McpError, so the same agent that used to pick another tool now takes an
    // exception.
    expect(errorOf(legacy)).toBeUndefined();
    expect(toolErrorText(legacy)).toBe('MCP error -32602: Tool no_such_tool not found');

    // 2026: the SDK's shape. Nothing in revision 2026-07-28 asks for the v1
    // in-band form, and `isError` is documented as the channel for a tool that
    // RAN and failed — "you named something that does not exist" is a protocol
    // error about the request.
    expect(resultOf(modern)).toBeUndefined();
    expect(errorOf(modern)!.code).toBe(-32602);
    expect(errorOf(modern)!.message).toBe('Tool no_such_tool not found');
  }, 30_000);
});

describe('tools/call whose arguments fail validation', () => {
  it('renders 1.3.3’s issue dump on the 2025 wire and the readable v2 line on the 2026 one', async () => {
    const rig = await startRig('dual');
    const sid = await openLegacySession(rig);

    const legacy = await legacyCall(rig, sid, 'tools/call', {
      name: 'meta_confirm_action',
      arguments: {},
    });
    const modern = await modernPost(rig, 'tools/call', {
      name: 'meta_confirm_action',
      arguments: {},
    });

    // Both eras answer in band — that part never changed.
    const legacyText = toolErrorText(legacy)!;
    const modernText = toolErrorText(modern)!;

    // 2025: the prefix v1's McpError added, and the pretty-printed zod issue
    // ARRAY that v1's `getParseErrorMessage` produced by reading `ZodError.message`.
    expect(legacyText).toMatch(
      /^MCP error -32602: Input validation error: Invalid arguments for tool meta_confirm_action: \[/,
    );
    expect(legacyText).toContain('"code": "invalid_type"');
    expect(legacyText).toContain('"confirmation_id"');

    // 2026: the SDK v2 rendering — one line naming the field. Strictly better
    // for the model that has to act on it, and nothing in the revision asks for
    // the JSON dump, so the modern wire keeps it.
    expect(modernText).toBe(
      'Input validation error: Invalid arguments for tool meta_confirm_action: ' +
        'confirmation_id: Invalid input: expected string, received undefined',
    );
    expect(modernText).not.toContain('MCP error');
    expect(modernText).not.toContain('"code": "invalid_type"');
  }, 30_000);
});

describe('prompts/get naming a prompt that does not exist', () => {
  it('carries v1’s message prefix on the 2025 wire and not on the 2026 one', async () => {
    const rig = await startRig('dual');
    const sid = await openLegacySession(rig);

    const legacy = errorOf(
      await legacyCall(rig, sid, 'prompts/get', { name: 'no_such_prompt', arguments: {} }),
    )!;
    const modern = errorOf(
      await modernPost(rig, 'prompts/get', { name: 'no_such_prompt', arguments: {} }),
    )!;

    expect(legacy.code).toBe(-32602);
    expect(legacy.message).toBe('MCP error -32602: Prompt no_such_prompt not found');

    expect(modern.code).toBe(-32602);
    expect(modern.message).toBe('Prompt no_such_prompt not found');
  }, 30_000);
});

describe('resources/read whose uri does not parse', () => {
  it('is the engine’s own -32603 on the 2025 wire and the revision’s -32602 on the 2026 one', async () => {
    const rig = await startRig('dual');
    const sid = await openLegacySession(rig);

    const legacy = errorOf(await legacyCall(rig, sid, 'resources/read', { uri: 'not a uri' }))!;
    const modern = errorOf(await modernPost(rig, 'resources/read', { uri: 'not a uri' }))!;

    // 2025 had no branch for this at all: `new URL(...)` threw and the protocol
    // turned the TypeError into an internal error. Reproduced rather than
    // improved, because a 2025 client is entitled to the answer it had.
    expect(legacy.code).toBe(-32603);
    expect(legacy.message).toBe('Invalid URL');
    expect(legacy.data).toBeUndefined();

    // 2026: a malformed parameter is `-32602`, with the reason machine-readable.
    expect(modern.code).toBe(-32602);
    expect(modern.data).toMatchObject({ reason: 'invalid_uri' });
  }, 30_000);
});

describe('prompts/get with a required argument missing', () => {
  it('renders 1.3.3’s issue dump on the 2025 wire and the readable v2 line on the 2026 one', async () => {
    const rig = await startRig('dual');
    const sid = await openLegacySession(rig);

    const legacy = errorOf(
      await legacyCall(rig, sid, 'prompts/get', { name: 'avito_explain_tool', arguments: {} }),
    )!;
    const modern = errorOf(
      await modernPost(rig, 'prompts/get', { name: 'avito_explain_tool', arguments: {} }),
    )!;

    // Prompts run through the same validator as tools, so they inherited the
    // same two changes — and the same era split.
    expect(legacy.message).toMatch(
      /^MCP error -32602: Invalid arguments for prompt avito_explain_tool: \[/,
    );
    expect(legacy.message).toContain('"code": "invalid_type"');

    expect(modern.message).toBe(
      'Invalid arguments for prompt avito_explain_tool: ' +
        'tool_name: Invalid input: expected string, received undefined',
    );
  }, 30_000);
});

describe('the prefix restoration is scoped to errors the SDK raises', () => {
  it('leaves an unknown METHOD unprefixed, exactly as 1.3.3 did', async () => {
    // The prefix came from `McpError`'s constructor, so only errors THROWN by a
    // handler carried it. "Method not found" is built by the protocol itself,
    // never as an McpError — 1.3.3 answered a bare `Method not found`, and a
    // blanket prefix at the transport would have broken that. This is the test
    // that keeps the restoration honest rather than enthusiastic.
    const rig = await startRig('dual');
    const sid = await openLegacySession(rig);
    const legacy = errorOf(await legacyCall(rig, sid, 'no_such/method', {}))!;
    expect(legacy.code).toBe(-32601);
    expect(legacy.message).toBe('Method not found');
  }, 30_000);
});
