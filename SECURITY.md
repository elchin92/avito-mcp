# Security Policy

`avito-mcp` runs on your machine and holds OAuth credentials for your Avito account. If you find a way that could leak those credentials, execute arbitrary code, or otherwise put a user at risk — please tell us privately before posting it anywhere public.

## How to report

Use **GitHub Private Vulnerability Reporting**:
**https://github.com/elchin92/avito-mcp/security/advisories/new**

Please include:
- Affected version (`npm view avito-mcp version` for latest)
- What the issue is and what an attacker could do
- A minimal reproduction — **do not** paste real `Client_id` / `Client_secret` / tokens. Use placeholders like `EXAMPLE_TOKEN`.

We'll reply on the same advisory thread. Once a fix is released, the advisory becomes public and you get credit (unless you'd rather stay anonymous).

## In scope

- Leakage of `Client_secret`, `access_token`, or `.avito-token.json` to logs, stdout, or any endpoint other than `api.avito.ru`.
- Arbitrary code execution from a malicious MCP-client message.
- TLS / certificate-validation bypasses against `api.avito.ru`.
- Race conditions in the OAuth token store that could expose tokens on shared machines.
- Confirmed vulnerable dependencies (with an exploit path through how we use them).

## Not in scope

- Avito API behaviour itself — rate limits, scope restrictions, deprecations. Report those to Avito support.
- Bugs in the MCP client (Claude Desktop, Cursor, etc.) — report to that project.
- A user accidentally pasting their own token somewhere public — that's a credential rotation problem, rotate it.

## Disclosure

Standard coordinated disclosure: please give us a reasonable window to ship a fix before discussing the issue publicly. After a patched version is on npm, write about it however you like.

---

Not a security issue? Use [regular GitHub Issues](https://github.com/elchin92/avito-mcp/issues).
