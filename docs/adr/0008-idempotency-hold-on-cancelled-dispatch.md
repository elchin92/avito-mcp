# ADR 0008 — A cancellation that raced an already-sent request holds the idempotency key instead of freeing it

Status: accepted
Date: 2026-08-03
Context: migration to MCP revision 2026-07-28, correction to block A item 11 / stage M1.4
Supersedes: nothing
Amends: the written acceptance criterion of `MIGRATION_PLAN.md` §A.11 and §M1.4

## Decision

When a request is cancelled — on this revision, when the client closes the SSE
response stream — the server keeps doing what item 11 requires: the outgoing
Avito call is aborted and the rate-limiter slot is given back.

What it stops doing is releasing the caller's idempotency key **when the
outgoing request had already been dispatched**. That key is instead put into a
bounded *hold*: any later call with the same key is refused with
`IDEMPOTENCY_HELD` until the hold expires, is swept, or is lifted by an
operator.

The distinction is decided by an explicit dispatch latch — `RequestOptions.onDispatch`,
fired by `AvitoClient` in the statement immediately before `fetch()` — and never
by `signal.aborted` on its own. A cancellation that lands **before** dispatch
(queued behind the shared rate-limit budget, waiting on a token) frees the key
exactly as before, because nothing reached Avito and a refusal there would
strand the agent on a key it can never reuse.

An `AvitoApiError` is the one dispatched failure that does not produce a hold:
the upstream answered this request with a status, so the outcome is known, and
it is remembered like any other definite failure.

## What was there before

`src/core/tool-factory.ts` rethrew every failure of a cancelled call, and
`IdempotencyStore.runExclusive` deleted the reservation on any rejection — the
durable branch with `fs.rm(persistentPath)`, the process-local branch with
`this.reservations.delete(...)`. The comment on the durable branch stated the
belief the code rested on:

> A caught application failure means no usable result was produced.

For a cancellation that raced a dispatched request, that sentence is false. The
request had gone; Avito was executing it; nothing about the local rejection said
otherwise.

This was not 1.3.3 behaviour. `git show 79ed1cb:src/core/tool-factory.ts` has no
`signal` and no `aborted` at all — cancellation did not exist, so the race did
not either. It arrived with M1.4.

## What it cost, measured

Reproduced end to end against a real loopback HTTP upstream that counted what
reached it, with the production-shaped durable ledger, on the money tool
`items_put_item_vas` (PUT, "charges money from the balance; irreversible"), two
independent runs with identical numbers:

