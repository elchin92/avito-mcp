/**
 * Домен `auth` — соответствует swaggers/Авторизация.json
 *
 * Все три tool'а работают БЕЗ Bearer-токена (это и есть auth) и шлют x-www-form-urlencoded.
 * Учитываем quirk: в swagger три пути выглядят как "/token", "/token‎", "/token‎‎"
 * (zero-width chars для уникальности JSON-ключей). Фактический URL у всех — /token.
 *
 * Этот домен в основном опционален для AI-агента: AvitoClient сам управляет токеном через
 * client_credentials внутри TokenStore. Tools полезны если агент явно хочет получить токен
 * (например, для authorization_code flow или для отладки).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  // 1. client_credentials — получение app-токена (то же, что делает TokenStore автоматически).
  defineTool(server, ctx, {
    name: 'auth_get_access_token',
    title: 'OAuth: токен приложения',
    risk: 'sensitive',
    description:
      'OAuth 2.0 client_credentials: получить access_token приложения. ' +
      'Возвращает {access_token, expires_in (сек), token_type}. ' +
      'Внутренне MCP-сервер уже делает это автоматически — используйте только для отладки. ' +
      'client_id/client_secret подставляются из .env, передавать не нужно.',
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

  // 2. authorization_code — обмен кода авторизации на токен пользователя.
  defineTool(server, ctx, {
    name: 'auth_get_access_token_authorization_code',
    title: 'OAuth: обмен кода авторизации',
    risk: 'sensitive',
    description:
      'OAuth 2.0 authorization_code: обмен кода авторизации (полученного после редиректа ' +
      'с https://avito.ru/oauth) на access_token + refresh_token для работы от лица пользователя. ' +
      'Возвращает {access_token, refresh_token, expires_in, scope, token_type}. ' +
      'client_id/client_secret подставляются из .env, передавайте только code.',
    method: 'POST',
    path: '/token',
    auth: false,
    domain: 'auth',
    input: {
      code: z
        .string()
        .min(1)
        .describe('Код, полученный из redirect URI после подтверждения прав пользователем'),
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

  // 3. refresh_token — обновление токена пользователя.
  defineTool(server, ctx, {
    name: 'auth_refresh_access_token_authorization_code',
    title: 'OAuth: обновить токен пользователя',
    risk: 'sensitive',
    description:
      'OAuth 2.0 refresh_token: обновление истёкшего access_token пользователя через refresh_token. ' +
      'Возвращает новые {access_token, refresh_token, expires_in, scope, token_type}. ' +
      'client_id/client_secret подставляются из .env, передавайте только refresh_token.',
    method: 'POST',
    path: '/token',
    auth: false,
    domain: 'auth',
    input: {
      refresh_token: z
        .string()
        .min(1)
        .describe('Refresh-токен, полученный при первичной authorization_code авторизации'),
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
