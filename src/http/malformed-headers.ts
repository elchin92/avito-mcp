/**
 * §1.2.A item 6 of the migration plan, the one cell of it Express never sees:
 * a mirrored SEP-2243 header whose VALUE carries a byte outside the HTTP token
 * set.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The revision requires `-32020` + HTTP 400 when a standard header is missing,
 * corrupted, or disagrees with the body (`docs/mcp-2026-07-28/seps-3.md` §3.7:
 * «Условия провала валидации: … значение заголовка содержит недопустимые
 * символы», answered by `HeaderMismatch` = `-32020`). Every other cell of that
 * matrix is answered by the SDK, because the request reaches it. This one does
 * not: Node's HTTP parser (llhttp) refuses the message at the byte itself, and
 * the connection is answered by `node:http` with
 *
 *     HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n
 *
 * — the right status and an EMPTY body, measured on v22.23.1 with
 * `err.code === 'HPE_INVALID_HEADER_TOKEN'`, `err.reason === 'Invalid header
 * value char'`. Nothing downstream of the parser can answer, because nothing
 * downstream of the parser is ever called.
 *
 * The one hook Node offers is `'clientError'`, which hands over the error and
 * the socket before the default answer is written. That is enough, and it is
 * enough PRECISELY, because `err.bytesParsed` points at the offending byte: the
 * header line being parsed when llhttp stopped is the text between the last
 * `\n` before that offset and the offset itself, so the header that was
 * corrupted can be NAMED rather than guessed.
 *
 * llhttp reports the fault under three codes, all measured on v22.23.1 with a
 * value of `Mcp-Name` and all meaning "this byte may not appear in a field
 * value": `HPE_INVALID_HEADER_TOKEN` («Invalid header value char») for a
 * control byte, DEL or NUL; `HPE_CR_EXPECTED` («Missing expected CR after
 * header value») for a bare LF; `HPE_LF_EXPECTED` for a bare CR. The last two
 * are the header-injection attempt SEP-2243's security section is about, and
 * they are the reason the set is read off the fault rather than off the byte.
 *
 * ── What this deliberately does not do ──────────────────────────────────────
 * Attaching a `'clientError'` listener suppresses Node's own answer for EVERY
 * client error on that server, not just this one — `server.emit('clientError')`
 * returning true is what the default path checks. So the handler answers this
 * one fault and reproduces Node's own bytes for all the others: 400 by default,
 * 431 for `HPE_HEADER_OVERFLOW`, 408 for `ERR_HTTP_REQUEST_TIMEOUT`. Which of
 * those are actually measured, and which is transcribed, is stated where they
 * are declared below rather than rounded up to "all of them".
 *
 * It claims a fault only when ALL of these hold, and answers Node's own bytes
 * otherwise:
 *
 *   • the request line is `POST` at the MCP endpoint — a corrupted header on
 *     `/healthz` or on the OAuth router is not a protocol-level header
 *     mismatch and must not be dressed as one;
 *   • the corrupted header is one of the three SEP-2243 mirrors. `-32020` is
 *     `HeaderMismatch`, an assertion that a header and the body disagree; a
 *     stray byte in `X-Forwarded-For` asserts nothing about MCP, and answering
 *     `-32020` there would be inventing a comparison that never happened;
 *   • this process actually serves the 2026-07-28 leg. On the default `legacy`
 *     posture the mirrors are not part of the protocol at all, the 2025 wire is
 *     frozen to what 1.3.3 answered, and no listener is attached — Node's
 *     default stands, byte for byte, as it did in 1.3.3.
 *
 * The connection is closed either way: the message did not parse, so there is
 * no request to keep it for.
 */
import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Node's own `'clientError'` answers, reproduced byte for byte.
 *
 * The 431 is MEASURED: `test/conformance/errors.test.ts` drives an unmodified
 * `http.createServer()` into `HPE_HEADER_OVERFLOW` on every run and compares,
 * so a Node release that rewords it fails there rather than quietly making this
 * server the only one on the network saying something else. The 400 is measured
 * the same way, by every fault that falls through to it.
 *
 * The 408 is TRANSCRIBED from Node's `_http_server.js`, not measured: provoking
 * `ERR_HTTP_REQUEST_TIMEOUT` needs `requestTimeout` to win a race against
 * `headersTimeout`, which closes a merely-slow socket in silence — 34 of 40
 * attempts produced no answer at all. A probe that answers sometimes is worse
 * than none, so this one is stated instead of pretended.
 */
