/**
 * M6.7 — verification against an INDEPENDENT client implementation.
 *
 * Every other conformance test in this repository is written by the same hand
 * as the server, against the same reading of the same corpus. That answers
 * "does the server do what we think the revision says" and cannot answer "is
 * what we think the revision says what a real client expects". The plan names
 * three acceptable answers to the second question; this file is the second of
 * them — «клиент на `@modelcontextprotocol/client@2` с `versionNegotiation` в
 * modern-режиме».
 *
 * WHY THIS COUNTS AS INDEPENDENT. `@modelcontextprotocol/client` is a separate
 * package from the `@modelcontextprotocol/server` this server is built on,
 * published by the specification's own maintainers, and it does not share our
 * request-building code: it mints the `_meta` envelope, the SEP-2243 mirrored
 * headers and the `server/discover` probe itself, then validates every result
 * against the spec's own schemas before handing it back. A shape we got wrong
 * fails inside the client, not inside an assertion we wrote.
 *
 * WHY IT IS NOT SUFFICIENT ON ITS OWN. It is still the same organisation's
 * reading of the same document, and — unlike a host application such as MCP
 * Inspector or Claude Desktop — it exercises no UI expectations. The remaining
 * gap is recorded in `docs/conformance.md`, section «Внешняя верификация».
 *
 * Source: `docs/mcp-2026-07-28/sdk-typescript-2.md` (client-side negotiation),
 * `docs/mcp-2026-07-28/guides-3.md` (conformance checking).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
  UnsupportedProtocolVersionError,
} from '@modelcontextprotocol/client';

import {
  MODERN_REVISION,
  LEGACY_REVISION,
  closeRigs,
  startRig,
  type Rig,
} from '../support/modern-rig.js';

const open = async (rig: Rig, pin?: string): Promise<Client> => {
  const client = new Client(
    { name: 'avito-mcp-conformance-client', version: '1.0.0' },
    {
      capabilities: {},
      ...(pin ? { versionNegotiation: { mode: { pin } } } : {}),
    },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${rig.base}/mcp`)));
  return client;
};

afterEach(closeRigs);

describe('M6.7 — the official v2 client, pinned to 2026-07-28', () => {
  it('completes the modern connect sequence against a dual server', async () => {
    // The pin makes `connect()` demand that the connect-time `server/discover`
    // OFFERS 2026-07-28 — no fallback, no negotiation down. So this single line
    // exercises §1.2.A1 end to end through code we did not write.
    const rig = await startRig('dual');
    const client = await open(rig, MODERN_REVISION);
    expect(client.getServerVersion()?.name).toBe('avito-mcp');
    await client.close();
  }, 30_000);

  it('reads the whole primitive surface through the client’s own validators', async () => {
    const rig = await startRig('dual');
    const client = await open(rig, MODERN_REVISION);
    try {
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(100);

      const called = await client.callTool({ name: 'meta_capabilities', arguments: {} });
      expect(called.structuredContent).toBeTypeOf('object');

      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri)).toContain('avito://docs/safety');

      const read = await client.readResource({ uri: 'avito://docs/safety' });
      expect(read.contents.length).toBeGreaterThan(0);

      const prompts = await client.listPrompts();
      expect(prompts.prompts.length).toBeGreaterThan(0);
      const rendered = await client.getPrompt({ name: 'avito_safety_report', arguments: {} });
      expect(rendered.messages.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('is told the honoured subset of a listen filter, not the one it asked for', async () => {
    // The same narrowing `test/modern-hardening.test.ts` asserts on the wire,
    // observed here through the client's own subscription object: a URI this
    // server never publishes for is absent from `honoredFilter`, so an
    // independent client learns not to wait for it.
    const rig = await startRig('dual');
    const client = await open(rig, MODERN_REVISION);
    try {
      const subscription = await client.listen({
        resourceSubscriptions: ['avito://state/pending-actions', 'file:///etc/passwd'],
      });
      expect(subscription.honoredFilter).toEqual({
        resourceSubscriptions: ['avito://state/pending-actions'],
      });
      await subscription.close();
    } finally {
      await client.close();
    }
  }, 30_000);

  it('is refused with a typed -32022 when it pins a revision we do not serve', async () => {
    const rig = await startRig('dual');
    const client = new Client(
      { name: 'avito-mcp-conformance-client', version: '1.0.0' },
      { capabilities: {}, versionNegotiation: { mode: { pin: '2027-01-01' } } },
    );
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(`${rig.base}/mcp`))),
    ).rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
  }, 30_000);

  it('serves the SAME client in its default legacy mode on the same endpoint', async () => {
    // Block B from the other side: the compatibility promise is not "an old
    // client still works" in the abstract, it is "this exact client, with the
    // option left at its default, still works".
    const rig = await startRig('dual');
    const client = await open(rig);
    try {
      expect(client.getServerVersion()?.version).toBeTypeOf('string');
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(100);
      // The legacy leg negotiated the 2025 revision, so nothing from the modern
      // envelope may appear on it.
      expect(JSON.stringify(tools)).not.toContain(MODERN_REVISION);
      expect(LEGACY_REVISION).toBe('2025-11-25');
    } finally {
      await client.close();
    }
  }, 30_000);
});