| Scenario | Outgoing money mutations | What the retry with the SAME key returned |
| --- | --- | --- |
| Cancel **after** the request left | **2** | `isError=false`, `idempotent_replay=false`, a genuine second mutation |
| Control: upstream answers 502 instead of a cancel | 1 | `isError=true`, `idempotent_replay=**true**`, byte-identical body |
| Cancel **before** the request left (queued in the rate limiter) | 1 (only the retry's) | `isError=false`, first-attempt semantics — correct |

Row 1 is a double charge, not a retried-to-the-same-result. The first caller
received nothing at all — its stream was closed — so the agent had no way to
know a charge had happened, and the retry looked to it like a first attempt.

The counting harness now lives in the suite: `test/idempotency-cancel-race.test.ts`
asserts one mutation, not two, at the receiving end of a real socket.

## Why this is allowed, and where the revision says so

The corpus in `docs/mcp-2026-07-28/` supports the change directly, and it is
worth being precise about which clause carries which weight.

**The MUST is untouched.** C-04 — «The server **MUST** treat a client disconnect
as cancellation of that request» ([`utilities-1.md`](../mcp-2026-07-28/utilities-1.md)) —
is about stopping the work. The work is stopped: the `fetch` is aborted, the
limiter slot is returned. Nothing here declines to treat the disconnect as a
cancellation.

**The clause the old criterion leaned on is a SHOULD, and it is about
resources.** C-13 — «Servers receiving cancellation notifications **SHOULD**:
Stop processing the cancelled request; **Free associated resources**; Not send a
response for the cancelled request». A rate-limiter slot is an associated
resource and it is freed. An idempotency key is not a resource: it is a record
of what may already have happened at a third party, and "freeing" it does not
reclaim anything — it authorises a repeat.

**The revision anticipates exactly this case.** C-14 — «Servers **MAY** ignore
cancellation notifications if: The referenced request is unknown; **Processing
has already completed**; **The request cannot be cancelled**» — and C-16, «Both
parties **MUST** handle these race conditions gracefully», with C-21 noting the
notification «**MAY** arrive after the request has already finished». A money
mutation that is already on the wire is the textbook "cannot be cancelled": the
server can stop *listening*, but it cannot un-send it.

**And the corpus states this project's criterion literally.**
[`changelog.md`](../mcp-2026-07-28/changelog.md) §18, on the removal of
resumability:

> …при обрыве потока клиент переотправляет запрос с новым ID. Для avito-mcp это
> важно в связке с идемпотентностью (`src/core/idempotency.ts`): **переотправка
> после обрыва станет нормой**, а не исключением… Проверяемый критерий:
> **повторный `tools/call` с тем же идемпотентным ключом после обрыва потока не
> приводит ко второй трате денег в Avito.**

The behaviour this ADR replaces failed that criterion — and the same corpus
repeats the underlying rule for money elsewhere: «для операций с деньгами
одноразовость обязательна» ([`blog.md`](../mcp-2026-07-28/blog.md) §31),
«повторное предъявление … не должно приводить ко второму списанию»
([`client.md`](../mcp-2026-07-28/client.md) §6).

## What it costs us

A refusal where there used to be a retry. This is a real cost and it is paid by
a real user.

If the cancellation raced a mutation that in fact never applied — the socket
died in the kernel, Avito never saw it — the agent is nevertheless told "this may
have happened, check before repeating", and the honest work it does next is a
read against Avito rather than a retry. Three things bound that cost:

1. **The hold expires.** It inherits the reservation's `expiresAt`
   (`AVITO_MCP_IDEMPOTENCY_TTL_SEC`, one hour by default). It is not the
   permanent `in_flight` record a hard process kill leaves behind, because
   unlike a killed process this one was alive and recorded exactly what it knew.
2. **It is swept by the mechanism that already existed.** `cleanupExpired()`
   drops the process-local half; the durable record is removed by the same
   `if (record)` branch of `runExclusive` that removes any other unusable record
   the next time its key comes round. It is counted in `size()` and in
   `maxEntries` while it lives, and stops being counted when it does not.
3. **An operator can lift it early**, once the operation has actually been
   reconciled with Avito — see `docs/safety.md`, "Lifting a held idempotency key".

The alternative cost is a duplicate irreversible charge on a production account
with no sandbox. Between "an agent must check before repeating" and "the user is
charged twice and nobody is told", this is not a close call.

Two things this deliberately does NOT do, both of them mistakes that were
considered and rejected:

- **Decide on `signal.aborted` alone.** That refuses the pre-dispatch
  cancellation too, and a call cancelled while it queues for a rate-limit slot
  would wedge its key for a full TTL having changed nothing anywhere.
  `test/idempotency-cancel-race.test.ts` fails on exactly that mistake.
- **Hold forever.** An unbounded hold turns every dropped SSE connection into a
  permanent entry that eats `maxEntries` and that no operator can clear.

## Scope and known limits

- Tools with a `customExecute` (`promotion_create_bbip_order_for_items_v1`,
  `promotion_get_order_status_v1`, `messenger_upload_images`) do not receive the
  caller's signal, so their outgoing calls are not cancellable and the latch is
  not wired through them. Their behaviour is byte-for-byte what it was before
  this change: the call runs to completion and its result is remembered. There
  is no new gap; wiring the signal into them is a separate change with its own
  cancellation semantics to argue.
- The hold is recorded by a live process. A process killed between dispatch and
  the hold leaves the pre-existing `in_flight` record, which is already
  fail-closed and unchanged here.
- No tool schema moved: `schema_hash` is still
  `9c52d4c3f39300d267fba9bdcfb9a7aef9cb9664d325484f2a3967327f5f505f` and the
  legacy 1.3.3 wire bench is untouched. The new refusal is an `isError` payload
  on an error path 1.3.3 could not reach, since 1.3.3 had no cancellation.

## Amendment to the plan

`MIGRATION_PLAN.md` §A.11 reads:

> 11. Закрытие SSE-потока ответа трактуется как отмена: исходящий вызов к Avito
>     прерывается, лиза идемпотентности и слот rate-limiter освобождаются.

and §M1.4's acceptance criterion repeats "освобождает лизу идемпотентности и слот
rate-limiter". Both are amended by this ADR to read, in substance:

> …исходящий вызов к Avito прерывается и слот rate-limiter освобождается. Лиза
> идемпотентности освобождается **только если запрос ещё не был отправлен**;
> отмена, догнавшая уже отправленный запрос, переводит ключ в ограниченное по
> времени удержание — повтор отвергается, пока исход не выяснен (ADR 0008).

`MIGRATION_PROGRESS.md` §M1.4 already claimed both "лиза освобождается" and "но
операция не повторяется"; the measurement above shows the second half was not
true, and this ADR is what makes it true.

## References

- `src/core/client.ts` — `RequestOptions.onDispatch`, fired immediately before `fetch()`
- `src/core/idempotency.ts` — `UpstreamOutcomeUnknownError`, `IdempotencyHeldError`,
  the `indeterminate` durable state, `releaseHold()`
- `src/core/tool-factory.ts` — the three-way decision in `execute`'s catch
- `src/core/errors.ts` — `IDEMPOTENCY_HELD` in the error taxonomy
- `test/idempotency-cancel-race.test.ts` — the mutation counter
- `docs/conformance.md` — rows A11a, A11b, A11d, A11e, A11f