const NODE_DEFAULT_ANSWERS: ReadonlyMap<string, string> = new Map([
  ['HPE_HEADER_OVERFLOW', 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n'],
  ['ERR_HTTP_REQUEST_TIMEOUT', 'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n'],
]);
const NODE_DEFAULT_ANSWER = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n';

/**
 * The llhttp faults that mean "a byte in this header VALUE is not allowed
 * there". Anything else — a bad request line, a bad header name, an unparseable
 * chunk size — is not a claim about a mirrored header and is answered by
 * Node's own bytes.
 */
const INVALID_VALUE_BYTE_CODES: readonly string[] = [
  'HPE_INVALID_HEADER_TOKEN',
  'HPE_CR_EXPECTED',
  'HPE_LF_EXPECTED',
];

/**
 * The three headers SEP-2243 requires a 2026-07-28 client to mirror. Keyed by
 * the lower-cased name, because RFC 9110 field names are case-insensitive (row
 * A6f); the value is the spelling the revision uses, so the error names the
 * header the way the client's own code does.
 */
export const MIRRORED_HEADERS: ReadonlyMap<string, string> = new Map([
  ['mcp-protocol-version', 'MCP-Protocol-Version'],
  ['mcp-method', 'Mcp-Method'],
  ['mcp-name', 'Mcp-Name'],
]);

interface ParseFault extends Error {
  code?: string;
  rawPacket?: Buffer;
  bytesParsed?: number;
}

/**
 * The name of the header llhttp was in the middle of when it gave up, or
 * `undefined` when the bytes do not identify one.
 *
 * `bytesParsed` is the offset of the offending byte, so everything before it
 * parsed; the current header line therefore starts after the last `\n` before
 * that offset. A fault inside the header NAME (before its colon) yields
 * `undefined` on purpose — an unnamed header cannot be one of the mirrors.
 */
export function offendingHeaderName(raw: Buffer, bytesParsed: number): string | undefined {
  if (!Number.isInteger(bytesParsed) || bytesParsed <= 0 || bytesParsed > raw.length) {
    return undefined;
  }
  const parsed = raw.subarray(0, bytesParsed).toString('latin1');
  const line = parsed.slice(parsed.lastIndexOf('\n') + 1);
  const colon = line.indexOf(':');
  if (colon <= 0) return undefined;
  return line.slice(0, colon).trim().toLowerCase();
}

/**
 * True when the unparsed bytes open with a POST to the MCP endpoint.
 *
 * Only the request LINE is read, and only the part of it llhttp already
 * accepted — this is a decision about which error body to write on a connection
 * that is being torn down, never about routing, so it can afford to be strict
 * and refuse anything it does not recognise.
 */
export function targetsMcpEndpoint(raw: Buffer, path: string): boolean {
  const head = raw.subarray(0, 8192).toString('latin1');
  const eol = head.indexOf('\r\n');
  if (eol < 0) return false;
  const parts = head.slice(0, eol).split(' ');
  if (parts.length !== 3 || parts[0] !== 'POST') return false;
  const target = (parts[1] ?? '').split(/[?#]/)[0];
  return target === path || target === `${path}/`;
}

/** The `-32020` frame for a mirrored header the parser refused. */
export function headerMismatchFrame(header: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32020,
      message:
        `Bad Request: the ${header} header carries a byte outside the HTTP token set, so the ` +
        'request was refused by the HTTP parser and its value was never compared with the body',
      data: { header, reason: 'invalid header value char' },
    },
  });
}

/**
 * Decides the answer for one `'clientError'`, as a string of bytes to write.
 *
 * Split out from the listener so the decision is testable without a socket, and
 * so the listener itself stays small enough to read in one go.
 */
export function answerForClientError(err: ParseFault, mcpPath: string): string {
  const raw = err.rawPacket;
  const parsedTo = err.bytesParsed;
  if (
    INVALID_VALUE_BYTE_CODES.includes(err.code ?? '') &&
    Buffer.isBuffer(raw) &&
    typeof parsedTo === 'number' &&
    targetsMcpEndpoint(raw, mcpPath)
  ) {
    const canonical = MIRRORED_HEADERS.get(offendingHeaderName(raw, parsedTo) ?? '');
    if (canonical) {
      const frame = headerMismatchFrame(canonical);
      return (
        'HTTP/1.1 400 Bad Request\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(frame)}\r\n` +
        'Connection: close\r\n\r\n' +
        frame
      );
    }
  }
  return NODE_DEFAULT_ANSWERS.get(err.code ?? '') ?? NODE_DEFAULT_ANSWER;
}

/**
 * Attaches the responder. Call this ONLY when the process serves the modern
 * leg: on `legacy` no listener must exist, so Node's default answer is what a
 * 2025 client keeps seeing.
 */
export function attachMirroredHeaderResponder(server: HttpServer, mcpPath: string): void {
  server.on('clientError', (err: ParseFault, socket: Socket) => {
    // Node's own guard, kept: writing onto a socket that already carries a
    // partial response would corrupt the peer's view of it.
    if (socket.writable && socket.bytesWritten === 0) {
      socket.write(answerForClientError(err, mcpPath));
    }
    socket.destroy(err);
  });
}
