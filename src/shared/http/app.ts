import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../logging/logger.js';
import { errorHandler, notFoundHandler } from './errorHandler.js';
import { healthRoutes, type DatabaseHealthCheck } from './health.routes.js';

/**
 * Everything the HTTP app needs from the outside world. Tests build the app
 * with substitutes (local JWKS, fake clock, mock gateways) through this
 * object rather than through environment switches or bypasses.
 */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  checkDatabase: DatabaseHealthCheck;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId: () => randomUUID(),
      customAttributeKeys: { responseTime: 'responseTimeMs' },
      customLogLevel: (_req, res, err) => {
        if (err !== undefined || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        // Log only what is needed to trace a request; never headers or bodies.
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url.split('?')[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(healthRoutes(deps.checkDatabase));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
