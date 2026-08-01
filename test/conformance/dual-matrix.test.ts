/**
 * Block C of the plan's §1.2 — "key integration suites run in BOTH eras".
 *
 * Everything in this file is written once and executed twice, once per era,
 * through `test/support/era-matrix.ts`. That is the whole design constraint:
 * the plan asks for a dual matrix, and a dual matrix built by copying a suite
 * and search-replacing the transport decays within one release — the copies
 * drift, and the drift is invisible because both halves stay green.
 *
 * WHAT IS BEING PROVED. Not the protocol shape (that is `modern-conformance` /
 * `modern-runtime`), but that the FEATURES this server exists for — the safety
 * two-step, tools, prompts, resources, structured output, the meta tools —
 * behave identically no matter which era the client speaks. The migration's
 * failure mode is exactly the opposite: a modern leg that answers protocol
 * questions beautifully and mishandles a confirmation because that path was
 * only ever exercised through `InMemoryTransport`.
 *
 * WHY EVERY SESSION IS OPENED ON A `dual` SERVER. Both legs are served by one
 * process on one endpoint here, so a shared-state defect (a confirmation minted
 * on one leg and invisible on the other, a rate-limiter keyed by session) shows
 * up as a failure rather than as two independently green fixtures.
 *
 * Sources: `docs/mcp-2026-07-28/versioning.md` (dual-era servers),
 * `docs/mcp-2026-07-28/spec-core.md` (per-request envelope, `resultType`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  ERAS,
  ERA_TRAITS,
  closeRigs,
  errorOf,
  jsonOf,
  openEraSession,
  openEraSessionOn,
  resultOf,
  stubAvitoFetch,
  textOf,
  type EraName,
  type EraSession,
} from '../support/era-matrix.js';
import { startRig } from '../support/modern-rig.js';

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeRigs();
});

describe.each(ERAS)('era=%s — the primitive surface', (era: EraName) => {
  const traits = ERA_TRAITS[era];

  it('lists tools with the era-appropriate result envelope', async () => {
    const session = await openEraSession(era);
    const answer = await session.call('tools/list');
    expect(answer.status).toBe(200);

    const result = resultOf(answer)!;
    const tools = result.tools as Array<{ name: string; inputSchema: unknown }>;
    expect(tools.length).toBeGreaterThan(100);
    expect(tools.map((tool) => tool.name)).toContain('meta_health');
    for (const tool of tools.slice(0, 5)) expect(tool.inputSchema).toBeTypeOf('object');

    // The era delta, read from the trait table rather than branched on inline.
    expect(result.resultType).toBe(traits.resultType);
    expect('ttlMs' in result).toBe(traits.cacheHints);
    expect('cacheScope' in result).toBe(traits.cacheHints);
    expect(session.sessionId !== null).toBe(traits.sessions);
  });

  it('calls a read-only tool and returns the same payload shape', async () => {
    stubAvitoFetch();
    const session = await openEraSession(era);
    const answer = await session.callTool('meta_health', {});
    expect(answer.status).toBe(200);

    const result = resultOf(answer)!;
    expect(result.isError ?? false).toBe(false);
    const blocks = result.content as Array<{ type: string; text: string }>;
    expect(blocks[0]!.type).toBe('text');
    expect(result.resultType).toBe(traits.resultType);
  });

  it('honours a tool outputSchema with a matching structuredContent', async () => {
    // `meta_capabilities` is one of the three tools that declare an
    // `outputSchema`; the SDK validates the structured half against it before
    // it ever reaches the wire, so a mismatch surfaces here as an error result
    // rather than as a silently wrong body.
    stubAvitoFetch();
    const session = await openEraSession(era);
    const answer = await session.callTool('meta_capabilities', {});
    expect(answer.status).toBe(200);
    expect(resultOf(answer)!.isError ?? false).toBe(false);

    const structured = resultOf(answer)!.structuredContent as Record<string, unknown>;
    expect(structured).toBeTypeOf('object');
    expect(structured.mode).toBeTypeOf('string');
    expect(Array.isArray(structured.tools) || typeof structured.toolCount === 'number').toBe(true);
  });

  it('lists and renders prompts', async () => {
    const session = await openEraSession(era);
    const list = await session.call('prompts/list');
    const names = (resultOf(list)!.prompts as Array<{ name: string }>).map((p) => p.name);
    expect(names).toContain('avito_safety_report');
    expect(resultOf(list)!.resultType).toBe(traits.resultType);

    const got = await session.call('prompts/get', {
      name: 'avito_safety_report',
      arguments: {},
    });
    expect(got.status).toBe(200);
    const messages = resultOf(got)!.messages as Array<{ content: { text?: string } }>;
    expect(messages.length).toBeGreaterThan(0);
    expect((messages[0]!.content.text ?? '').length).toBeGreaterThan(0);
  });

  it('treats a blank required prompt argument identically on both eras', async () => {
    const session = await openEraSession(era);
    const answer = await session.call('prompts/get', {
      name: 'avito_explain_tool',
      arguments: { tool_name: '   ' },
    });
    // Today this renders a "tool_name is required" stub rather than answering
    // `-32602`, which plan task M1.8 calls a defect and intends to change. This
    // row does NOT bless that: it pins the behaviour to be the SAME on both
    // eras, which is the property the dual matrix owns. When M1.8 lands, this
    // test fails on both eras at once — which is the correct signal, and far
    // better than a disjunction that would have passed either way and proved
    // nothing about era parity.
    expect(errorOf(answer)).toBeUndefined();
    expect(resultOf(answer)!.description).toMatch(/required/i);
  });

  it('lists resources and reads one with non-empty contents', async () => {
    const session = await openEraSession(era);
    const list = await session.call('resources/list');
    const uris = (resultOf(list)!.resources as Array<{ uri: string }>).map((r) => r.uri);
    expect(uris).toContain('avito://docs/safety');

    const read = await session.call('resources/read', { uri: 'avito://docs/safety' });
    expect(read.status).toBe(200);
    const contents = resultOf(read)!.contents as Array<{ text?: string }>;
    expect(contents.length).toBeGreaterThan(0);
    expect(textOf(read).length).toBeGreaterThan(0);
    expect(resultOf(read)!.resultType).toBe(traits.resultType);
  });

  it('serves resource templates on both eras', async () => {
    const session = await openEraSession(era);
    const answer = await session.call('resources/templates/list');
    const templates = resultOf(answer)!.resourceTemplates as Array<{ uriTemplate: string }>;
    expect(templates.some((t) => t.uriTemplate.includes('avito://swaggers/'))).toBe(true);
    expect(resultOf(answer)!.resultType).toBe(traits.resultType);
  });
});

describe.each(ERAS)('era=%s — the safety two-step', (era: EraName) => {
  /**
   * The confirmation flow is the reason this server can be pointed at a
   * production account. It is also the flow with the most era-sensitive
   * dependency in the codebase: the caller identity it meters and stamps used
   * to be derived from the MCP session id, and the modern era HAS no session
   * id. Running it on both legs is what turns "we fixed that" into a standing
   * guarantee. (§1.2 D, plan M1.2.)
   */
  it('parks a money tool as a pending action instead of executing it', async () => {
    const upstream = stubAvitoFetch();
    const session = await openEraSession(era);
    const answer = await session.callTool('items_put_item_vas', {
      item_id: 123,
      vas_id: 'highlight',
    });
    expect(answer.status).toBe(200);

    const payload = jsonOf(answer)!;
    expect(payload.confirmation_id).toBeTypeOf('string');
    // Nothing was charged: the only outbound call a parked action may make is
    // none at all.
    const upstreamCalls = upstream.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith('https://api.test.example'));
    expect(upstreamCalls).toEqual([]);
  });

  it('executes the parked action once meta_confirm_action presents the id', async () => {
    const upstream = stubAvitoFetch();
    const session = await openEraSession(era);
    const parked = jsonOf(
      await session.callTool('items_put_item_vas', { item_id: 123, vas_id: 'highlight' }),
    )!;
    const confirmationId = parked.confirmation_id as string;

    const confirmed = await session.callTool('meta_confirm_action', {
      confirmation_id: confirmationId,
    });
    expect(confirmed.status).toBe(200);
    expect(resultOf(confirmed)!.isError ?? false).toBe(false);

    const upstreamCalls = upstream.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith('https://api.test.example'));
    expect(upstreamCalls.some((url) => url.includes('/vas'))).toBe(true);
  });

  it('refuses to replay a confirmation id (one-shot on both eras)', async () => {
    stubAvitoFetch();
    const session = await openEraSession(era);
    const parked = jsonOf(
      await session.callTool('items_put_item_vas', { item_id: 123, vas_id: 'highlight' }),
    )!;
    const confirmationId = parked.confirmation_id as string;

    await session.callTool('meta_confirm_action', { confirmation_id: confirmationId });
    const replay = await session.callTool('meta_confirm_action', {
      confirmation_id: confirmationId,
    });
    // A replay must fail loudly rather than charge twice.
    const failed = (resultOf(replay)?.isError ?? false) || errorOf(replay) !== undefined;
    expect(failed).toBe(true);
  });

  it('lists the pending action it just minted', async () => {
    stubAvitoFetch();
    const session = await openEraSession(era);
    const parked = jsonOf(
      await session.callTool('items_put_item_vas', { item_id: 123, vas_id: 'highlight' }),
    )!;
    const listed = await session.callTool('meta_list_pending_actions', {});
    expect(textOf(listed)).toContain(parked.confirmation_id as string);
  });

  it('cancels a pending action so it can no longer be confirmed', async () => {
    const upstream = stubAvitoFetch();
    const session = await openEraSession(era);
    const parked = jsonOf(
      await session.callTool('items_put_item_vas', { item_id: 123, vas_id: 'highlight' }),
    )!;
    const confirmationId = parked.confirmation_id as string;

    await session.callTool('meta_cancel_action', { confirmation_id: confirmationId });
    const confirmed = await session.callTool('meta_confirm_action', {
      confirmation_id: confirmationId,
    });
    const failed = (resultOf(confirmed)?.isError ?? false) || errorOf(confirmed) !== undefined;
    expect(failed).toBe(true);
    const upstreamCalls = upstream.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes('/vas'));
    expect(upstreamCalls).toEqual([]);
  });

  it('keeps dryRun from touching the network on either era', async () => {
    // `dryRun` short-circuits BEFORE the confirmation two-step (it is a preview,
    // so there is nothing to approve) — which is precisely why it needs its own
    // dual-era cell: it is the one path through `defineTool` that neither the
    // parked-action nor the confirmed-action case above ever walks.
    const upstream = stubAvitoFetch();
    const session = await openEraSession(era);
    const answer = await session.callTool('items_put_item_vas', {
      item_id: 123,
      vas_id: 'highlight',
      dryRun: true,
    });
    expect(answer.status).toBe(200);
    expect(jsonOf(answer)).toMatchObject({ dryRun: true });
    const upstreamCalls = upstream.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith('https://api.test.example'));
    expect(upstreamCalls).toEqual([]);
  });
});

