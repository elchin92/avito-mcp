# ADR 0007 — Rollback criteria with numbers, and the procedure that acts on them

Status: accepted
Date: 2026-08-02
Context: migration to MCP revision 2026-07-28, stage M6.8
Supersedes: nothing

Block F of the readiness criterion (`MIGRATION_PLAN.md` §1.2) is one sentence:
`AVITO_MCP_PROTOCOL_ERA=dual` is on in production, the rollback is one
environment variable, and the rollback criteria are **written down and
measurable**. The first two are release work. The third is what blocks the
other two today: §7.3 of the plan lists six criteria, and until this document
none of them named a threshold, a window, or a command. "Roll back if the error
rate grows" is not a criterion, because at 02:00 nobody agrees on *grew by how
much, over what, compared to when*.

This document supplies the missing three columns, and it does one thing more,
which is the part that changed the answer: it checks each criterion against the
code that would have to produce the number. Four of the six criteria of §7.3
turned out not to be computable at all with what this deployment writes. §5 says
which, and what replaced them.

**Scope.** This closes M6.8 in full. Of M7.8 it delivers the procedure half —
the three rollback levels, step by step, with the verification after each step.
The other half of M7.8, an observation of at least seven days against these
metrics, cannot be performed before `dual` is actually on in production (M7.7,
an owner-run release). §7 states the form that observation takes; §8 records
that it has not been run.

---

## 1. What this deployment actually logs

Checked by reading `src/`, and confirmed against the live journal, not assumed.

**The Node process writes no per-request log.** There is no access log, no
request id, no status code, no duration — not at `LOG_LEVEL=info`, and not at
`debug` either, where the only additional per-request lines are legacy session
open/close. The whole journal of `avito-mcp.service` for the seven days before
this document was written is **17 lines**: two starts, two shutdowns, and the
mounting notices in between.

```bash
journalctl -u avito-mcp --since "7 days ago" --no-pager -o cat | wc -l
```

So every criterion phrased as a *share of requests* — non-200 handshakes, error
rate on `/mcp`, latency — has, today, nothing to be computed from. That is the
finding M6.8 exists to force: a criterion that cannot be computed is either
given an instrument or struck off the list.

These are the lines the process does write and that this document reads. The
`msg` values and field names below are re-derived from `src/` by
`test/conformance/rollback-runbook.test.ts`, so a rename in the code turns this
table red rather than turning a criterion silently unmeasurable.

| `msg` | Fields | Where it is written |
| --- | --- | --- |
| `avito-mcp started` | `version`, `transport`, `mode` | `src/server.ts` |
| `avito-mcp shutting down` | `signal` | `src/server.ts` |
| `mcp http modern in-flight limit reached` | `era`, `inflight`, `max` | `src/http/mcp-http.ts` |
| `mcp http modern stream limit reached` | `era`, `openStreams`, `max` | `src/http/mcp-http.ts` |
| `mcp http session limit reached` | `active`, `initializing`, `max` | `src/http/mcp-http.ts` |
| `mcp http modern adapter error` | `era`, `err` | `src/http/mcp-http.ts` |
| `mcp http era dispatch failed` | `err` | `src/http/mcp-http.ts` |
| `mcp http request handling failed` | `err` | `src/http/mcp-http.ts` |
| `http request error` | `path`, `status`, `err` | `src/http/app.ts` |
| `malformed JSON-RPC body on /mcp` | `err` | `src/http/app.ts` |
| `5xx from avito, retrying` | `url`, `status`, `retries5xx` | `src/core/client.ts` |

Two properties of this set matter for what follows. It is **event-driven**:
every line is a failure or a limit, so a count of zero is the healthy value and
no baseline is needed for any of them. And it carries **`era`** on exactly the
three modern-leg lines, which is the only place in the process where a log line
says which leg produced it.

### 1.1 stdio processes

M6.8 asks specifically how logs are collected from ephemeral stdio processes,
because a stdio server is started and killed by its host and its stderr is not
anybody's journal by default. Two cases, and only two:

