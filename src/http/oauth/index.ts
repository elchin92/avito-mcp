/**
 * v0.9.0: wires the self-hosted OAuth 2.1 subsystem into a single express.Router
 * plus a bearer-auth middleware for the protected /mcp endpoint.
 *
 * The returned router mounts, at the application root:
 *   - POST /authorize/approve  → the owner login/consent step (mints the code)
 *   - mcpAuthRouter(...)        → /authorize, /token, /register, /revoke and the
 *                                 .well-known metadata endpoints (RFC 8414 + 9728)
 *
 * `requireAuth` is requireBearerAuth bound to the same provider; on a 401 it
 * advertises the protected-resource metadata URL so MCP clients can discover the
 * authorization server. We derive that URL from the SDK's own helper so it is
 * guaranteed to match the path the router serves
 * (`/.well-known/oauth-protected-resource/mcp` for a resource server at /mcp).
 */
import express from 'express';
import type { Router, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';

import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import type { HttpConfig } from '../../config.js';
import { AvitoOAuthProvider } from './provider.js';

export interface OAuthSubsystem {
  router: Router;
  requireAuth: RequestHandler;
  provider: AvitoOAuthProvider;
  close(): Promise<void>;
}

/**
 * Builds the OAuth router, the bearer-auth middleware and the provider.
 *
 * @param httpConfig the resolved HTTP config; `publicUrl` is the OAuth issuer and
 *                   `publicUrl + '/mcp'` is the protected resource server URL.
 */
export function createOAuthSubsystem(httpConfig: HttpConfig): OAuthSubsystem {
  const provider = new AvitoOAuthProvider(httpConfig);
  try {
    const issuerUrl = new URL(httpConfig.publicUrl);
    const resourceServerUrl = new URL(httpConfig.publicUrl + '/mcp');

    const router = express.Router();
    // The SDK's registration router has its own JSON parser, but the application
    // used to pre-parse every JSON body with a 4 MiB limit. Parse DCR here first so
    // recognized large fields such as software_statement cannot bypass a tight
    // endpoint-specific cap.
    router.post('/register', express.json({ limit: '32kb', strict: true }));
    // Body parser for the consent POST (the SDK's own routers parse their own
    // bodies; this one is ours). extended:false matches the SDK's usage.
    //
    // Rate limit: this endpoint verifies the OWNER PASSWORD — the single gate to
    // minting tokens. The SDK rate-limits the endpoints it mounts (/authorize,
    // /token, /register) but this custom route is ours to protect; without a
    // limiter and with open DCR, the password is brute-forceable at line speed.
    // 10 attempts / 15 min / IP mirrors the strictest SDK sibling.
    router.post(
      '/authorize/approve',
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
          error: 'too_many_requests',
          error_description: 'Too many consent attempts. Try again in 15 minutes.',
        },
      }),
      express.urlencoded({ extended: false, limit: '16kb' }) as RequestHandler,
      provider.approveConsent,
    );

    router.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        resourceServerUrl,
        scopesSupported: ['avito:mcp'],
        resourceName: 'Avito MCP',
      }),
    );

    const requireAuth = requireBearerAuth({
      verifier: provider,
      requiredScopes: ['avito:mcp'],
      // Matches the path mcpAuthMetadataRouter serves for a resource server at /mcp.
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
    });

    // Convert parser failures on OAuth endpoints into a small OAuth-shaped error,
    // never Express' HTML diagnostics.
    router.use(((err, req, res, _next) => {
      const status = (err as { status?: unknown }).status === 413 ? 413 : 400;
      const registration = req.path === '/register';
      res.status(status).json({
        error: registration ? 'invalid_client_metadata' : 'invalid_request',
        error_description:
          status === 413
            ? registration
              ? 'Client metadata is too large'
              : 'Request body is too large'
            : 'Malformed request body',
      });
    }) as import('express').ErrorRequestHandler);

    return { router, requireAuth, provider, close: () => provider.close() };
  } catch (err) {
    provider.abortStartup();
    throw err;
  }
}
