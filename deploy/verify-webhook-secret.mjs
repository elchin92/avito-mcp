#!/usr/bin/env node
// Refuse a deploy that would silently move the webhook receiver's public address.
//
// The receiver's public URL is derived FROM the secret:
//   <AVITO_MCP_WEBHOOK_PUBLIC_URL><AVITO_MCP_WEBHOOK_PATH>/<AVITO_MCP_WEBHOOK_SECRET>
// (src/domains/webhook.ts, configuredWebhookReceiverUrl). install-services.sh
// re-renders the entire service environment from the checkout on every deploy, so a
// checkout whose AVITO_MCP_WEBHOOK_SECRET was not rotated together with the live
// Avito subscription silently moves that address out from under the subscription.
//
// Nothing downstream notices. The receiver answers 200 to ANY secret on purpose
// (src/http/webhook.ts, uniformOk: the address must not be discoverable by response
// code or timing), so Avito keeps recording the delivery as successful and never
// unsubscribes; the service logs no error; the access log skips the receiver path
// (deploy/Caddyfile, log_skip). The only outward symptom is the webhook event log
// quietly ceasing to grow. On 2026-09-07 that failure ran 6 h 49 min unnoticed.
//
// Two checks, in order of certainty:
//   1. offline — rendered secret vs the secret the installed service currently runs
//      with. A change here moves the public address; fatal unless declared.
//   2. online  — rendered receiver URL vs the account's live subscriptions. This is
//      the real invariant (Avito must deliver where we listen), but it needs the
//      network, so being unable to answer only warns.
//
// Secrets never reach stdout/stderr: only lengths and 12-hex sha256 prefixes.
//
// Usage:  verify-webhook-secret.mjs <release-package.json> <base.env> <remote.env>
//                                   [installed-service.env]
// Exit:   0 ok · 2 usage · 3 mismatch (installer must abort) · 4 undetermined.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const OK = 0;
const USAGE = 2;
const MISMATCH = 3;
const UNDETERMINED = 4;
const REQUEST_TIMEOUT_MS = Number(process.env.AVITO_MCP_DEPLOY_CHECK_TIMEOUT_MS || 8000);

const [packageJson, baseEnv, remoteEnv, serviceEnv] = process.argv.slice(2);
if (!packageJson || !baseEnv || !remoteEnv) {
  process.stderr.write(
    'Usage: verify-webhook-secret.mjs <release-package.json> <base.env> <remote.env> ' +
      '[installed-service.env]\n',
  );
  process.exit(USAGE);
}

const say = (line) => process.stderr.write(`webhook-check: ${line}\n`);
const flag = (name) => (process.env[name] ?? '').trim() === '1';
const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

if (flag('AVITO_MCP_DEPLOY_SKIP_WEBHOOK_CHECK')) {
  say('skipped by AVITO_MCP_DEPLOY_SKIP_WEBHOOK_CHECK=1');
  process.exit(OK);
}

const require = createRequire(packageJson);
const { parse } = require('dotenv');
const readEnv = (file) => parse(readFileSync(file));

// Same precedence as render-service-env.mjs: the remote overlay wins.
const merged = { ...readEnv(baseEnv), ...readEnv(remoteEnv) };
const nextSecret = (merged.AVITO_MCP_WEBHOOK_SECRET ?? '').trim();
if (nextSecret === '') {
  say('the checkout configures no webhook secret; receiver stays disabled, nothing to check');
  process.exit(OK);
}
const nextPrint = fingerprint(nextSecret);