- **On this host, a stdio process is a systemd unit.** `avito-mcp-mondigo.service`
  runs `AVITO_MCP_TRANSPORT=stdio` with the webhook receiver keeping it alive;
  its stderr is journald like any other unit, and the same commands work with
  `-u avito-mcp-mondigo`. It exposes no `/mcp`, so no traffic criterion applies
  to it — but §6.2 does, because it runs from the same release symlink.

  ```bash
  journalctl -u avito-mcp-mondigo --since "-1h" --no-pager -o cat \
    | jq -Rc 'fromjson? | select(.level >= 40)'
  ```

- **For an npm/npx consumer there is no answer this repository can give**, and
  that is recorded rather than papered over. The process writes pino JSON to
  stderr (fd 2, never stdout — stdout is the protocol) and the host application
  decides whether that is kept. A durable audit trail written by the server
  itself is stage **M1.15** and does not exist. Until it does, the only advice
  that is true is: raise `LOG_LEVEL`, and capture the child's stderr in the host.

### 1.2 The instrument: a Caddy access log

Everything phrased as a share or a percentile is computed from the reverse
proxy, because that is the only component in this deployment that sees a request
and its outcome. `deploy/Caddyfile.example` now enables it:

```caddyfile
log {
	output stderr
	format json
}
```

Three things about that block, all measured on the Caddy actually installed here
(v2.11.3):

- **`output stderr` and `format json` are written out on purpose.** A bare `log`
  inherits Caddy's shared default logger, and that logger drops entries under
  even light load: 30 requests produced **3** log lines. With both directives
  given, 30 of 30 were recorded. A sampled access log makes every ratio in §4
  a fiction, so the explicit form is not style.
- **Credentials do not enter it.** `Authorization` and `Cookie` are recorded as
  `REDACTED` — verified by sending both — because `log_credentials` is off and
  stays off. The webhook credential is a URL path segment rather than a header,
  so `log_skip /avito/webhook/*` excludes those requests entirely. If
  `AVITO_MCP_WEBHOOK_PATH` is customized, the matcher must be changed to the
  same path before logging is enabled.
- **The request headers are recorded**, which is what makes era attribution
  possible at the edge: `Mcp-Protocol-Version` is the field the server's own
  classifier reads, so the log can be split the same way the process splits it.

What it cannot see, stated so that no criterion below pretends otherwise: the
JSON-RPC body. An MCP error carried inside HTTP 200 is invisible to it, and so
are the error *codes* — `-32020`, `-32021`, `-32022`, `-32602`. §5 deals with
that.

**Era, at the edge.** Used verbatim by every command in §4:

```bash
# modern iff the request names revision 2026-07-28; anything else is legacy,
# including an initialize POST that carries no version header at all.
ERA='(if ((.request.headers["Mcp-Protocol-Version"] // [])[0]) == "2026-07-28"
      then "modern" else "legacy" end)'
```

### 1.3 Two preconditions the owner must satisfy before `dual` goes on

Neither is optional, and neither is something this document can do for itself.

1. **The access log must be enabled in `/etc/caddy/avito-mcp.Caddyfile`** — the
   file this repository ships is an example, not the running config. Add the
   same `log { output stderr / format json }` block and webhook `log_skip`
   matcher to the site, then:

   ```bash
   caddy validate --config /etc/caddy/avito-mcp.Caddyfile --adapter caddyfile \
     && systemctl reload caddy \
     && journalctl -u caddy --since "-1min" --no-pager -o cat \
        | jq -Rc 'fromjson? | select(.msg == "handled request") | [.request.method, .status]' | head
   ```

   Until that prints something, §4 is not computable and `dual` must not be
   turned on. Also send a webhook probe and confirm its path does **not** appear
   in the journal before registering the webhook with Avito; a logged webhook
   URL discloses the receiver's only authentication credential.

2. **journald must keep the observation window.** `/etc/systemd/journald.conf`
   on this host is empty — defaults only — and the journal currently reaches
   back about **two days**, against the seven that M7.8 requires. Check it, and
   raise `MaxRetentionSec` / `SystemMaxUse` before starting the window, not
   during it:

   ```bash
   journalctl --disk-usage
   journalctl --no-pager -o short-iso | head -1     # oldest entry still held
   journalctl --since "7 days ago" --no-pager | grep -c 'Suppressed'   # rate-limit drops
   ```

---

## 2. The baseline

