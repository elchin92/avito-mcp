# ADR 0007 — Deployment checks and rollback

Status: accepted
Date: 2026-08-02
Updated: 2026-09-07
Context: observable rollout criteria, stage M6.8

[Release runbook](../releases.md) · [Operations](../operations.md) · [Migration](../../MIGRATION.md)

Use this runbook when enabling a different protocol era or deploying a release. The thresholds below are rollout criteria, not universal service-level objectives. Record the release, configuration, baseline and affected clients before starting.

Commands assume Linux, systemd, Caddy and `jq`. Replace example hostnames, paths and optional unit names with the deployment's values. Public reports should contain redacted measurements, never credentials or raw customer data.

## 1. Available measurements

The application emits lifecycle, error and capacity events, but no complete per-request access or durable mutation audit log. Use the reverse proxy for HTTP status and duration. A proxy cannot see JSON-RPC errors inside a successful HTTP response.

The following messages and fields are checked against source by `test/conformance/rollback-runbook.test.ts`:

| `msg`                                     | Fields                          | Where it is written    |
| ----------------------------------------- | ------------------------------- | ---------------------- |
| `avito-mcp started`                       | `version`, `transport`, `mode`  | `src/server.ts`        |
| `avito-mcp shutting down`                 | `signal`                        | `src/server.ts`        |
| `mcp http modern in-flight limit reached` | `era`, `inflight`, `max`        | `src/http/mcp-http.ts` |
| `mcp http modern stream limit reached`    | `era`, `openStreams`, `max`     | `src/http/mcp-http.ts` |
| `mcp http session limit reached`          | `active`, `initializing`, `max` | `src/http/mcp-http.ts` |
| `mcp http modern adapter error`           | `era`, `err`                    | `src/http/mcp-http.ts` |
| `mcp http era dispatch failed`            | `err`                           | `src/http/mcp-http.ts` |
| `mcp http request handling failed`        | `err`                           | `src/http/mcp-http.ts` |
| `http request error`                      | `path`, `status`, `err`         | `src/http/app.ts`      |
| `malformed JSON-RPC body on /mcp`         | `err`                           | `src/http/app.ts`      |
| `5xx from avito, retrying`                | `url`, `status`, `retries5xx`   | `src/core/client.ts`   |

### 1.1 stdio processes

A client starts and stops its stdio child. Capture stderr through that client or supervisor; stdout carries MCP messages and must remain untouched. For a systemd-managed child, read its journal. The optional example unit in this runbook is `avito-mcp-second.service`; it is a placeholder, not a required installation component.

A durable server-owned mutation audit trail remains open as M1.15. Process logs do not establish that a business action executed exactly once.

### 1.2 Caddy access log

The [Caddy example](../../deploy/Caddyfile.example) enables explicit JSON access logging:

```caddyfile
log {
    output stderr
    format json
}
log_skip /avito/webhook*
```

Keep credential logging disabled. Webhook secrets are part of the URL path, so header redaction does not protect them. The prefix skip covers paths under `/avito/webhook`; add equivalent coverage before changing `AVITO_MCP_WEBHOOK_PATH`.

`log_skip` affects access logs only. Caddy `http.log.error` entries can still include the path when the upstream is unavailable. Keep journals private, check error logging separately, and rotate a webhook secret if its URL was exposed.

For era attribution, the proxy can inspect `Mcp-Protocol-Version`. A request naming `2026-07-28` is modern; other requests, including legacy initialization without a version header, are classified as legacy for these measurements.

### 1.3 Logging and retention prerequisites

1. Enable the reviewed logging configuration in the running proxy and verify actual `/mcp` entries. The repository example alone does not configure a host.

   ```bash
   caddy validate --config /etc/caddy/avito-mcp.Caddyfile --adapter caddyfile
   systemctl reload caddy
   journalctl -u caddy --since "-1min" --no-pager -o cat \
     | jq -Rc 'fromjson? | select(.msg == "handled request") | .request.uri' | head
   ```

2. Probe every configured webhook receiver with a fictional path secret while its upstream is healthy. For the example topology, check both `avito-mcp.service` and `avito-mcp-second.service`. Neither probe path should appear in the access log. Check `http.log.error` separately during controlled failure testing; an access-log skip does not suppress it.
3. Keep logs for at least the full observation window and check for suppressed entries before starting.

   ```bash
   journalctl --disk-usage
   journalctl --no-pager -o short-iso | head -1
   journalctl --since "7 days ago" --no-pager | rg 'Suppressed'
   ```

An empty or sampled log is missing evidence, not evidence of a healthy service.

## 2. Establish a baseline

Capture 24 hours on the same release before switching protocol era. Keep the result in a private deployment record. Use ordinary POST calls for latency; exclude modern subscription streams from both baseline and comparison.

```bash
journalctl -u caddy --since "-24h" --no-pager -o cat \
| jq -Rc 'fromjson?
    | select(.msg == "handled request" and .request.uri == "/mcp")
    | select(.request.method == "POST")
    | select(((.request.headers["Mcp-Method"] // [])[0]) != "subscriptions/listen")' \
| jq -s '{
    total: length,
    refused: (map(select(.status == 400 or .status == 404)) | length),
    p95: ((map(.duration) | sort) as $d | $d[($d | length * 0.95 | floor)])
  }'
```

