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

import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import type { HttpConfig } from '../../config.js';
import { AvitoOAuthProvider } from './provider.js';

export interface OAuthSubsystem {
  router: Router;
  requireAuth: RequestHandler;
  provider: AvitoOAuthProvider;
}

/**
 * Builds the OAuth router, the bearer-auth middleware and the provider.
 *
 * @param httpConfig the resolved HTTP config; `publicUrl` is the OAuth issuer and
 *                   `publicUrl + '/mcp'` is the protected resource server URL.
 */
export function createOAuthSubsystem(httpConfig: HttpConfig): OAuthSubsystem {
  const provider = new AvitoOAuthProvider(httpConfig);

  const issuerUrl = new URL(httpConfig.publicUrl);
  const resourceServerUrl = new URL(httpConfig.publicUrl + '/mcp');

  const router = express.Router();
  // Body parser for the consent POST (the SDK's own routers parse their own
  // bodies; this one is ours). extended:false matches the SDK's usage.
  router.post(
    '/authorize/approve',
    express.urlencoded({ extended: false }) as RequestHandler,
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
    // Matches the path mcpAuthMetadataRouter serves for a resource server at /mcp.
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  return { router, requireAuth, provider };
}