Three of the criteria in §4 are comparisons, so there has to be something to
compare with. The baseline is **24 hours of traffic with the access log on and
`era=legacy` still in force** — that is, the last day before the flip, on the
same release. Capture it once, keep the output next to the deployment note:

```bash
journalctl -u caddy --since "-24h" --no-pager -o cat \
| jq -Rc 'fromjson? | select(.msg == "handled request" and .request.uri == "/mcp")' \
| jq -s '{
    total: length,
    refused: (map(select(.status == 400 or .status == 404)) | length),
    p95: ((map(.duration) | sort) as $d | $d[($d | length * 0.95 | floor)])
  }'
```

`total` under 50 for the whole day means the ratio criteria (R2, R4) have no
statistical content on this deployment and are decided by their absolute arms
alone. Write that down when it happens; do not lower the sample floor.

---

## 3. What the criteria trigger

Each criterion names the rollback level it triggers, defined in §6:

- **level 1** — the era variable, seconds;
- **level 2** — the release symlink, minutes, hits both services;
- **level 3** — npm dist-tag, hours, owner only, partly irreversible.

Any criterion firing means: roll back at the stated level first, investigate
after. Nothing here is a "watch it for a while" signal.

---

## 4. The criteria

### R1 — the legacy leg answered with a status the 1.3.3 wire never produced

The strongest criterion available, because its baseline is not a measurement but
a recorded artifact. `test/baselines/legacy-1.3.3-wire.json` holds a live 1.3.3
answering 42 probes, and across all of them it produced exactly five statuses:
**200, 202, 400, 404, 415**. Add the two the authorization layer contributes
(**401**, **403**) and the one the body-size limit contributes (**413**), and
anything else on a legacy-classified `/mcp` request is new — most sharply a
**405**, which is the modern leg's answer to a non-POST verb, and any **5xx**,
which the recorded wire never returns at all.

This is the criterion that catches the failure mode the whole dual design exists
to avoid: a 2025 client being served by the 2026 leg.

- **Trigger:** ≥ 1 such request in any 15-minute window. There is no tolerance
  band; the correct count is 0.
- **Window:** 15 minutes, checked continuously for the first 24 hours after the
  flip, then hourly for the rest of the observation.
- **Rollback level:** 1.

```bash
journalctl -u caddy --since "-15min" --no-pager -o cat \
| jq -Rc 'fromjson?
  | select(.msg == "handled request" and .request.uri == "/mcp")
  | select(((.request.headers["Mcp-Protocol-Version"] // [])[0]) != "2026-07-28")
  | select([200, 202, 400, 401, 403, 404, 413, 415] | index(.status) | not)
  | {ts, status, method: .request.method, ua: (.request.headers["User-Agent"] // [])[0]}'
```

### R2 — the legacy leg started refusing more than it did

`400` and `404` are statuses 1.3.3 does return (a malformed body, a missing or
unknown session id), so their *presence* proves nothing and only their *rate*
does. A rise here is the signature of modern validation leaking into the legacy
path — which is what `-32602` growth on the legacy branch meant in §7.3 of the
plan, expressed in something that is actually recorded.

- **Trigger:** the share of `400`/`404` among legacy-classified `/mcp` requests
  exceeds **2×** the baseline share of §2, or grows by more than **5**
  percentage points in absolute terms — whichever comes first — over a window
  holding at least **50** legacy requests.
- **Window:** 1 hour, extended until the 50-request floor is reached.
- **Rollback level:** 1.

```bash
journalctl -u caddy --since "-1h" --no-pager -o cat \
| jq -Rc 'fromjson?
  | select(.msg == "handled request" and .request.uri == "/mcp")
  | select(((.request.headers["Mcp-Protocol-Version"] // [])[0]) != "2026-07-28")
  | .status' \
| jq -s '{n: length, refused: (map(select(. == 400 or . == 404)) | length)}
         | . + {share: (if .n == 0 then null else (.refused / .n) end)}'
```

### R3 — any 5xx on `/mcp`, on either leg

The recorded 1.3.3 wire contains no 5xx on any of its 42 probes, and the modern
leg answers its own refusals with 400/404/405/503. A 5xx is therefore always a
defect, never a shape difference — including the specific regression §7.3 names
first, an invalid Bearer token answered 500 instead of 401.

