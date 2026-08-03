/**
 * M2 wire-compatibility shim.
 *
 * Stage M2 moves the project from `@modelcontextprotocol/sdk@1` onto the
 * `@modelcontextprotocol/*@2` package line WITHOUT changing the wire era: the
 * server must keep speaking revision `2025-11-25` and must look byte-identical
 * to 1.3.x for every client. v2 changed two `registerTool` defaults that leak
 * straight into `tools/list`, so this module pins both back to their v1 values.
 *
 * Both pins are scoped to the legacy era and are expected to be REMOVED at
 * M3/M4, when the server starts negotiating `2026-07-28` and the 2026 codec
 * owns these fields (`execution.taskSupport` is one of the fields that revision
 * deletes). Neither pin touches tool behaviour or validation — they only affect
 * what the tool descriptor looks like on the wire.
 *
 * The pins are installed once, on the McpServer instance, rather than at each
 * of the ten `registerTool` call sites: a missed call site would silently drift
 * the wire, and this way new domains inherit the pin for free.
 * `test/wire-conformance.test.ts` is the backstop that proves it worked.
 */
import type { McpServer, ProtocolEra, RegisteredTool } from '@modelcontextprotocol/server';

/**
 * The JSON Schema dialect that SDK v1 emitted for every tool `inputSchema` and
 * `outputSchema`.
 *
 * v1 converted zod through `zod/v4-mini`'s `toJSONSchema()` with the default
 * target, which is `draft-7`. v2 hard-codes its conversion target to
 * `draft-2020-12` (`JSON_SCHEMA_CONVERSION_TARGET` in
 * `@modelcontextprotocol/server`) and exposes no public option to change it.
 *
 * For this project's 148 schemas the two targets produce byte-identical bodies
 * — the ONLY difference is the `$schema` string. That one string is not
 * cosmetic: `dist/manifest.json`'s `schema_hash` is a SHA-256 over
 * `{name, risk, environment, inputSchema}` for every tool, and it is published
 * to consumers as `meta_capabilities.schemaHash`. Letting the dialect move
 * changes that hash and trips every consumer watching it for drift, in exchange
 * for no actual change in schema semantics.
 */
const LEGACY_JSON_SCHEMA_TARGET = 'draft-7';

/**
 * M3 item 15 — the JSON Schema dialect this server's tool schemas are written
 * in, stated once so it can be documented and asserted rather than inferred.
 *
 * Revision 2026-07-28 RELAXED `inputSchema`/`outputSchema` from the 2025 subset
 * to full JSON Schema 2020-12 (SEP-2106). Relaxed, not moved: the revision does
 * not require servers to emit 2020-12, and the 2026 `ToolSchema` accepts any
 * `$schema` string. So the choice is ours, and it is to keep draft-07 on BOTH
 * eras. Two reasons:
 *
 *   • `dist/manifest.json`'s `schema_hash` is a SHA-256 over every tool's
 *     `inputSchema`, published to consumers as `meta_capabilities.schemaHash`
 *     and pinned by `test/wire-conformance.test.ts`. Emitting one dialect on the
 *     modern wire and another in the manifest would make that hash describe
 *     schemas the running server does not serve — the exact "two construction
 *     sites" failure this migration keeps tripping over.
 *   • Nothing is gained. For these 148 schemas the two targets render
 *     byte-identical bodies apart from this string: no tool uses a keyword whose
 *     meaning differs between the drafts.
 *
 * `test/modern-runtime.test.ts` asserts that every schema on the modern wire
 * declares exactly this value — so the documentation cannot drift from what is
 * served, in either direction.
 */
export const TOOL_JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#';

/**
 * The `execution` descriptor SDK v1 stamped on every tool registered through
 * `registerTool()` (v1 `mcp.js` passed `{ taskSupport: 'forbidden' }`
 * literally). v2 passes `undefined` instead, so the field vanished from
 * `tools/list`. No tool in this project is task-augmented, so `'forbidden'`
 * stays the accurate value — this only keeps the field where 1.3.x put it.
 */
const LEGACY_TOOL_EXECUTION = { taskSupport: 'forbidden' } as const;

