/**
 * Domain `auth` — corresponds to swaggers/authorization.json
 *
 * All three tools work WITHOUT a Bearer token (this is auth itself) and send x-www-form-urlencoded.
 * Note the quirk: in swagger the three paths look like "/token", "/token‎", "/token‎‎"
 * (zero-width chars to keep JSON keys unique). The actual URL for all of them is /token.
 *
 * This domain is mostly optional for an AI agent: AvitoClient manages the token itself via
 * client_credentials inside TokenStore. The tools are useful when an agent explicitly wants to obtain a token
 * (for example, for the authorization_code flow or for debugging).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  // 1. client_credentials — obtaining an app token (the same thing TokenStore does automatically).
  defineTool(server, ctx, {
    name: 'auth_get_access_token',
    title: 'OAuth: application token',
    risk: 'sensitive',
    description:
      'OAuth 2.0 client_credentials: obtain an application access_token. ' +
      'Returns {access_token, expires_in (sec), token_type}. ' +
      'Internally the MCP server already does this automatically — use only for debugging. ' +
      'client_id/client_secret are filled in from .env, no need to pass them.',
    method: 'POST',
    path: '/token',
    auth: false,
    domain: 'auth',
    input: {},
    body: {
      contentType: 'application/x-www-form-urlencoded',
      defaults: (ctx) => ({
        grant_type: 'client_credentials',
        client_id: ctx.config.clientId,
        client_secret: ctx.config.clientSecret,
      }),
    },
  });

  // 2. authorization_code — exchanging an authorization code for a user token.
  defineTool(server, ctx, {
    name: 'auth_get_access_token_authorization_code',
    title: 'OAuth: exchange authorization code',
    risk: 'sensitive',
    description:
      'OAuth 2.0 authorization_code: exchange an authorization code (obtained after the redirect ' +
      'from https://avito.ru/oauth) for an access_token + refresh_token to act on behalf of the user. ' +
      'Returns {access_token, refresh_token, expires_in, scope, token_type}. ' +
      'client_id/client_secret are filled in from .env, pass only code.',
    method: 'POST',
    path: '/token',
    auth: false,
    domain: 'auth',
    input: {
      code: z
        .string()
        .min(1)
        .describe('The code obtained from the redirect URI after the user grants permissions'),
    },
    body: {
      contentType: 'application/x-www-form-urlencoded',
      fields: ['code'],
      defaults: (ctx) => ({
        grant_type: 'authorization_code',
        client_id: ctx.config.clientId,
        client_secret: ctx.config.clientSecret,
      }),
    },
  });

  // 3. refresh_token — refreshing a user token.
  defineTool(server, ctx, {
    name: 'auth_refresh_access_token_authorization_code',
    title: 'OAuth: refresh user token',
    risk: 'sensitive',
    description:
      'OAuth 2.0 refresh_token: refresh an expired user access_token via refresh_token. ' +
      'Returns a new {access_token, refresh_token, expires_in, scope, token_type}. ' +
      'client_id/client_secret are filled in from .env, pass only refresh_token.',
    method: 'POST',
    path: '/token',
    auth: false,
    domain: 'auth',
    input: {
      refresh_token: z
        .string()
        .min(1)
        .describe('The refresh token obtained during the initial authorization_code authorization'),
    },
    body: {
      contentType: 'application/x-www-form-urlencoded',
      fields: ['refresh_token'],
      defaults: (ctx) => ({
        grant_type: 'refresh_token',
        client_id: ctx.config.clientId,
        client_secret: ctx.config.clientSecret,
      }),
    },
  });
};