- **Trigger:** ≥ 1 in any 15-minute window; independently, > **0.5 %** of
  `/mcp` requests in any 1-hour window.
- **Window:** 15 minutes and 1 hour, in parallel.
- **Rollback level:** 1 if it is present only under `dual`; 2 if it survives the
  era rollback.

```bash
journalctl -u caddy --since "-15min" --no-pager -o cat \
| jq -Rc 'fromjson?
  | select(.msg == "handled request" and .request.uri == "/mcp" and .status >= 500)
  | {ts, status, era: (if ((.request.headers["Mcp-Protocol-Version"] // [])[0]) == "2026-07-28"
                       then "modern" else "legacy" end)}'
```

The `500`-instead-of-`401` regression additionally gets an active probe, because
waiting for a real client to hit it is waiting for the incident. It is
read-only, costs nothing, and its answer today (2026-08-02, release 1.3.3) is
`401` with a `WWW-Authenticate` challenge naming the resource metadata:

```bash
# The value is deliberately built rather than written out: the secret scan
# refuses a literal bearer credential in a curl invocation, and it is right to,
# even when the credential is a joke. What is under test is that the token was
# never issued, not what it says.
bogus="never-issued-$(date +%s)"
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 \
  -X POST https://mcp.mhand.store/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${bogus}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- **Trigger:** any answer other than `401`.
- **Window:** run it immediately after the flip, then every 5 minutes for the
  first hour, then hourly.
- **Rollback level:** 1.

### R4 — latency grew

Measured on the proxy, over POST requests only, with `subscriptions/listen`
excluded: that method opens a long-lived stream, so its `duration` is the life
of the subscription and mixing it in would move the percentile for reasons that
are not a regression.

- **Trigger:** p95 exceeds **2×** the baseline p95 of §2 over a window holding
  at least **50** requests, or exceeds **5 s** in absolute terms regardless of
  sample size.
- **Window:** 1 hour, sustained — a single hour above the threshold is the
  trigger; a single request is not.
- **Rollback level:** 1.

```bash
journalctl -u caddy --since "-1h" --no-pager -o cat \
| jq -Rc 'fromjson?
  | select(.msg == "handled request" and .request.uri == "/mcp")
  | select(.request.method == "POST")
  | select(((.request.headers["Mcp-Method"] // [])[0]) != "subscriptions/listen")
  | .duration' \
| jq -s 'sort | {n: length,
                 p50: .[(length * 0.50 | floor)],
                 p95: .[(length * 0.95 | floor)],
                 max: .[-1]}'
```

### R5 — the concurrency limits that replaced sessions are being hit

`AVITO_MCP_HTTP_MAX_INFLIGHT` and `AVITO_MCP_HTTP_MAX_STREAMS` are what M3.8 put
in place of the legacy session cap, and they are the one part of the modern leg
that fails by *refusing healthy traffic*. Both refusals are logged by the
process itself, so this criterion needs no proxy and no baseline: the healthy
count is 0.

- **Trigger:** ≥ 1 occurrence in an hour is investigated; ≥ **10** in an hour, or
  any occurrence at all while `/mcp` traffic is below the baseline volume of §2,
  is a rollback. The second arm is the one that matters: hitting a concurrency
  limit on *less* traffic than before means slots are leaking, not that load
  grew.
- **Window:** 1 hour.
- **Rollback level:** 1.

```bash
journalctl -u avito-mcp --since "-1h" --no-pager -o cat \
| jq -Rc 'fromjson?
  | select(.msg == "mcp http modern in-flight limit reached"
        or .msg == "mcp http modern stream limit reached"
        or .msg == "mcp http session limit reached")
  | {time, msg, era, inflight, openStreams, active, max}'
```

Its mirror at the edge is a `503` with `Retry-After`, which is how a refused
client sees it and which distinguishes a limit from a crash:

```bash
journalctl -u caddy --since "-1h" --no-pager -o cat \
| jq -Rc 'fromjson?
  | select(.msg == "handled request" and .request.uri == "/mcp" and .status == 503)
  | {ts, status}'
```

### R6 — the process is restarting

A crash loop is the failure that makes every other criterion read as healthy —
few requests arrive, so few fail. It costs one command and needs no instrument.

- **Trigger:** ≥ **3** starts in an hour, or any `NRestarts` increase at all
  within the first hour after the flip.
- **Window:** 1 hour.
- **Rollback level:** 2 — a crash on start is not usually fixed by the era
  variable, because the process has to come up to read it.

```bash
systemctl show avito-mcp.service -p NRestarts -p ActiveEnterTimestamp
journalctl -u avito-mcp --since "-1h" --no-pager -o cat \
| jq -Rr 'fromjson? | select(.msg == "avito-mcp started")
          | "\(.time) v\(.version) transport=\(.transport) mode=\(.mode)"'
```

### R7 — the 2025 wire moved

Not a traffic metric, and deliberately so: the shape of a response is not
visible to a proxy, and §7.3's "any divergence of the M1.1 wire snapshot" is a
claim about bytes. The instrument is the recorded bench, run against the tag
that is being deployed, in a checkout — not on the production host.

- **Trigger:** **0** tolerated failing steps — any one of the 42 is enough. Not
  a rate, and there is no window over which a failure averages out: the bench
  replays a recorded conversation, so a step either matches the bytes 1.3.3
  answered or it does not. The bench declares each intended difference by name
  (`KnownAddition`, `DeclaredDivergence`, `RebasedValue`, `DUAL_ERA_DELTAS`), so
  a failure is by construction an *undeclared* difference.
- **Window:** once before the flip and once after; not continuous.
- **Rollback level:** 2 before the flip (the release itself moved the wire), 1
  after (only the era changed).

```bash
git -C <checkout> switch --detach v<version> && npm ci
npx vitest run test/legacy-wire-regression.test.ts
```

---

## 5. The criteria of §7.3 that did not survive, and what replaced them

M6.8 is explicit that a criterion which cannot be computed is either given an
instrument or removed. Four of the six were not computable. None of them is
quietly dropped.

| §7.3 criterion | Verdict |
| --- | --- |
| HTTP 500 instead of 401 on an invalid Bearer token | **Kept**, as the active probe in R3. It cannot be found by mining logs — the log holds no token and no auth outcome — so it is measured by asking. |
| Rise in the share of 5xx on `/mcp` against the previous release | **Kept** as R3, with the baseline strengthened: the recorded 1.3.3 wire has no 5xx at all, so the comparison is against zero rather than against a remembered rate. |
| `-32020` / `-32021` / `-32022` appearing for clients that used to work | **Replaced** by R1 and R2. The codes themselves are unobtainable: no log line carries a JSON-RPC code, and the proxy sees only the envelope. All three are answered with HTTP 400 on the modern leg, and none of them exists on the legacy leg — so "a legacy request answered 400/404 more often than before" is the same event, observed where it is actually recorded. The exact form needs a per-request log inside the server, which nothing in the plan currently asks for; it is written down here as debt rather than as a metric that exists. |
| Rise in `-32602` on the legacy branch | **Replaced** by R2, for the same reason and by the same mapping. |
| Any divergence of the M1.1 wire snapshot | **Kept** as R7, moved out of the traffic metrics: it is a gate run against a build, not a number read off production. |
| A money/public operation executed twice under one `idempotencyKey` | **Removed from the automatic triggers**, and assigned to **M1.15**. `idempotent_replay` is a field of the *response*, not of any log line; the durable audit trail that would record an execution does not exist. Nothing this deployment writes can distinguish one execution from two. |

The compensating control for the last row, since removing a criterion is not the
same as removing the risk: the idempotency ledger is durable, so a *broken*
ledger — the precondition for a double execution — is visible as an empty or
stale record directory while money tools are being called. This is a manual
check with no threshold, not a criterion:

```bash
sudo -u avito-mcp find /var/lib/avito-mcp/avito-mcp/runtime -type f -name '*.json' \
  -newermt '-1 hour' | wc -l
```

`AVITO_MCP_CONFIRMATION_MODE=money_public` remains on, so every money/public
call still passes through a human confirmation; that, and not a log metric, is
what bounds the cost of this gap until M1.15.

---

## 6. The rollback procedure

### 6.0 Facts the procedure depends on

Verified on this host, because two of them are the reason the naive version of
this procedure is wrong:

- Both `avito-mcp.service` and `avito-mcp-mondigo.service` execute
  `/opt/avito-mcp/current/dist/server.js`. **One symlink, two services.**
- `deploy/install-services.sh` manages `avito-mcp.service` and `caddy.service`
  and **does not know that `avito-mcp-mondigo.service` exists**. Its automatic
  `rollback_release` therefore restarts one of the two processes running from
  the path it just moved.
- The two services read **different** environment files:
  `/etc/avito-mcp/avito-mcp.env` and `/etc/openclaw/avito-mcp-mondigo.env`.
- A running process keeps the release directory it started from, even after the
  symlink is moved. `readlink -f /proc/<pid>/cwd` is what proves which release
  is actually executing; `readlink -f /opt/avito-mcp/current` only says what the
  next start will pick up.
- `AVITO_MCP_PROTOCOL_ERA` matches the `AVITO_MCP_*` allowlist in
  `deploy/render-service-env.mjs`, so it survives a re-render of the service
  environment file and does not have to be re-added after a deploy.

### 6.1 Level 1 — the era, seconds

Applies to everything M3, M4 and M7.7 introduce. This is the rollback the whole
dual design is for: nothing is rebuilt, nothing is re-deployed, and the legacy
leg is the same code it was.

```bash
# 1. Remove the variable (or set it to legacy — removing it is preferred, so the
#    file states nothing rather than stating the default twice).
sudoedit /etc/avito-mcp/avito-mcp.env      # delete the AVITO_MCP_PROTOCOL_ERA line

# 2. Restart the one service that serves /mcp.
systemctl restart avito-mcp.service

# 3. Verify on the PROCESS, not on the file: the file says what the next start
#    will read, /proc says what this start did read.
pid=$(systemctl show -p MainPID --value avito-mcp.service)
tr '\0' '\n' < /proc/$pid/environ | grep '^AVITO_MCP_PROTOCOL_ERA=' \
  || echo 'unset -> legacy (the default of src/config.ts)'

# 4. Verify it serves.
curl -s --max-time 3 http://127.0.0.1:3000/healthz
curl -s --max-time 3 http://127.0.0.1:3000/readyz
systemctl is-active avito-mcp avito-mcp-mondigo caddy
```

**Do not touch `avito-mcp-mondigo.service` here.** It is `transport=stdio` with
a webhook receiver and exposes no `/mcp`; the era flag changes nothing for it,
and restarting it drops the webhook listener for no reason. If the variable was
ever added to `/etc/openclaw/avito-mcp-mondigo.env`, remove it there too and
restart that unit as well — but the default is that it is not there.

Expected duration: under 10 seconds. Then re-run R1, R3 and the R3 probe; all
three must read zero / `401` before the incident is called closed.

### 6.2 Level 2 — the release symlink, minutes, both services

Applies to anything level 1 does not fix, and to any release that moved the wire
(M2, M5). **This changes the code under both services at once**, which is why
both restarts are in the procedure and not in a footnote.

```bash
# 1. Record where you are, so the roll-forward is a symmetrical operation.
readlink -f /opt/avito-mcp/current
ls -1 /opt/avito-mcp/releases

# 2. Move the symlink atomically. `mv -Tf` replaces the link in one rename;
#    `rm` + `ln` leaves a window in which /opt/avito-mcp/current does not exist,
#    and a service restarting in that window fails to start at all.
ln -s /opt/avito-mcp/releases/<previous-version> /opt/avito-mcp/.rollback.$$
mv -Tf /opt/avito-mcp/.rollback.$$ /opt/avito-mcp/current
readlink -f /opt/avito-mcp/current

# 3. Restart BOTH services. Neither picks the new target up on its own, and the
#    installer's own rollback path restarts only the first of the two.
systemctl restart avito-mcp.service
systemctl restart avito-mcp-mondigo.service

# 4. Verify that each process is really executing the release you selected.
for u in avito-mcp avito-mcp-mondigo; do
  pid=$(systemctl show -p MainPID --value $u.service)
  printf '%s pid=%s release=%s\n' "$u" "$pid" "$(readlink -f /proc/$pid/cwd)"
done
curl -s --max-time 3 http://127.0.0.1:3000/healthz   # {"version":"<previous>"}
curl -s --max-time 3 http://127.0.0.1:3001/healthz   # the mondigo unit, same version
systemctl is-active avito-mcp avito-mcp-mondigo caddy
```

Step 4 is the step that is skipped and should not be: a service whose restart
failed stays `active` on the *old* main PID under `Restart=on-failure` timing,
and `/healthz` on a stale process reports the version you were rolling back
from. If the two `release=` lines disagree with each other, or with
`readlink -f /opt/avito-mcp/current`, stop and fix that before reading any
metric — every criterion in §4 is meaningless while two processes serve
different code.

Constraint carried over from plan §7.1: **M5.2 is not rolled back before M5.1.**
A deployment that advertises `authorization_response_iss_parameter_supported`
while no longer emitting `iss` does not degrade authorization, it stops it.

Do **not** roll a release back by re-running `deploy/install-services.sh`
against an older tarball while an incident is open. Its transaction stops the
service, migrates state ownership and rewrites unit files; that is a deploy, and
a deploy is not a rollback.

### 6.3 Level 3 — the npm dist-tag, hours, owner only, partly irreversible

Only relevant when the defect reaches consumers who install from npm rather than
from this host. Every step below is a release action and is **outside what an
agent may do**: it belongs to the owner.

1. **Move `latest` back.** `npm dist-tag add avito-mcp@<previous> latest`. This
   is the whole rollback for new installs; it does not touch anyone already on
   the bad version, and it does not remove it.
2. **The bad version stays published.** `npm publish` is irreversible in the
   sense that matters here: unpublish is only available in a 72-hour window and
   is itself a breaking event for anyone who pinned it. Assume the version stays
   reachable forever and that a lockfile can still resolve it.
3. **Deprecate rather than delete.** `npm deprecate avito-mcp@<bad> "<why, and
   which version to use>"` puts a warning in front of every install of that
   exact version. It is the only mechanism that reaches consumers who already
   pinned it.
4. **The MCP Registry entry is equally irreversible.** Publication there cannot
   be withdrawn. The correction is a new version published with corrected
   metadata; the registry is in preview and its data may be reset independently,
   which is a reason to not treat it as a control surface during an incident.
5. **Record it in `CHANGELOG.md`** under the version that superseded it. A
   dist-tag move that leaves no written trace is a version that mysteriously
   stopped being installed.

Expected duration: minutes for step 1, hours before consumer installs converge,
and never for steps 2 and 4.

---

## 7. The observation window (the outstanding half of M7.8)

After `dual` is on in production, the criteria of §4 are evaluated for **at
least 7 consecutive days**, and the result is recorded — including a clean run,
which is the outcome that otherwise leaves no evidence that anything was
watched.

Cadence: R1, R3 and the R3 probe continuously for the first hour and every 15
minutes for the first 24 hours; R2, R4, R5, R6 hourly for 24 hours, then daily.
R7 once before the flip and once after.

The record goes in this section, as a table with one row per day:

| Day | Date | R1 | R2 | R3 | R4 (p95) | R5 | R6 | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | — | — | Not started: `dual` is not on in production (M7.7). |

Retention has to be arranged before the window opens, not during it — see §1.3,
precondition 2. A window whose first three days aged out of the journal is not
a seven-day observation.

---

## 8. What this document does not close

- **The observation itself.** §7 is a form with no data in it. M7.8 stays open
  until it has seven rows and the criteria of §4 have been evaluated against
  real `dual` traffic.
- **`dual` in production.** M7.7 is an owner-run release; nothing here turns
  anything on.
- **The two preconditions of §1.3.** Both are edits under `/etc`, both are the
  owner's, and until both are done §4 computes over an empty log — which reads
  identical to a healthy deployment. That is the most dangerous state this
  document can be in, and it is why §1.3 comes before the criteria rather than
  after them.
- **Per-request observability inside the server.** JSON-RPC error codes, tool
  names and principals are not recorded anywhere. Every criterion above works
  around that by measuring the HTTP envelope instead. It is a real limit and the
  reason §5 has four rows instead of none.
- **Double execution of a money/public operation.** Removed from the triggers,
  assigned to M1.15, compensated but not measured.
