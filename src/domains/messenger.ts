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
import { errorToMcpContent, MissingCredentialsError } from '../core/errors.js';
import { evaluatePolicy } from '../core/policy.js';
import { validateUpload, UploadGuardError } from '../core/upload-guard.js';

export const register: DomainRegister = (server, ctx) => {
  // ────────────────────────────── READ ──────────────────────────────

  defineTool(server, ctx, {
    name: 'messenger_get_chats_v2',
    title: 'Список чатов',
    risk: 'read',
    description:
      'Возвращает СПИСОК чатов аккаунта (диалогов с покупателями) с превью последнего сообщения и счётчиком непрочитанных. ' +
      'Только чтение, ничего не отправляет и не помечает прочитанным. Используйте для поиска нужного chat_id перед messenger_get_messages_v3, ' +
      'messenger_post_send_message или messenger_chat_read. Для деталей одного известного чата используйте messenger_get_chat_by_id_v2. ' +
      'Поддерживает фильтры (объявления, типы, непрочитанные) и постраничную пагинацию через limit/offset.',
    method: 'GET',
    path: '/messenger/v2/accounts/{user_id}/chats',
    domain: 'messenger',
    input: {
      item_ids: z
        .string()
        .optional()
        .describe('Фильтр: CSV-список ID объявлений, чаты только по этим объявлениям (например "12345,6789"). По умолчанию — все чаты.'),
      limit: z.number().int().min(1).max(100).optional().describe('Сколько чатов вернуть на странице (1–100, по умолчанию 100).'),
      offset: z.number().int().min(0).optional().describe('Смещение для пагинации: пропустить N чатов (по умолчанию 0).'),
      unread_only: z.boolean().optional().describe('true — вернуть только чаты с непрочитанными сообщениями; false/не указано — все чаты.'),
      chat_types: z
        .string()
        .optional()
        .describe('Фильтр по типам чатов, CSV: u2i (диалог по объявлению), u2u (диалог между пользователями). По умолчанию — все типы.'),
      user_id: z.number().int().positive().optional().describe('ID аккаунта Avito, чьи чаты запрашиваем. По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id'],
    queryParams: ['item_ids', 'limit', 'offset', 'unread_only', 'chat_types'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_chat_by_id_v2',
    title: 'Чат по ID',
    risk: 'read',
    description:
      'Возвращает детали ОДНОГО чата по известному chat_id: участники, привязанное объявление, контекст и последнее сообщение. ' +
      'Только чтение. Используйте, когда chat_id уже известен; чтобы найти chat_id или получить список диалогов — используйте messenger_get_chats_v2. ' +
      'Сами сообщения переписки возвращает messenger_get_messages_v3.',
    method: 'GET',
    path: '/messenger/v2/accounts/{user_id}/chats/{chat_id}',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата (строка), полученный из messenger_get_chats_v2.'),
      user_id: z.number().int().positive().optional().describe('ID аккаунта Avito — владельца чата. По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_messages_v3',
    title: 'Сообщения чата',
    risk: 'read',
    description:
      'Возвращает СООБЩЕНИЯ конкретного чата (версия V3), отсортированные от новых к старым: текст, изображения, голос, ссылки, дата и автор. ' +
      'Только чтение, не помечает чат прочитанным (для этого — messenger_chat_read). Требует chat_id (из messenger_get_chats_v2). ' +
      'Длинную переписку листайте постранично через limit/offset. Для URL голосовых файлов из сообщений используйте messenger_get_voice_files.',
    method: 'GET',
    path: '/messenger/v3/accounts/{user_id}/chats/{chat_id}/messages/',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата (строка) из messenger_get_chats_v2.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Сколько сообщений вернуть на странице (1–100, по умолчанию 100).'),
      offset: z.number().int().min(0).optional().describe('Смещение для пагинации: пропустить N сообщений (по умолчанию 0).'),
      user_id: z.number().int().positive().optional().describe('ID аккаунта Avito — участника чата. По умолчанию — Profile_id из .env.'),
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
      'Возвращает временные URL для скачивания голосовых сообщений по их voice_id. Только чтение. ' +
      'voice_id берутся из голосовых сообщений, полученных через messenger_get_messages_v3 (поле voice/voice_id). ' +
      'Ссылки временные — скачивайте сразу.',
    method: 'GET',
    path: '/messenger/v1/accounts/{user_id}/getVoiceFiles',
    domain: 'messenger',
    input: {
      voice_ids: z.string().describe('CSV-список идентификаторов голосовых сообщений (voice_id) из messenger_get_messages_v3, например "id1,id2".'),
      user_id: z.number().int().positive().optional().describe('ID аккаунта Avito — участника чатов. По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id'],
    queryParams: ['voice_ids'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_get_subscriptions',
    title: 'Webhook-подписки',
    risk: 'read',
    description:
      'Возвращает СПИСОК активных webhook-подписок аккаунта: URL приёма уведомлений и их версии/статус. ' +
      'Только чтение (несмотря на метод POST — тело не требуется), ничего не создаёт и не удаляет. ' +
      'Используйте, чтобы проверить, какие URL подписаны, перед messenger_post_webhook_v3 (подписать) или messenger_post_webhook_unsubscribe (отписать).',
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
      'Отправляет ТЕКСТОВОЕ сообщение в чат от имени аккаунта. ВНИМАНИЕ: сообщение немедленно и ПУБЛИЧНО видно собеседнику (покупателю) ' +
      'и не удаляется автоматически (удалить можно через messenger_delete_message). Подтверждайте текст у пользователя перед вызовом. ' +
      'Требует chat_id (из messenger_get_chats_v2) и text до 1000 символов. Для отправки картинки используйте messenger_post_send_image_message.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/messages',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата-получателя (строка) из messenger_get_chats_v2.'),
      text: z.string().min(1).max(1000).describe('Текст сообщения, 1–1000 символов. Будет публично виден собеседнику.'),
      user_id: z.number().int().positive().optional().describe('ID аккаунта Avito — отправителя. По умолчанию — Profile_id из .env.'),
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
      'Отправляет ИЗОБРАЖЕНИЕ (по уже загруженному image_id) в чат от имени аккаунта. ВНИМАНИЕ: картинка немедленно и ПУБЛИЧНО видна собеседнику. ' +
      'Двухшаговый процесс: сначала загрузите файл через messenger_upload_images и получите image_id, затем вызовите этот tool. ' +
      'Для текста используйте messenger_post_send_message. Подтверждайте отправку у пользователя.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/messages/image',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата-получателя (строка) из messenger_get_chats_v2.'),
      image_id: z.string().describe('ID ранее загруженного изображения, возвращённый messenger_upload_images.'),
      user_id: z.number().int().positive().optional().describe('ID аккаунта Avito — отправителя. По умолчанию — Profile_id из .env.'),
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
    destructiveHint: true,
    description:
      'Удаляет ОДНО сообщение из чата по message_id. ВНИМАНИЕ: НЕОБРАТИМО — восстановить сообщение нельзя; ' +
      'удаление видно собеседнику (на месте сообщения остаётся пометка об удалении). Удалять можно обычно только свои сообщения. ' +
      'Требует chat_id и message_id (из messenger_get_messages_v3). Обязательно подтверждайте у пользователя перед вызовом.',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/messages/{message_id}',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата (строка) из messenger_get_chats_v2.'),
      message_id: z.string().describe('Идентификатор удаляемого сообщения (строка) из messenger_get_messages_v3.'),
      user_id: z.number().int().positive().optional().describe('ID аккаунта Avito — владельца сообщения. По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'chat_id', 'message_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_chat_read',
    title: 'Отметить чат прочитанным',
    risk: 'write',
    description:
      'Помечает ВСЕ непрочитанные сообщения указанного чата как прочитанные и обнуляет счётчик непрочитанных. ' +
      'Меняет состояние на стороне Avito, но НЕ отправляет ничего собеседнику и не виден ему. Необратимо вернуть статус «непрочитано» нельзя. ' +
      'Идемпотентно: повторный вызов на уже прочитанном чате безопасен. Требует chat_id (из messenger_get_chats_v2).',
    method: 'POST',
    path: '/messenger/v1/accounts/{user_id}/chats/{chat_id}/read',
    domain: 'messenger',
    input: {
      chat_id: z.string().describe('Идентификатор чата (строка) из messenger_get_chats_v2.'),
      user_id: z.number().int().positive().optional().describe('ID аккаунта Avito — владельца чата. По умолчанию — Profile_id из .env.'),
    },
    pathParams: ['user_id', 'chat_id'],
    injectProfileId: 'user_id',
  });

  defineTool(server, ctx, {
    name: 'messenger_post_blacklist_v2',
    title: '⚠️ Заблокировать пользователей',
    risk: 'write',
    destructiveHint: true,
    description:
      'Добавляет одного или нескольких пользователей в ЧЁРНЫЙ СПИСОК аккаунта. ВНИМАНИЕ: заблокированный пользователь больше не сможет писать вам в мессенджере; ' +
      'это меняет боевой аккаунт — подтверждайте у пользователя. Принимает массив users с user_id и опциональным context (item_id и причина). ' +
      'reason_id: 1=спам, 2=мошенничество, 3=оскорбления и хамство, 4=другая причина.',
    method: 'POST',
    path: '/messenger/v2/accounts/{user_id}/blacklist',
    domain: 'messenger',
    input: {
      users: z
        .array(
          z.object({
            user_id: z.number().int().positive().describe('ID пользователя Avito, которого блокируем.'),
            context: z
              .object({
                item_id: z.number().int().optional().describe('ID объявления, в контексте которого произошёл инцидент (опционально).'),
                reason_id: z
                  .number()
                  .int()
                  .min(1)
                  .max(4)
                  .optional()
                  .describe('Причина блокировки: 1=спам, 2=мошенничество, 3=оскорбления и хамство, 4=другая причина (опционально).'),
              })
              .optional()
              .describe('Контекст блокировки: объявление и причина (опционально).'),
          }),
        )
        .min(1)
        .describe('Список блокируемых пользователей (минимум один), каждый — { user_id, context? }.'),
      user_id: z.number().int().positive().optional().describe('ID аккаунта Avito, ведущего чёрный список. По умолчанию — Profile_id из .env.'),
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
      'ПОДПИСЫВАЕТ указанный URL на webhook-уведомления (версия V3) о новых событиях мессенджера — новых сообщениях в чатах. ' +
      'Меняет настройки аккаунта: Avito начнёт слать POST-запросы на этот URL. Требует ПУБЛИЧНЫЙ HTTPS-адрес, доступный из интернета — localhost не работает. ' +
      'Проверить текущие подписки можно через messenger_get_subscriptions, отключить — через messenger_post_webhook_unsubscribe.',
    method: 'POST',
    path: '/messenger/v3/webhook',
    domain: 'messenger',
    input: {
      url: z.string().url().describe('Публичный HTTPS URL, на который Avito будет слать уведомления о событиях мессенджера.'),
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
    destructiveHint: true,
    description:
      'ОТПИСЫВАЕТ указанный URL от webhook-уведомлений мессенджера — Avito перестанет слать события на этот адрес. ' +
      'Меняет настройки аккаунта; чтобы возобновить уведомления, придётся заново подписаться через messenger_post_webhook_v3. ' +
      'Указывайте ровно тот URL, что был подписан (список — в messenger_get_subscriptions).',
    method: 'POST',
    path: '/messenger/v1/webhook/unsubscribe',
    domain: 'messenger',
    input: {
      url: z.string().url().describe('URL подписки, которую нужно отключить (должен совпадать с ранее подписанным; см. messenger_get_subscriptions).'),
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
        'ЗАГРУЖАЕТ изображения с локального диска в мессенджер Avito (multipart) и возвращает image_id. ' +
        'Это шаг 1 из 2: полученный image_id затем передаётся в messenger_post_send_image_message для отправки картинки в чат — ' +
        'сама загрузка собеседнику НЕ видна и ничего не публикует. ' +
        `Принимает jpg/jpeg/png/webp до ${ctx.config.maxUploadMb} MB. Файлы должны лежать в одной из ` +
        `AVITO_MCP_ALLOWED_UPLOAD_DIRS — иначе tool не зарегистрирован либо вернёт ошибку. ` +
        'Проверки: realpath (защита от symlink-escape), allowlist директорий, размер, расширение, magic bytes.',
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            'Список абсолютных путей к локальным файлам изображений (jpg/jpeg/png/webp), минимум один. ' +
              'Каждый файл проверяется на попадание в AVITO_MCP_ALLOWED_UPLOAD_DIRS, размер, ' +
              'расширение и magic bytes. Любая ошибка хотя бы по одному файлу — отказ всей пачки (fail-fast).',
          ),
        user_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('ID аккаунта Avito, от имени которого загружаются изображения. По умолчанию — Profile_id из .env.'),
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
        if (userId === undefined) {
          // v0.7.4: no user_id arg and no Profile_id configured → can't build the path.
          throw new MissingCredentialsError(
            'messenger_upload_images requires Profile_id (or an explicit user_id). ' +
              'Set Profile_id env var or pass user_id.',
          );
        }
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
