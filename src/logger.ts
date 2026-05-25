import pino from 'pino';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * pino logger пишет в stderr (fd=2). stdio-transport MCP занимает stdout под JSON-RPC,
 * любая запись в stdout сломает протокол. Все логи — только stderr.
 *
 * v0.6.0: после старта сервера вызывается bindMcpLogger(server), чтобы те же события
 * параллельно уходили клиенту как `notifications/message` (MCP logging). Клиент может
 * фильтровать через `logging/setLevel`. pino-output в stderr остаётся как было — для
 * локальной отладки и для случая когда клиент не поддерживает logging.
 */
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'avito-mcp' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2),
);

/** MCP logging severities (RFC-5424). Pino → MCP отображение. */
const PINO_TO_MCP: Record<string, 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical'> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'critical',
};

interface PinoLogEvent {
  level: number;
  time: string;
  service: string;
  msg: string;
  [key: string]: unknown;
}

/**
 * Подключает зеркалирование pino → MCP. Должно быть вызвано ПОСЛЕ server.connect(),
 * иначе sendLoggingMessage сразу упадёт ("not connected").
 *
 * Используем pino.multistream через rewriting — pino поддерживает hooks
 * (`logMethod`), но проще: ставим тонкий wrapper поверх level-методов logger-а.
 * Сохраняем lazy: если server отсутствует, не ломаемся.
 */
export function bindMcpLogger(server: McpServer): void {
  const pinoLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
  for (const lvl of pinoLevels) {
    const original = logger[lvl].bind(logger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (logger as any)[lvl] = (...args: unknown[]): void => {
      original(...(args as Parameters<typeof original>));
      // Извлекаем данные для MCP отдельно — формат args у pino:
      //   logger.info({obj}, 'msg', ...rest) ИЛИ logger.info('msg', ...rest)
      let data: Record<string, unknown> | undefined;
      let msg: string | undefined;
      if (args.length === 0) return;
      if (typeof args[0] === 'object' && args[0] !== null) {
        data = args[0] as Record<string, unknown>;
        msg = typeof args[1] === 'string' ? args[1] : undefined;
      } else if (typeof args[0] === 'string') {
        msg = args[0];
      }
      const payload: PinoLogEvent = {
        level: pinoLevels.indexOf(lvl),
        time: new Date().toISOString(),
        service: 'avito-mcp',
        msg: msg ?? '',
        ...(data ?? {}),
      };
      server
        .sendLoggingMessage({
          level: PINO_TO_MCP[lvl] ?? 'info',
          logger: 'avito-mcp',
          data: payload,
        })
        .catch(() => {
          // Клиент мог не объявить logging capability — это норм, не ломаемся.
        });
    };
  }
}