// ─── 1. Offline: does this deploy change the address the service serves? ─────
let installedSecret;
if (serviceEnv) {
  try {
    installedSecret = (readEnv(serviceEnv).AVITO_MCP_WEBHOOK_SECRET ?? '').trim() || undefined;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const rotationDeclared = flag('AVITO_MCP_DEPLOY_ALLOW_WEBHOOK_SECRET_CHANGE');
if (installedSecret !== undefined && installedSecret !== nextSecret) {
  say(
    `the rendered webhook secret differs from the one the service is running with ` +
      `(installed sha256=${fingerprint(installedSecret)} len=${installedSecret.length}, ` +
      `checkout sha256=${nextPrint} len=${nextSecret.length})`,
  );
  say('the public receiver address is built from this secret, so this deploy moves it');
  if (!rotationDeclared) {
    say('refusing: rotate the checkout to the live secret, or declare an intentional rotation');
    say('with AVITO_MCP_DEPLOY_ALLOW_WEBHOOK_SECRET_CHANGE=1 and re-subscribe right after');
    process.exit(MISMATCH);
  }
  say('AVITO_MCP_DEPLOY_ALLOW_WEBHOOK_SECRET_CHANGE=1: treating it as an intentional rotation');
  say('you MUST re-subscribe the new address at Avito, or deliveries stop silently');
  process.exit(OK);
}

if (installedSecret === undefined) {
  say('no installed service environment to compare against (first install)');
} else {
  say(`the deploy keeps the installed webhook secret (sha256=${nextPrint})`);
}

// ─── 2. Online: does Avito deliver where we will be listening? ───────────────
if ((process.env.AVITO_MCP_DEPLOY_VERIFY_SUBSCRIPTION ?? '').trim() === '0') {
  say('subscription check disabled by AVITO_MCP_DEPLOY_VERIFY_SUBSCRIPTION=0');
  process.exit(OK);
}

const undetermined = (reason) => {
  say(`could not verify the live subscription: ${reason}`);
  process.exit(UNDETERMINED);
};

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');
const publicUrl = stripTrailingSlash(
  (merged.AVITO_MCP_WEBHOOK_PUBLIC_URL ?? merged.AVITO_MCP_HTTP_PUBLIC_URL ?? '').trim(),
);
if (publicUrl === '') undetermined('no public URL is configured for the receiver');
const rawPath = (merged.AVITO_MCP_WEBHOOK_PATH ?? '').trim() || '/avito/webhook';
const path =
  stripTrailingSlash(rawPath.startsWith('/') ? rawPath : `/${rawPath}`) || '/avito/webhook';
const prefix = `${publicUrl}${path}/`;
const expectedUrl = `${prefix}${encodeURIComponent(nextSecret)}`;

const clientId = merged.Client_id ?? merged.CLIENT_ID;
const clientSecret = merged.Client_secret ?? merged.CLIENT_SECRET;
if (!clientId || !clientSecret) undetermined('the checkout carries no API credentials');
const apiBase = stripTrailingSlash((merged.AVITO_BASE_URL ?? '').trim() || 'https://api.avito.ru');

const post = async (url, init) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    undetermined(`${new URL(url).pathname} is unreachable (${error?.name || 'error'})`);
    return undefined;
  }
};

const tokenResponse = await post(`${apiBase}/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }),
});
if (!tokenResponse.ok) undetermined(`/token answered ${tokenResponse.status}`);
const token = (await tokenResponse.json().catch(() => ({})))?.access_token;
if (typeof token !== 'string' || token === '') undetermined('/token returned no access_token');

const subsResponse = await post(`${apiBase}/messenger/v1/subscriptions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: '{}',
});
if (!subsResponse.ok) undetermined(`/messenger/v1/subscriptions answered ${subsResponse.status}`);
const subscriptions = (await subsResponse.json().catch(() => ({})))?.subscriptions;
if (!Array.isArray(subscriptions)) undetermined('the subscription list could not be parsed');

// Only subscriptions under OUR receiver base are ours to judge. The same account
// legitimately carries other integrations' URLs on other hosts, and this check must
// never comment on them, let alone fail a deploy because of them.
const ours = subscriptions.filter(
  (entry) => typeof entry?.url === 'string' && entry.url.startsWith(prefix),
);
if (ours.length === 0) {
  undetermined(
    `no subscription points at ${prefix}<secret> ` +
      `(${subscriptions.length} subscription(s) on the account, all on other addresses)`,
  );
}
if (ours.some((entry) => entry.url === expectedUrl)) {
  say(`the live subscription matches the rendered address (secret sha256=${nextPrint})`);
  process.exit(OK);
}

say(
  `Avito delivers to ${prefix}<secret> with a DIFFERENT secret: ` +
    ours
      .map((entry) => `sha256=${fingerprint(decodeURIComponent(entry.url.slice(prefix.length)))}`)
      .join(', ') +
    `, this deploy would serve sha256=${nextPrint}`,
);
say('refusing: deliveries would be dropped silently (the receiver answers 200 to any secret)');
process.exit(MISMATCH);
