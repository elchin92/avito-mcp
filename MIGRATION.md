# Upgrading from 1.3.x to 2.0.0

**[Русская версия →](./MIGRATION.ru.md)** · [README](./README.md) · [CHANGELOG](./CHANGELOG.md)

**If you run the default stdio setup, `npm install avito-mcp@2.0.0` and you are done.** No tool was
added, removed or renamed; the catalogue is the same 148 tools with the same schemas, and
`schema_hash` is still `9c52d4c3…f505f`. No environment variable was renamed, no default changed,
no resource URI or prompt moved.

The major version is bought by three OAuth tightenings and one cancellation behaviour, not by the
protocol work. MCP revision 2026-07-28 ships switched off.

| Your setup                                                          | What to do                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| stdio — `npx avito-mcp` in Claude Desktop, Cursor, Cline            | Nothing, unless your client cancels tool calls. See [Cancellation](#cancellation-is-now-honoured) |
| HTTP with `AVITO_MCP_HTTP_AUTH=none` or `bearer`                    | Nothing                                                                           |
| HTTP with OAuth on `https://…`                                      | Read [DCR is stricter](#dynamic-client-registration-is-stricter) — some clients re-register |
| HTTP with OAuth on `http://…` on a routable host                    | **The server will refuse to start.** Fix below                                    |

---

## The one hard break

2.0.0 refuses to start when all three of these hold:

- `AVITO_MCP_TRANSPORT` is `http` or `both`, **and**
- `AVITO_MCP_HTTP_AUTH=oauth`, which is the default auth mode, **and**
- `AVITO_MCP_HTTP_PUBLIC_URL` is a cleartext `http://` URL on a routable host —
  `http://mcp.example.com`, `http://203.0.113.5:3000`

You get an `EnvValidationError` at boot naming the fix. 1.3.3 started fine, which is the problem:
in `oauth` mode that URL is three things at once — the OAuth issuer identifier, the `resource`
every token is bound to, and the base of the endpoint clients POST their authorization code and
`code_verifier` to. Cleartext exposes all three in transit.

A default install is not affected. The public URL defaults to `http://127.0.0.1:3000`, loopback is
exempt, and the check only runs when the HTTP transport is on with `oauth`.

The fix is to terminate TLS at a proxy and point the variable at the https URL:

```bash
AVITO_MCP_HTTP_PUBLIC_URL=https://mcp.example.com
```

The README carries [Caddy and nginx snippets](./README.md#remote-mcp-over-http-oauth-21) that do
this. If you genuinely need cleartext for local development, two variables are required, because
the SDK enforces its own issuer check separately:

```bash
AVITO_MCP_HTTP_ALLOW_INSECURE_PUBLIC_URL=1
MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true
```

Do not use those on a routable host.

---

## Dynamic Client Registration is stricter

Registration is unauthenticated, so the callback target of any client is chosen by a stranger, and
until 2.0.0 the only checks were the count (1–10) and the length. `http://evil.example.com/cb`
passed both, which put an owner-approved authorization code on the network in the clear.

A `redirect_uri` must now be `https`, or `http` on a loopback address (`127.0.0.1`, `[::1]`,
`localhost`), and must carry no fragment.

| Callback that used to register             | What to do                                            |
| ------------------------------------------ | ------------------------------------------------------ |
| `http://` on a routable host               | Move it to `https://`                                 |
| `com.example.app:/cb` (private-use scheme) | Use a loopback redirect — supported since v0.9.1      |
| Anything carrying `#fragment`              | Drop the fragment                                     |

**This lands sooner than you might expect.** Clients already written to a persisted store
(`AVITO_MCP_OAUTH_STORE_FILE`) are not re-validated on load and keep working, but without that
variable the store is in memory — so every client re-registers when the process restarts, and that
is when the new rule bites. The grandfathering is not permanent either: a persisted client record
expires 90 days after it was issued, or 24 hours if it holds no live token or code.

### `application_type` is now honoured

A client that declares `application_type: "native"` is registered as a public client with
`token_endpoint_auth_method: "none"` and receives no `client_secret` — it ships to end-user
devices, so a secret minted for it is a secret that leaks. Declaring `native` alongside any
secret-bearing auth method is rejected outright, and a `web` client is refused a loopback or
non-`https` callback, since a loopback redirect resolves on whatever machine the browser is on.

Clients that omit `application_type` are unaffected; omitting it stays valid. A native client that
previously received a secret and authenticated with `client_secret_post` will fail on its next
registration and has to switch to public-client PKCE.

---

## Cancellation is now honoured

This one is not gated behind the protocol-era flag. It applies on both revisions, the default
included, and it is the only behaviour change a default stdio install can observe.

1.3.3 parsed `notifications/cancelled` and did nothing with it. 2.0.0 acts on it: the handler that
turns the notification into an `abort()` is registered by the SDK's base protocol before any
revision is known, and the tool layer reads the caller's cancellation signal without consulting the
era. Revision 2026-07-28 adds a second channel — closing the response stream — but does not own the
first. If your client never sends the notification, none of this reaches you.

If it does, two things are new. A tool call the client walks away from is now interrupted instead
of running to completion. And if that interruption caught a **destructive tool carrying an
`idempotencyKey` whose request had already been sent to Avito**, the outcome is unknowable from
here — the mutation may have gone through. The key goes into a time-limited hold, and a retry with
it answers `IDEMPOTENCY_HELD` rather than executing.

That refusal is the point. For a money operation, being told no beats a second charge. Cancelling
*before* the request was dispatched — while it queued behind the rate-limit budget, or waited on a
token — frees the key exactly as before, and the rate-limiter slot is returned either way.

There is no flag that restores the 1.3.3 behaviour, because restoring it would restore the
duplicate charge with it. If you hit a held key, `docs/safety.md` has the section
[Lifting a held idempotency key](./docs/safety.md): it expires on its own with the ledger TTL, or
you delete the record file the `warn` line names once you have checked the account.

---

## Things you probably will not notice

**The npm tarball ships fewer files.** `files` narrowed `docs/` to `docs/safety.md`, so the ADRs and
`docs/conformance.md` are no longer inside the published package. Nothing at runtime reads them —
`avito://docs/safety` is the only doc the server serves. Read them in the repository instead.

**The dependency substrate was replaced.** `@modelcontextprotocol/sdk ^1.29` is gone in favour of
`@modelcontextprotocol/{server,server-legacy,node,express} ^2.0.0`, with `hono ^4.12` as the modern
transport's HTTP layer. This package has no `exports` map and is consumed through its `bin`, so
there is no public-API break — but if you import `dist/*` paths directly, or pin the old SDK as a
peer, you are affected. `engines` (`node >=22.12.0`), `bin` and `main` are unchanged.

**A 1.3.3 bug was fixed:** `tools/call` sent without an `arguments` member now succeeds. 1.3.3
refused it for every tool, including zero-argument ones like `meta_capabilities`, even though the
member is optional in the specification. This is strictly more permissive; nothing that worked
before can break.

---

## Optional: turning on MCP revision 2026-07-28

Nothing changes until you set the variable, and it is off by default.

| `AVITO_MCP_PROTOCOL_ERA` | What the process serves                                                           |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `legacy` *(default)*     | Revision 2025-11-25 only — byte-for-byte the 1.3.x wire                           |
| `dual`                   | Both. A 2025 client keeps calling `initialize`, a 2026 one calls `server/discover` |
| `modern`                 | Revision 2026-07-28 only, which strands every 2025 client                          |

Roll out with `dual`, watch, then narrow. An unrecognised value fails startup rather than falling
back: a typo in the one variable that decides which protocol your clients get should not be
survivable in silence. What a client sees when it moves to 2026-07-28 is in the README under
[Protocol revisions](./README.md#protocol-revisions).

**One limitation to know before you enable `dual`.** On stdio the era is decided once per connection
and cannot be changed afterwards. There is no header layer there, so the SDK reads the revision
from the first classifiable message and holds it for the life of the connection. A 2026 client
whose opening frame carries no `_meta` envelope is served as a 2025 client until it reconnects,
even if every later frame carries one. The server writes a single `protocol era pinned to legacy`
line to stderr when that happens, naming the method that pinned it — grep for it while rolling out.
The fix is client-side: send `io.modelcontextprotocol/protocolVersion` in `params._meta` on the
first message. HTTP is unaffected, because there every request is classified on its own. Why this
is accepted rather than worked around: [ADR 0001](./docs/adr/0001-protocol-era-limitations.md).

**Two new limits replace the session caps.** Revision 2026-07-28 has no sessions, so
`AVITO_MCP_HTTP_MAX_SESSIONS` and `AVITO_MCP_HTTP_SESSION_IDLE_SEC` — which keep their names,
defaults and meaning — govern nothing on the modern leg. Two new variables carry the equivalent
budget there:

```bash
AVITO_MCP_HTTP_MAX_INFLIGHT=64   # concurrent /mcp exchanges
AVITO_MCP_HTTP_MAX_STREAMS=32    # how many of those may be long-lived streams
```

They are deliberately not derived from `maxSessions`: a session is idle most of its life, an
in-flight exchange is work in progress, and tying them would move the modern budget whenever an
operator tuned the legacy one. Both appear in `avito://state/config`.

---

## Rolling back

```bash
npm install avito-mcp@1.3.3
```

There is nothing to undo first. 2.0.0 writes no new on-disk state format: the runtime state, token
cache and OAuth store files are the 1.3.3 shapes. The one addition is an `issuer` field the OAuth
store gains on its first write under 2.0.0, and 1.3.3 reads only the fields it knows, so
downgrading over it is safe.

If you only want to back out the new protocol revision and keep everything else, unset
`AVITO_MCP_PROTOCOL_ERA` (or set it to `legacy`) and restart. That is a full rollback of the
revision work with no reinstall.

---

## Questions

**Did any tool change?** No — 148 tools, same names, same input schemas, same `schema_hash`. The
suite replays this build against a wire baseline captured from a real running 1.3.3 process: 61
recorded exchanges, 151 assertions, on every CI run.

**Do I have to enable 2026-07-28?** No. It is off by default and inert until you set the variable.

**Will my agent notice anything?** Only if it cancels tool calls.

**Something else broke.** Open an [issue](https://github.com/elchin92/avito-mcp/issues) with your
`AVITO_MCP_TRANSPORT`, `AVITO_MCP_HTTP_AUTH` and `AVITO_MCP_PROTOCOL_ERA` values — never your
credentials — and the output of `meta_health`.

Full detail, including everything this page leaves out: [CHANGELOG 2.0.0](./CHANGELOG.md).
