import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/** Header/body paths that must never reach the logs. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-request-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
];

export interface LoggerConfig {
  level: string;
  pretty: boolean;
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: { service: 'ggi-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  if (config.pretty) {
    options.transport = { target: 'pino-pretty', options: { singleLine: true } };
  }
  return pino(options);
}
