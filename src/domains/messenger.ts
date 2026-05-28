/**
 * Домен `messenger` — соответствует swaggers/Мессенджер.json
 *
 * 13 endpoints: чтение/отправка сообщений, чаты, blacklist, webhooks, голосовые, изображения.
 *
 * Quirks:
 *   - sendMessage требует nested body `{ message: { text }, type: "text" }` — используем
 *     body.transform чтобы превратить плоский input {text} в нужную структуру.
 *   - uploadImages — multipart/form-data; LLM передаёт массив локальных путей,
 *     handler читает файлы и формирует FormData.
 *   - Webhook'и требуют ПУБЛИЧНЫЙ URL для приёма уведомлений (локально не работают).
 *
 * ⚠️ Write-методы реально влияют на боевой аккаунт:
 *   - postSendMessage / postSendImageMessage — настоящее сообщение клиенту
 *   - postBlacklistV2 — блокирует пользователя
 *   - deleteMessage — удаляет сообщение
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { logger } from '../logger.js';
import { defineTool, type DomainRegister } from '../core/tool-factory.js';
import { errorToMcpContent } from '../core/errors.js';
import { evaluatePolicy } from '../core/policy.js';
import { validateUpload, UploadGuardError } from '../core/upload-guard.js';

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── READ ──────────────────────────────

  defineTool(server, ctx, {
    name: 'messenger_get_chats_v2',
    title: 'Список чатов',
    risk: 'read',
    description:
      'Список чатов пользователя. Поддерживает фильтры: только непрочитанные, по объявлениям, ' +
      'по типам чатов (u2i/u2u), пагинация. Возвращает массив чатов с превью последнего сообщения.',
    method: 'GET',
    path: '/messenger/v2/accounts/{user_id}/chats',
    domain: 'messenger',
    input: {
      item_ids: z
        .string()
        .optional()
        .describe('CSV-список ID объявлений для фильтра (например "12345,6789").'),
      limit: z.number().int().min(1).max(100).optional().describe('Сколько чатов вернуть (1–100).'),
      offset: z.number().int().min(0).optional().describe('Смещение пагинации.'),
      unread_only: z.boolean().optional().describe('Только непрочитанные чаты.'),
      chat_types: z
        .string()
        .optional()
        .describe('CSV-список типов чатов: u2i (объявление), u2u (пользователь).'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id'],
    queryParams: ['item_ids', 'limit', 'offset', 'unread_only', 'chat_types'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_chat_by_id_v2',
    title: 'Чат по ID',
    risk: 'read',
    description: 'Детали одного чата по chat_id: участники, объявление, контекст, последнее сообщение.',
    method: 'GET',
    path: '/messenger/v2/accounts/{user_id}/chats/{chat_id}',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_messages_v3',
    title: 'Сообщения чата',
    risk: 'read',
    description:
      'Список сообщений чата (V3) с пагинацией. Возвращает массив сообщений ' +
      '(текст, изображения, голос, ссылки, дата).',
    method: 'GET',
    path: '/messenger/v3/accounts/{user_id}/chats/{chat_id}/messages/',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Сколько сообщений вернуть (1–100, по умолчанию 100).'),
      offset: z.number().int().min(0).optional().describe('Смещение пагинации.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    queryParams: ['limit', 'offset'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_voice_files',
    title: 'Голосовые сообщения',
    risk: 'read',
    description:
      'Получение URL для скачивания голосовых сообщений по их идентификаторам. ' +
      'Принимает CSV-список voice_ids.',
    method: 'GET',
    path: '/messenger/v1/accounts/{user_id}/getVoiceFiles',
    domain: 'messenger',
    input: {
      voice_ids: z.string().describe('CSV-список ID голосовых сообщений.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id'],
    queryParams: ['voice_ids'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_subscriptions',
    title: 'Webhook-подписки',
    risk: 'read',
    description: 'Текущие подписки на webhooks (URL получения уведомлений + статус).',
    method: 'POST',
    path: '/messenger/v1/subscriptions',
    domain: 'messenger',
    input: {},
  });

  // ────────────────────────────── WRITE ──────────────────────────────

  defineTool(server, ctx, {
    name: 'messenger_post_send_message',
    title: '⚠️ Отправить сообщение',
    risk: 'public',
    description:
      '⚠️ ОТПРАВЛЯЕТ РЕАЛЬНОЕ сообщение клиенту в чат. text до 1000 символов. ' +
      'Подтверждайте у пользователя перед вызовом — это видит покупатель.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/messages',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата.'),
      text: z.string().min(1).max(1000).describe('Текст сообщения (до 1000 символов).'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['text'],
      // Avito требует nested структуру { message: { text }, type: 'text' }
      transform: (body) => ({
        message: { text: body.text },
        type: 'text',
      }),
    },
  });

  defineTool(server, ctx, {
    name: 'messenger_post_send_image_message',
    title: '⚠️ Отправить изображение',
    risk: 'public',
    description:
      '⚠️ ОТПРАВЛЯЕТ изображение в чат. Сначала загрузите изображение через messenger_upload_images ' +
      'и используйте полученный image_id.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/messages/image',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата.'),
      image_id: z.string().describe('ID загруженного изображения (от messenger_upload_images).'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['image_id'],
    },
  });

  defineTool(server, ctx, {
    name: 'messenger_delete_message',
    title: '⚠️ Удалить сообщение',
    risk: 'public',
    description: '⚠️ УДАЛЯЕТ сообщение в чате. Подтверждайте у пользователя.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/messages/{message_id}',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата.'),
      message_id: z.string().describe('Идентификатор сообщения.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'chat_id', 'message_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_chat_read',
    title: 'Отметить чат прочитанным',
    risk: 'write',
    description: 'Помечает все непрочитанные сообщения чата как прочитанные.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/read',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_post_blacklist_v2',
    title: '⚠️ Заблокировать пользователей',
    risk: 'write',
    description:
      '⚠️ БЛОКИРУЕТ пользователей. users: массив {user_id, context?:{item_id, reason_id}}. ' +
      'reason_id: 1=спам, 2=мошенничество, 3=оскорбления, 4=другое.',
    method: 'POST',
    path: '/messenger/v2/accounts/{user_id}/blacklist',
    domain: 'messenger',
    input: {
      users: z
        .array(
          z.object({
            user_id: z.number().int().positive().describe('ID пользователя для блокировки'),
            context: z
              .object({
                item_id: z.number().int().optional(),
                reason_id: z.number().int().min(1).max(4).optional(),
              })
              .optional(),
          }),
        )
        .min(1)
        .describe('Список блокируемых пользователей.'),
      user_id: z.number().int().positive().optional().describe('По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['users'],
    },
  });

  defineTool(server, ctx, {
    name: 'messenger_post_webhook_v3',
    title: '⚠️ Включить webhook',
    risk: 'write',
    description:
      '⚠️ ВКЛЮЧАЕТ webhook-уведомления о новых сообщениях. ' +
      'Требует ПУБЛИЧНЫЙ HTTPS URL, доступный из интернета. Локально не работает.',
    method: 'POST',
    path: '/messenger/v3/webhook',
    domain: 'messenger',
    input: {
      url: z.string().url().describe('Публичный HTTPS URL для приёма уведомлений.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['url'],
    },
  });

  defineTool(server, ctx, {
    name: 'messenger_post_webhook_unsubscribe',
    title: 'Отключить webhook',
    risk: 'write',
    description: 'Отключает webhook-подписку по URL.',
    method: 'POST',
    path: '/messenger/v1/webhook/unsubscribe',
    domain: 'messenger',
    input: {
      url: z.string().url().describe('URL подписки, которую нужно отключить.'),
    },
    body: {
      contentType: 'application/json',
      fields: ['url'],
    },
  });

  // ────────────────────────────── CUSTOM (multipart upload) ──────────────────────────────

  // v0.4.0: fail-closed на регистрации, если нет разрешённых директорий.
  // Без AVITO_MCP_ALLOWED_UPLOAD_DIRS tool вообще не появляется в tools/list —
  // защита от arbitrary-file-read через prompt injection.
  if (ctx.config.allowedUploadDirs.length === 0) {
    logger.info(
      { tool: 'messenger_upload_images' },
      'upload tool hidden: AVITO_MCP_ALLOWED_UPLOAD_DIRS is empty',
    );
    return;
  }
  // Policy gate (mode/allow/deny).
  const uploadDecision = evaluatePolicy('messenger_upload_images', 'write', ctx.config);
  if (!uploadDecision.allowed) {
    logger.info(
      { tool: 'messenger_upload_images', risk: 'write', reason: uploadDecision.reason },
      'tool hidden by policy',
    );
    return;
  }
  const maxBytes = ctx.config.maxUploadMb * 1024 * 1024;
  server.registerTool(
    'messenger_upload_images',
    {
      title: 'Загрузить изображения',
      description:
        'Загружает изображения с локального диска в мессенджер Avito (multipart). ' +
        `Возвращает image_id для messenger_post_send_image_message. Принимает jpg/jpeg/png/webp ` +
        `до ${ctx.config.maxUploadMb} MB. Файлы должны лежать в одной из ` +
        `AVITO_MCP_ALLOWED_UPLOAD_DIRS — иначе tool не зарегистрирован, либо вернёт ошибку. ` +
        'Проверки: realpath (symlink escape), allowlist директорий, размер, расширение, magic bytes.',
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            'Список абсолютных путей к локальным файлам изображений (jpg/jpeg/png/webp). ' +
              'Каждый файл проверяется на: попадание в AVITO_MCP_ALLOWED_UPLOAD_DIRS, размер, ' +
              'расширение, magic bytes. Любая ошибка — отказ всей пачки.',
          ),
        user_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('По умолчанию — Profile_id из .env.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { risk: 'write', environment: 'prod', accessesLocalFiles: true },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const userId = (args.user_id as number | undefined) ?? ctx.config.profileId;
        const paths = args.paths as string[];

        // Валидируем ВСЕ файлы перед началом upload — fail-fast.
        const validated = [];
        for (const p of paths) {
          try {
            validated.push(
              await validateUpload(p, {
                allowedDirs: ctx.config.allowedUploadDirs,
                maxBytes,
              }),
            );
          } catch (err) {
            if (err instanceof UploadGuardError) {
              return {
                isError: true,
                content: [{ type: 'text', text: err.message }],
              };
            }
            throw err;
          }
        }

        const form = new FormData();
        for (const v of validated) {
          const ab = v.data.buffer.slice(v.data.byteOffset, v.data.byteOffset + v.data.byteLength);
          form.append('uploadfile[]', new Blob([ab as ArrayBuffer], { type: v.mime }), v.filename);
        }

        const response = await ctx.client.request({
          method: 'POST',
          path: '/messenger/v1/accounts/{user_id}/uploadImages',
          pathParams: { user_id: userId },
          body: form,
          bodyContentType: 'multipart/form-data',
          domain: 'messenger',
        });
        return {
          content: [
            {
              type: 'text',
              text: `status=${response.status}\n${JSON.stringify(response.data, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return errorToMcpContent(err);
      }
    },
  );
};