/**
 * Minimal view of the Standard Schema JSON-conversion hook
 * (`~standard.jsonSchema`, added in zod 4.2). The v2 SDK calls
 * `input({ target })` / `output({ target })` to render a schema for the wire,
 * so pinning means ignoring the target the SDK passes and substituting
 * {@link LEGACY_JSON_SCHEMA_TARGET}.
 */
interface JsonSchemaHook {
  input: (opts: { target: string }) => Record<string, unknown>;
  output: (opts: { target: string }) => Record<string, unknown>;
}

/** One Standard Schema issue, in the shape the SDK's `formatIssue` reads. */
interface StandardIssue {
  readonly message: string;
  readonly path?: readonly unknown[];
}
/** The Standard Schema validation result: a value, or the issues that refused it. */
interface StandardResult {
  readonly value?: unknown;
  readonly issues?: readonly StandardIssue[];
}
type StandardValidate = (value: unknown) => StandardResult | Promise<StandardResult>;

interface MaybeStandardSchema {
  '~standard'?: { jsonSchema?: JsonSchemaHook; validate?: StandardValidate };
}

/**
 * The exact text 1.3.x put in a failed `tools/call` answer, rebuilt from the
 * Standard Schema issues.
 *
 * SDK v1 rendered a validation failure through `getParseErrorMessage()`
 * (`server/zod-compat.js`), whose first branch is `if ('message' in error)
 * return error.message` — and a zod v4 `ZodError`'s `message` getter is
 * `JSON.stringify(this.issues, jsonStringifyReplacer, 2)`. So 1.3.x shipped the
 * pretty-printed ISSUE ARRAY to the client, keys and all:
 *
 *     Input validation error: Invalid arguments for tool meta_confirm_action: [
 *       {
 *         "expected": "string",
 *         ...
 *
 * v2 replaced that with `result.issues.map(formatIssue).join(', ')`
 * (`validateStandardSchema`), which renders the same failure as
 * `confirmation_id: Invalid input: expected string, received undefined`. The v2
 * rendering is better and stays on the modern era; this function exists only so
 * the LEGACY era keeps answering what 1.3.3 answered.
 *
 * `zod`'s own replacer is reproduced rather than imported — it is not exported —
 * and it does exactly one thing: `bigint` values are stringified, because
 * `JSON.stringify` throws on them.
 */
function renderIssuesAs133(issues: readonly StandardIssue[]): string {
  const replacer = (_key: string, value: unknown): unknown =>
    typeof value === 'bigint' ? value.toString() : value;
  return JSON.stringify(issues, replacer, 2);
}

/**
 * Pins one schema's FAILURE RENDERING to the text 1.3.x produced.
 *
 * The seam is the same as {@link pinSchemaDialect}: the schema's own
 * `~standard` hook, mutated in place. That is safe to do per era because every
 * `inputSchema:` in this codebase is a `z.object(...)` EXPRESSION evaluated
 * inside a registration function (`defineTool`, `registerMetaTools`,
 * `registerWebhookTools`), so each McpServer instance registers freshly-built
 * schema objects with their own `~standard` — a `dual` deployment's legacy and
 * modern instances never share one. (`~standard` is an own property of the zod
 * instance, not a shared prototype value; asserted in
 * `test/wire-conformance.test.ts`.)
 *
 * The success path returns the SDK's own result object untouched, so
 * `parseResult.data` — the arguments every tool handler receives — is exactly
 * what it would have been.
 */
function pinSchemaValidationMessage<T>(schema: T): T {
  if (schema === undefined || schema === null) return schema;
  const std = (schema as MaybeStandardSchema)['~standard'];
  const validate = std?.validate;
  if (!std || !validate) return schema;
  std.validate = async (value: unknown): Promise<StandardResult> => {
    const result = await validate(value);
    const issues = result.issues;
    if (issues === undefined || issues.length === 0) return result;
    // One synthetic issue with no `path`: the SDK's `formatIssue` returns
    // `issue.message` verbatim when the path is empty, so the joined error is
    // exactly the 1.3.x text and nothing is prepended to it.
    return { issues: [{ message: renderIssuesAs133(issues) }] };
  };
  return schema;
}

