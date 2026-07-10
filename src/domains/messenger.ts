/**
 * `messenger` domain — corresponds to swaggers/messenger.json
 *
 * 13 endpoints: reading/sending messages, chats, blacklist, webhooks, voice, images.
 *
 * Quirks:
 *   - sendMessage requires a nested body `{ message: { text }, type: "text" }` — we use
 *     body.transform to convert the flat input {text} into the required structure.
 *   - uploadImages — multipart/form-data; the LLM passes an array of local paths,
 *     the handler reads the files and builds the FormData.
 *   - Webhooks require a PUBLIC URL to receive notifications (they don't work locally).
 *
 * ⚠️ Write methods actually affect the live account:
 *   - postSendMessage / postSendImageMessage — a real message to the customer
 *   - postBlacklistV2 — blocks a user
 *   - deleteMessage — deletes a message
 */
import { z } from 'zod';
import { basename } from 'node:path';

import { logger } from '../logger.js';
import { defineTool, type DomainRegister } from '../core/tool-factory.js';
import { MissingCredentialsError } from '../core/errors.js';
import { validateUpload, UploadGuardError } from '../core/upload-guard.js';
import {
  assertConfiguredWebhookReceiverUrl,
  configuredWebhookReceiverUrlSchema,
  redactWebhookUrlPreview,
} from './webhook.js';

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── READ ──────────────────────────────

  defineTool(server, ctx, {
    name: 'messenger_get_chats_v2',
    title: 'List chats',
    risk: 'read',
    description:
      "Returns a LIST of the account's chats (conversations with buyers) with a preview of the last message and an unread counter. " +
      'Read-only — sends nothing and does not mark anything as read. Use it to find the needed chat_id before messenger_get_messages_v3, ' +
      'messenger_post_send_message or messenger_chat_read. To get the details of a single known chat, use messenger_get_chat_by_id_v2. ' +
      'Supports filters (items, types, unread) and offset-based pagination via limit/offset.',
    method: 'GET',
    path: '/messenger/v2/accounts/{user_id}/chats',
    domain: 'messenger',
    input: {
      item_ids: z
        .union([z.array(z.number().int().positive()), z.string().min(1)])
        .optional()
        .describe(
          'Filter by item IDs. Prefer an array (encoded as repeated query parameters); a legacy CSV string remains accepted.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('How many chats to return per page (1–100, default 100).'),
      offset: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe('Pagination offset: skip N chats (default 0).'),
      unread_only: z
        .boolean()
        .optional()
        .describe('true — return only chats with unread messages; false/omitted — all chats.'),
      chat_types: z
        .union([z.array(z.enum(['u2i', 'u2u', 'a2u'])), z.string().min(1)])
        .optional()
        .describe(
          'Filter by chat types: u2i, u2u, or a2u. Prefer an array; a legacy CSV string remains accepted.',
        ),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Avito account ID whose chats are requested. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id'],
    queryParams: ['item_ids', 'limit', 'offset', 'unread_only', 'chat_types'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_chat_by_id_v2',
    title: 'Chat by ID',
    risk: 'read',
    description:
      'Returns the details of a SINGLE chat by a known chat_id: participants, linked item, context, and the last message. ' +
      'Read-only. Use it when the chat_id is already known; to find a chat_id or get a list of conversations, use messenger_get_chats_v2. ' +
      'The conversation messages themselves are returned by messenger_get_messages_v3.',
    method: 'GET',
    path: '/messenger/v2/accounts/{user_id}/chats/{chat_id}',
    domain: 'messenger',
    input: {
      chat_id: z
        .string()
        .describe('Chat identifier (string) obtained from messenger_get_chats_v2.'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Avito account ID that owns the chat. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_messages_v3',
    title: 'Chat messages',
    risk: 'read',
    description:
      'Returns the MESSAGES of a specific chat (V3), sorted newest to oldest: text, images, voice, links, date, and author. ' +
      'Read-only — does not mark the chat as read (use messenger_chat_read for that). Requires chat_id (from messenger_get_chats_v2). ' +
      'Page through a long conversation via limit/offset. For download URLs of voice files in messages, use messenger_get_voice_files.',
    method: 'GET',
    path: '/messenger/v3/accounts/{user_id}/chats/{chat_id}/messages/',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Chat identifier (string) from messenger_get_chats_v2.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('How many messages to return per page (1–100, default 100).'),
      offset: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe('Pagination offset: skip N messages (default 0).'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Avito account ID that participates in the chat. Defaults to Profile_id from .env.',
        ),
    },
    pathParams: ['user_id', 'chat_id'],
    queryParams: ['limit', 'offset'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_voice_files',
    title: 'Voice messages',
    risk: 'read',
    description:
      'Returns temporary download URLs for voice messages by their voice_id. Read-only. ' +
      'voice_id values come from voice messages obtained via messenger_get_messages_v3 (the voice/voice_id field). ' +
      'The links are temporary — download immediately.',
    method: 'GET',
    path: '/messenger/v1/accounts/{user_id}/getVoiceFiles',
    domain: 'messenger',
    input: {
      voice_ids: z
        .union([z.array(z.string().min(1)).min(1), z.string().min(1)])
        .describe(
          'Voice message identifiers from messenger_get_messages_v3. Prefer an array; a legacy CSV string remains accepted.',
        ),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Avito account ID that participates in the chats. Defaults to Profile_id from .env.',
        ),
    },
    pathParams: ['user_id'],
    queryParams: ['voice_ids'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_subscriptions',
    title: 'Webhook subscriptions',
    risk: 'read',
    description:
      "Returns a LIST of the account's active webhook subscriptions: notification URLs and their versions/status. " +
      'Read-only (despite the POST method — no body is required); creates and deletes nothing. ' +
      'Use it to check which URLs are subscribed before messenger_post_webhook_v3 (subscribe) or messenger_post_webhook_unsubscribe (unsubscribe).',
    method: 'POST',
    path: '/messenger/v1/subscriptions',
    domain: 'messenger',
    input: {},
  });

  // ────────────────────────────── WRITE ──────────────────────────────

  defineTool(server, ctx, {
    name: 'messenger_post_send_message',
    title: '⚠️ Send message',
    risk: 'public',
    description:
      'Sends a TEXT message to a chat on behalf of the account. WARNING: the message is immediately and PUBLICLY visible to the other party (the buyer) ' +
      'and is not removed automatically (you can delete it via messenger_delete_message). Confirm the text with the user before calling. ' +
      'Requires chat_id (from messenger_get_chats_v2) and text up to 1000 characters. To send an image, use messenger_post_send_image_message.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/messages',
    domain: 'messenger',
    input: {
      chat_id: z
        .string()
        .describe('Recipient chat identifier (string) from messenger_get_chats_v2.'),
      text: z
        .string()
        .min(1)
        .max(1000)
        .describe('Message text, 1–1000 characters. Will be publicly visible to the other party.'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Avito account ID of the sender. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    injectProfileId: 'user_id',
    body: {
      contentType: 'application/json',
      fields: ['text'],
      // Avito requires the nested structure { message: { text }, type: 'text' }
      transform: (body) => ({
        message: { text: body.text },
        type: 'text',
      }),
    },
  });

  defineTool(server, ctx, {
    name: 'messenger_post_send_image_message',
    title: '⚠️ Send image',
    risk: 'public',
    description:
      'Sends an IMAGE (by an already-uploaded image_id) to a chat on behalf of the account. WARNING: the image is immediately and PUBLICLY visible to the other party. ' +
      'Two-step process: first upload the file via messenger_upload_images and obtain an image_id, then call this tool. ' +
      'For text, use messenger_post_send_message. Confirm sending with the user.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/messages/image',
    domain: 'messenger',
    input: {
      chat_id: z
        .string()
        .describe('Recipient chat identifier (string) from messenger_get_chats_v2.'),
      image_id: z
        .string()
        .describe('ID of a previously uploaded image, returned by messenger_upload_images.'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Avito account ID of the sender. Defaults to Profile_id from .env.'),
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
    title: '⚠️ Delete message',
    risk: 'public',
    destructiveHint: true,
    description:
      'Deletes a SINGLE message from a chat by message_id. WARNING: IRREVERSIBLE — the message cannot be restored; ' +
      'the deletion is visible to the other party (a "deleted" marker remains in place of the message). You can usually delete only your own messages. ' +
      'Requires chat_id and message_id (from messenger_get_messages_v3). Always confirm with the user before calling.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/messages/{message_id}',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Chat identifier (string) from messenger_get_chats_v2.'),
      message_id: z
        .string()
        .describe('Identifier (string) of the message to delete, from messenger_get_messages_v3.'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Avito account ID that owns the message. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id', 'chat_id', 'message_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_chat_read',
    title: 'Mark chat as read',
    risk: 'write',
    description:
      'Marks the unread messages of the specified chat as read, recording a read receipt and clearing the unread counter. ' +
      'Sends NOTHING to the other party and is not visible to them; does not modify or delete any message. ' +
      'Idempotent: calling it again on an already-read chat is safe. Requires chat_id (from messenger_get_chats_v2).',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/read',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Chat identifier (string) from messenger_get_chats_v2.'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Avito account ID that owns the chat. Defaults to Profile_id from .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_post_blacklist_v2',
    title: '⚠️ Block users',
    risk: 'public',
    destructiveHint: true,
    description:
      "Adds one or more users to the account's BLACKLIST. WARNING: a blocked user will no longer be able to message you in the messenger; " +
      'this immediately affects a third party and requires confirmation. Accepts an array of users with a user_id and an optional context (item_id and reason). ' +
      'reason_id: 1=spam, 2=fraud, 3=insults and rudeness, 4=other reason.',
    method: 'POST',
    path: '/messenger/v2/accounts/{user_id}/blacklist',
    domain: 'messenger',
    input: {
      users: z
        .array(
          z.object({
            user_id: z.number().int().positive().describe('ID of the Avito user being blocked.'),
            context: z
              .object({
                item_id: z
                  .number()
                  .int()
                  .optional()
                  .describe('ID of the item in whose context the incident occurred (optional).'),
                reason_id: z
                  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
                  .optional()
                  .describe(
                    'Block reason: 1=spam, 2=fraud, 3=insults and rudeness, 4=other reason (optional).',
                  ),
              })
              .optional()
              .describe('Block context: item and reason (optional).'),
          }),
        )
        .min(1)
        .describe('List of users to block (at least one), each as { user_id, context? }.'),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Avito account ID that maintains the blacklist. Defaults to Profile_id from .env.',
        ),
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
    title: '⚠️ Enable webhook',
    risk: 'public',
    description:
      "SUBSCRIBES THIS server's operator-configured receiver URL to webhook notifications (V3) about new messenger events. " +
      'For security, the URL must exactly match AVITO_MCP_WEBHOOK_PUBLIC_URL + path + secret; arbitrary destinations are rejected. ' +
      'Changes account settings and causes Avito to send future events externally, so confirmation is required by default. ' +
      'You can check current subscriptions via messenger_get_subscriptions and disable them via messenger_post_webhook_unsubscribe.',
    method: 'POST',
    path: '/messenger/v3/webhook',
    domain: 'messenger',
    input: {
      url: configuredWebhookReceiverUrlSchema(ctx.config.webhook).describe(
        'Operator-configured public HTTPS receiver URL. It must exactly match this server webhook configuration.',
      ),
    },
    body: {
      contentType: 'application/json',
      fields: ['url'],
      transform: (body) => {
        const url = typeof body.url === 'string' ? body.url : undefined;
        if (!url) throw new Error('Webhook receiver URL is required.');
        assertConfiguredWebhookReceiverUrl(url, ctx.config.webhook);
        return body;
      },
    },
    redactDryRunPreview: redactWebhookUrlPreview,
  });

  defineTool(server, ctx, {
    name: 'messenger_post_webhook_unsubscribe',
    title: 'Disable webhook',
    risk: 'write',
    destructiveHint: true,
    description:
      'UNSUBSCRIBES the specified URL from messenger webhook notifications — Avito will stop sending events to this address. ' +
      'Changes account settings; to resume notifications you will have to subscribe again via messenger_post_webhook_v3. ' +
      'Specify exactly the URL that was subscribed (see the list in messenger_get_subscriptions).',
    method: 'POST',
    path: '/messenger/v1/webhook/unsubscribe',
    domain: 'messenger',
    input: {
      url: z
        .string()
        .url()
        .describe(
          'URL of the subscription to disable (must match the one previously subscribed; see messenger_get_subscriptions).',
        ),
    },
    body: {
      contentType: 'application/json',
      fields: ['url'],
    },
  });

  // ────────────────────────────── CUSTOM (multipart upload) ──────────────────────────────

  // v0.4.0: fail-closed at registration if there are no allowed directories.
  // Without AVITO_MCP_ALLOWED_UPLOAD_DIRS the tool does not appear in tools/list at all —
  // protection against arbitrary-file-read via prompt injection.
  if (ctx.config.allowedUploadDirs.length === 0) {
    logger.info(
      { tool: 'messenger_upload_images' },
      'upload tool hidden: AVITO_MCP_ALLOWED_UPLOAD_DIRS is empty',
    );
    return;
  }
  const maxBytes = ctx.config.maxUploadMb * 1024 * 1024;
  const maxFiles = 10;

  defineTool(server, ctx, {
    name: 'messenger_upload_images',
    title: 'Upload images',
    risk: 'write',
    accessesLocalFiles: true,
    description:
      'UPLOADS images from the local disk to the Avito messenger (multipart) and returns an image_id. ' +
      'This is step 1 of 2: the returned image_id is then passed to messenger_post_send_image_message to send the image to a chat — ' +
      'the upload itself is NOT visible to the other party and publishes nothing. ' +
      `Accepts up to ${maxFiles} jpg/jpeg/png/webp files with an aggregate limit of ${ctx.config.maxUploadMb} MB. Files must reside in one of ` +
      'AVITO_MCP_ALLOWED_UPLOAD_DIRS. Checks use one file descriptor per image: allowlist, regular file, bounded size, extension, and magic bytes.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/uploadImages',
    domain: 'messenger',
    input: {
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(maxFiles)
        .describe(
          `List of 1–${maxFiles} absolute image paths. Duplicate files are rejected and ` +
            `the whole batch must fit within ${ctx.config.maxUploadMb} MB.`,
        ),
      user_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Avito account ID on whose behalf the images are uploaded. Defaults to Profile_id from .env.',
        ),
    },
    pathParams: ['user_id'],
    injectProfileId: 'user_id',
    buildDryRunPreview: (args) => {
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((p): p is string => typeof p === 'string')
        : [];
      return {
        pathParams: { user_id: args.user_id ?? ctx.config.profileId ?? null },
        query: {},
        body: {
          file_count: paths.length,
          filenames: paths.map((p) => basename(p)),
          aggregate_limit_bytes: maxBytes,
        },
      };
    },
    customExecute: async (args) => {
      const userId = (args.user_id as number | undefined) ?? ctx.config.profileId;
      if (userId === undefined) {
        // v0.7.4: no user_id arg and no Profile_id configured → can't build the path.
        throw new MissingCredentialsError(
          'messenger_upload_images requires Profile_id (or an explicit user_id). ' +
            'Set Profile_id env var or pass user_id.',
        );
      }
      const paths = args.paths as string[];

      // Validate ALL files before starting the upload — fail-fast.
      const validated: Awaited<ReturnType<typeof validateUpload>>[] = [];
      const seen = new Set<string>();
      let totalBytes = 0;
      for (const p of paths) {
        const file = await validateUpload(p, {
          allowedDirs: ctx.config.allowedUploadDirs,
          maxBytes,
        });
        if (seen.has(file.realPath)) {
          throw new UploadGuardError(
            'duplicate file in upload batch',
            file.realPath,
            'duplicate_file',
          );
        }
        seen.add(file.realPath);
        totalBytes += file.size;
        if (totalBytes > maxBytes) {
          throw new UploadGuardError(
            `${totalBytes} aggregate bytes > upload batch limit (${maxBytes} bytes)`,
            file.realPath,
            'batch_too_large',
          );
        }
        validated.push(file);
      }

      const form = new FormData();
      for (const v of validated) {
        const ab = v.data.buffer.slice(v.data.byteOffset, v.data.byteOffset + v.data.byteLength);
        form.append('uploadfile[]', new Blob([ab as ArrayBuffer], { type: v.mime }), v.filename);
      }

      return ctx.client.request({
        method: 'POST',
        path: '/messenger/v1/accounts/{user_id}/uploadImages',
        pathParams: { user_id: userId },
        body: form,
        bodyContentType: 'multipart/form-data',
        domain: 'messenger',
      });
    },
  });
};