Ratios below require at least 50 requests; extend the observation if traffic is lower. Do not treat an empty sample as a zero error rate. Absolute latency and failure criteria still apply.

## 3. Response levels

- **Level 1:** restore `legacy` when the regression is caused by the optional modern era.
- **Level 2:** redeploy a compatible known-good release when the problem persists.
- **Level 3:** correct npm release discovery when package consumers are affected.

Preserve diagnostic evidence before changing the installation. A rollback does not undo an action already applied to Avito.

## 4. Rollout criteria

### R1 — the legacy leg answered with a status the 1.3.3 wire never produced

The immutable legacy baseline records **200, 202, 400, 404, 415**. The authorization layer also uses **401** and **403**; the body limit uses **413**. An unexpected status on a legacy-classified request can indicate incorrect revision dispatch.

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
  | select(.status as $status | [200, 202, 400, 401, 403, 404, 413, 415] | index($status) | not)
  | {ts, status, method: .request.method, ua: (.request.headers["User-Agent"] // [])[0]}'
```

### R2 — the legacy leg started refusing more than it did

Compare the share of legacy HTTP refusals with the baseline. Individual 400/404 responses can be valid responses to malformed requests or missing sessions.

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

Investigate every 5xx during rollout. A 500 can indicate a server error; a 503 can indicate intentional capacity rejection. Check R5 to distinguish saturation from a crash or dispatch regression.

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

Probe OAuth with a newly generated, never-issued token. The expected status is `401` with the resource metadata challenge. Substitute your deployment hostname.

```bash
# Generate a deliberately invalid token; never use a real credential.
bogus="never-issued-$(date +%s)"
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 \
  -X POST https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${bogus}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- **Trigger:** any answer other than `401`.
- **Window:** run it immediately after the flip, then every 5 minutes for the
  first hour, then hourly.
- **Rollback level:** 1.

### R4 — latency grew

Compute duration for POST requests, excluding modern subscription streams. Use the same selection for the baseline; a long-lived subscription duration is not tool-call latency.

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

Modern in-flight and stream limits produce explicit process log entries. Track these with the legacy session limit and compare against traffic volume.

- **Trigger:** ≥ 1 occurrence in an hour is investigated; ≥ **10** in an hour, or
  any occurrence at all while `/mcp` traffic is below the baseline volume of §2,
  is a rollback. The second arm is the one that matters: hitting a concurrency
  limit on _less_ traffic than before means slots are leaking, not that load
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

Inspect process restarts independently of request counts; a crash can reduce traffic enough to hide error rates.

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

Run the immutable legacy wire baseline against the intended build. Declared correctness and safety differences are explicit in the harness; an undeclared mismatch fails the gate.

- **Trigger:** **0** tolerated failing steps — any one of the recorded is enough. Not
  a rate, and there is no window over which a failure averages out: the bench
  replays a recorded conversation, so a step either matches the bytes 1.3.3
  answered or it does not. The bench declares each intended difference by name
  (`KnownAddition`, `DeclaredDivergence`, `RebasedValue`, `DUAL_ERA_DELTAS`), so
  a failure is by construction an _undeclared_ difference.
- **Window:** once before the flip and once after; not continuous.
- **Rollback level:** 2 before the flip (the release itself moved the wire), 1
  after (only the era changed).

```bash
# Run from the checked-out release directory after npm ci.
npx vitest run test/legacy-wire-regression.test.ts
```

---

## 5. Limits of the measurements

The original rollout criteria are accounted for below. HTTP status is an observable proxy for some failures, but it cannot identify every protocol-level cause.

| Original criterion                                                     | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP 500 instead of 401 on an invalid Bearer token                     | **Kept**, as the active probe in R3. It cannot be found by mining logs — the log holds no token and no auth outcome — so it is measured by asking.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Rise in the share of 5xx on `/mcp` against the previous release        | **Kept** as R3, with the baseline strengthened: the recorded 1.3.3 wire has no 5xx at all, so the comparison is against zero rather than against a remembered rate.                                                                                                                                                                                                                                                                                                                                                                                    |
| `-32020` / `-32021` / `-32022` appearing for clients that used to work | **Replaced** by R1 and R2. The codes themselves are unobtainable: no log line carries a JSON-RPC code, and the proxy sees only the envelope. All three are answered with HTTP 400 on the modern leg, and none of them exists on the legacy leg — so "a legacy request answered 400/404 more often than before" is the same event, observed where it is actually recorded. The exact form needs a per-request log inside the server, which nothing in the plan currently asks for; it is written down here as debt rather than as a metric that exists. |
| Rise in `-32602` on the legacy branch                                  | **Replaced** by R2, for the same reason and by the same mapping.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Any divergence of the M1.1 wire snapshot                               | **Kept** as R7, moved out of the traffic metrics: it is a gate run against a build, not a number read off production.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A money/public operation executed twice under one `idempotencyKey`     | **Removed from the automatic triggers**, and assigned to **M1.15**. `idempotent_replay` is a field of the _response_, not of any log line; the durable audit trail that would record an execution does not exist. Nothing this deployment writes can distinguish one execution from two.                                                                                                                                                                                                                                                               |

Keep confirmations enabled and preserve the durable idempotency ledger. Neither a nonempty ledger nor a confirmation proves that every upstream mutation executed exactly once. Investigate reported duplicate actions against the Avito account; this remains manual until M1.15 supplies a durable execution audit.

## 6. Rollback procedure

### 6.0 Deployment facts to verify

- In the example topology, `avito-mcp.service` and the optional `avito-mcp-second.service` execute `/opt/avito-mcp/current/dist/server.js`. Identify every actual unit using that path before a release rollback.
- `deploy/install-services.sh` manages `avito-mcp.service` and `caddy.service`. Any additional server unit needs an explicit restart and verification.
- Extra units may read different private environment files. Preserve each unit's intended configuration.
- A running process keeps its original release directory after a symlink change. Verify `/proc/<pid>/cwd` and `/healthz`, not just the link.
- `AVITO_MCP_PROTOCOL_ERA` passes through the installer's allowed environment settings.

Substitute actual unit names for `avito-mcp-second.service`. If there is only one server unit, omit the second-unit commands; if there are more, include all of them.

### 6.1 Level 1 — restore the legacy era

Update the source configuration and the running unit's environment consistently so the next deployment does not restore the unwanted value.

```bash
sudoedit /etc/avito-mcp/avito-mcp.env  # set AVITO_MCP_PROTOCOL_ERA=legacy
systemctl restart avito-mcp.service
pid=$(systemctl show -p MainPID --value avito-mcp.service)
tr '\0' '\n' < /proc/$pid/environ | rg '^AVITO_MCP_PROTOCOL_ERA='
curl -fsS --max-time 3 http://127.0.0.1:3000/healthz
curl -fsS --max-time 3 http://127.0.0.1:3000/readyz
```

An unset variable also selects legacy. Apply the same change to any other unit that enabled the affected era. Re-run R1, R3 and the OAuth probe before closing the incident.

### 6.2 Level 2 — redeploy a known-good release

Review [migration and state compatibility](../../MIGRATION.md#verify-and-recover) first. Preserve runtime state, pending claims and idempotency records; an older release may not enforce a newer hold reason. Use a checkout of the selected release and the normal [transactional installer](../releases.md#deploy-the-released-version).

```bash
# In the selected release checkout, with its private deployment configuration:
npm ci
npm run verify:release
sudo deploy/install-services.sh --start

# Ensure every actual server unit using the shared release has restarted.
systemctl restart avito-mcp.service
systemctl restart avito-mcp-second.service

for unit in avito-mcp.service avito-mcp-second.service; do
  pid=$(systemctl show -p MainPID --value "$unit")
  printf '%s release=%s\n' "$unit" "$(readlink -f /proc/$pid/cwd)"
done
curl -fsS --max-time 3 http://127.0.0.1:3000/healthz
curl -fsS --max-time 3 http://127.0.0.1:3000/readyz
```

The installer validates readiness and the installed version for its managed service. Check equivalent endpoints and process directories for additional units. All must report the intended release. Do not manually rewrite an immutable release directory under the same version.

Keep issuer behavior and metadata consistent: advertising issuer-parameter support without returning `iss` breaks authorization. Test the OAuth flow after a downgrade.

### 6.3 Level 3 — correct package discovery

Use the repository's release permissions and record the action in release notes.

1. If needed, move npm `latest` to a verified known-good version with `npm dist-tag add avito-mcp@VERSION latest`. This affects future unpinned installs only.
2. Deprecate an affected version with an explanation and the replacement version. A tag change does not reach consumers pinned to it.
3. Treat published versions and Git tags as immutable. Publish a correction under a new version rather than replacing an artifact.
4. Verify npm and MCP Registry state separately. A successful publication to one does not prove publication to the other.

Do not assume deletion or unpublishing is available. Review current registry controls before an incident action that affects existing consumers.

## 7. Observation window

For a protocol-era rollout, record at least 7 consecutive days. Check failures and the OAuth probe frequently during the first hour, then at least hourly during the first day. Evaluate the remaining criteria hourly for the first day and daily thereafter. Run R7 before and after the change.

| Day     | Date       | Version | R1    | R2    | R3    | R4 p95  | R5    | R6       | Result               |
| ------- | ---------- | ------- | ----- | ----- | ----- | ------- | ----- | -------- | -------------------- |
| Example | YYYY-MM-DD | VERSION | count | share | count | seconds | count | restarts | Pass/fail and action |

Store actual observations with the deployment record. This template contains no production result and does not establish that an observation window has completed.

## 8. Remaining work

- **M7.7:** verify the selected protocol era, proxy logging and retention on the target deployment.
- **M7.8:** complete and record the seven-day observation; a runbook is not the result.
- **M1.15:** add a durable execution audit for investigating duplicate mutations.
- Protocol error codes inside HTTP 200, complete per-tool latency and caller attribution are not provided by the proxy measurements above.
