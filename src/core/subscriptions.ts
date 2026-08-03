/**
 * A9 — narrowing a `subscriptions/listen` filter to what this server can
 * actually deliver.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * The revision makes the acknowledgement the client's contract: the stream
 * opens with `notifications/subscriptions/acknowledged` carrying "the subset of
 * the requested filter the server actually honored". The SDK's `honoredSubset`
 * narrows the three list-changed bits against the declared capabilities, but
 * copies the URI list through untouched:
 *
 *   if (requested.resourceSubscriptions !== undefined
 *       && requested.resourceSubscriptions.length > 0
 *       && allow(capabilities?.resources?.subscribe))
 *     honored.resourceSubscriptions = [...requested.resourceSubscriptions];
 *
 * (`@modelcontextprotocol/server`, `honoredSubset`.) So a client that asked for
 * `avito://manifest` — a static file with no publisher — was told "yes" and
 * then waited forever, which is precisely the failure mode the ack exists to
 * prevent. Worse, `file:///etc/passwd` was acknowledged too: an ack for a URI
 * the server has no concept of is a free signal that the server accepts foreign
 * schemes, and it echoes the caller's path back in a server-authored frame.
 *
 * ── Where the narrowing happens ─────────────────────────────────────────────
 *
 * On the REQUEST, before the SDK's listen router sees it, on both transports:
 * `src/http/mcp-http.ts` for the HTTP leg and `src/stdio-era.ts` for stdio.
 * Narrowing the request rather than the ack means there is exactly one place
 * where the honoured set is decided, and the SDK's own ack-building,
 * subscription-id stamping and per-stream filtering keep working unmodified —
 * they simply operate on a filter that is already true.
 *
 * The allow-list is `subscribableResourceUris(config)`, the same policy
 * function that decides which resources are listed at all, so a resource hidden
 * by `AVITO_MCP_MODE` or by `AVITO_MCP_CONFIRMATION_MODE=off` cannot be
 * subscribed to either.
 */

/** Whether a value is a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns `body` with `params.notifications.resourceSubscriptions` reduced to
 * the URIs in `allowed`, preserving the caller's order and dropping duplicates.
 *
 * Returns the SAME reference when there is nothing to change — the hot path is
 * every modern message, and a `subscriptions/listen` is a rare one.
 *
 * When nothing survives, the key is removed rather than left as `[]`: the SDK's
 * `honoredSubset` treats an empty array as "not requested" and omits the field,
 * so removing it produces exactly the ack an honest "none of that is on offer"
 * should produce, on both code paths.
 */
export function narrowListenRequest(body: unknown, allowed: ReadonlySet<string>): unknown {
  if (!isPlainObject(body)) return body;
  if (body.method !== 'subscriptions/listen') return body;
  const params = body.params;
  if (!isPlainObject(params)) return body;
  const notifications = params.notifications;
  if (!isPlainObject(notifications)) return body;
  const requested = notifications.resourceSubscriptions;
  if (!Array.isArray(requested)) return body;

  const honored: string[] = [];
  for (const uri of requested) {
    if (typeof uri === 'string' && allowed.has(uri) && !honored.includes(uri)) honored.push(uri);
  }
  if (honored.length === requested.length && honored.every((uri, i) => uri === requested[i])) {
    return body;
  }

  const narrowedNotifications: Record<string, unknown> = { ...notifications };
  if (honored.length > 0) narrowedNotifications.resourceSubscriptions = honored;
  else delete narrowedNotifications.resourceSubscriptions;

  return {
    ...body,
    params: { ...params, notifications: narrowedNotifications },
  };
}

/** The URIs dropped from a filter, for logging. Never sent back to the caller. */
export function droppedSubscriptionUris(body: unknown, allowed: ReadonlySet<string>): string[] {
  if (!isPlainObject(body) || body.method !== 'subscriptions/listen') return [];
  const params = body.params;
  if (!isPlainObject(params)) return [];
  const notifications = params.notifications;
  if (!isPlainObject(notifications)) return [];
  const requested = notifications.resourceSubscriptions;
  if (!Array.isArray(requested)) return [];
  return requested.filter((uri): uri is string => typeof uri === 'string' && !allowed.has(uri));
}