/**
 * Pins one schema's rendered JSON Schema to the draft-07 dialect v1 emitted.
 *
 * Mutates the schema's own `~standard.jsonSchema` hook in place and returns the
 * SAME object, so the value stays a real zod schema for every other consumer
 * (type inference, `.shape`, `.parse`) and only the SDK's rendering path is
 * redirected. `~standard.validate` is deliberately left alone.
 *
 * A no-op for anything that does not publish the hook (a raw zod shape, or zod
 * < 4.2), in which case the SDK's own conversion applies and the dialect moves
 * — which `test/wire-conformance.test.ts` fails on.
 */
function pinSchemaDialect<T>(schema: T): T {
  if (schema === undefined || schema === null) return schema;
  const std = (schema as MaybeStandardSchema)['~standard'];
  const hook = std?.jsonSchema;
  if (!hook) return schema;
  const { input, output } = hook;
  std.jsonSchema = {
    input: () => input({ target: LEGACY_JSON_SCHEMA_TARGET }),
    output: () => output({ target: LEGACY_JSON_SCHEMA_TARGET }),
  };
  return schema;
}

/**
 * Installs the legacy-era tool-descriptor defaults on a freshly constructed
 * McpServer, by wrapping its `registerTool` so that every tool — from
 * `defineTool()` and from the hand-written meta/webhook registrations alike —
 * gets the v1 schema dialect and the v1 `execution` field.
 *
 * `era` selects the ONE pin that is not era-neutral. The schema dialect and the
 * `execution` field are wire DESCRIPTORS and are pinned on both eras on purpose
 * (see {@link TOOL_JSON_SCHEMA_DIALECT}); the validation-failure TEXT is a
 * client-visible string that 2026-07-28 does not specify, so the modern era
 * keeps the SDK v2 rendering — which names the offending field in one readable
 * line — and only the legacy era is dragged back to the 1.3.x JSON dump.
 *
 * Call once, before any domain registers anything.
 */
export function applyLegacyWireDefaults(server: McpServer, era: ProtocolEra = 'legacy'): McpServer {
  const pinValidationMessages = era !== 'modern';
  // `registerTool` is overloaded (Standard Schema + deprecated raw-shape form),
  // so it cannot be re-typed structurally without collapsing to one overload.
  // The wrapper is therefore expressed over the erased shape both overloads
  // share and re-assigned through the original type.
  type ErasedRegisterTool = (
    name: string,
    config: { inputSchema?: unknown; outputSchema?: unknown },
    cb: unknown,
  ) => RegisteredTool;

  const original = server.registerTool.bind(server) as unknown as ErasedRegisterTool;
  const wrapped: ErasedRegisterTool = (name, config, cb) => {
    pinSchemaDialect(config.inputSchema);
    pinSchemaDialect(config.outputSchema);
    if (pinValidationMessages) {
      pinSchemaValidationMessage(config.inputSchema);
      pinSchemaValidationMessage(config.outputSchema);
    }
    const tool = original(name, config, cb);
    tool.execution = { ...LEGACY_TOOL_EXECUTION };
    return tool;
  };
  server.registerTool = wrapped as unknown as McpServer['registerTool'];

  // Prompts validate their arguments through the very same
  // `validateStandardSchema`, so `prompts/get` with a missing required argument
  // lost the same rendering that `tools/call` did. Pinned here rather than in a
  // second installer because it is the same decision, on the same seam, for the
  // same reason — and a prompt registered without going through this wrapper
  // would be as invisible as a tool registered without it.
  if (pinValidationMessages) {
    type ErasedRegisterPrompt = (
      name: string,
      config: { argsSchema?: unknown },
      cb: unknown,
    ) => unknown;
    const originalPrompt = server.registerPrompt.bind(server) as unknown as ErasedRegisterPrompt;
    const wrappedPrompt: ErasedRegisterPrompt = (name, config, cb) => {
      pinSchemaValidationMessage(config.argsSchema);
      return originalPrompt(name, config, cb);
    };
    server.registerPrompt = wrappedPrompt as unknown as McpServer['registerPrompt'];
  }

  return server;
}
