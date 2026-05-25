import pino from 'pino';

/**
 * pino logger пишет в stderr (fd=2). stdio-transport MCP занимает stdout под JSON-RPC,
 * любая запись в stdout сломает протокол. Все логи — только stderr.
 */
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'avito-mcp' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2),
);