describe('the two legs are the same server, not two servers', () => {
  it('exposes one tool catalogue, in one order, to both eras', async () => {
    const rig = await startRig('dual');
    const legacy = await openEraSessionOn(rig, 'legacy');
    const modern = await openEraSessionOn(rig, 'modern');
    const names = async (session: EraSession): Promise<string[]> =>
      (resultOf(await session.call('tools/list'))!.tools as Array<{ name: string }>).map(
        (tool) => tool.name,
      );
    expect(await names(modern)).toEqual(await names(legacy));
  });

  it('confirms on the legacy leg what the modern leg parked, in one process', async () => {
    // The sharpest shared-state question the dual era raises. The confirmation
    // store is a per-process singleton; if either leg ever gets its own — or if
    // the caller identity a confirmation is stamped with goes back to being
    // derived from the MCP session id, which the modern era does not have —
    // this hand-off breaks and this test is what says so.
    const upstream = stubAvitoFetch();
    const rig = await startRig('dual');
    const modern = await openEraSessionOn(rig, 'modern');
    const legacy = await openEraSessionOn(rig, 'legacy');

    const parked = jsonOf(
      await modern.callTool('items_put_item_vas', { item_id: 123, vas_id: 'highlight' }),
    )!;
    const confirmationId = parked.confirmation_id as string;

    expect(textOf(await legacy.callTool('meta_list_pending_actions', {}))).toContain(
      confirmationId,
    );
    const confirmed = await legacy.callTool('meta_confirm_action', {
      confirmation_id: confirmationId,
    });
    expect(resultOf(confirmed)!.isError ?? false).toBe(false);
    expect(
      upstream.mock.calls.map((call) => String(call[0])).some((url) => url.includes('/vas')),
    ).toBe(true);
  });
});
