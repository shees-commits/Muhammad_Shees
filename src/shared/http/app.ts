import express, { type Express, type RequestHandler, type Response } from 'express';
import { pinoHttp } from 'pino-http';
import { chatRoutes } from '../../modules/chat/controllers/chat.routes.js';
import type { ChatService } from '../../modules/chat/domain/services/ChatService.js';
import { adminRoutes } from '../../modules/admin/controllers/admin.routes.js';
import { metricsRoutes } from '../../modules/admin/controllers/metrics.routes.js';
import { subscriptionRoutes } from '../../modules/subscriptions/controllers/subscription.routes.js';
import type { RenewalService } from '../../modules/subscriptions/domain/services/RenewalService.js';
import type { SubscriptionService } from '../../modules/subscriptions/domain/services/SubscriptionService.js';
import { Role } from '../auth/Actor.js';
import { requireRole } from '../auth/requireRole.js';
import { authRoutes } from '../auth/auth.routes.js';
import { authenticate } from '../auth/authenticate.middleware.js';
import type { JwtVerifier } from '../auth/jwtVerifier.js';
import type { NonceStore } from '../auth/NonceStore.js';
import { replayProtection } from '../auth/replayProtection.middleware.js';
import type { UserDirectory } from '../auth/UserDirectory.js';
import type { AppConfig } from '../config/env.js';
import type { Clock } from '../kernel/Clock.js';
import type { Logger } from '../logging/logger.js';
import { requireJsonContentType } from './contentType.js';
import { errorHandler, notFoundHandler } from './errorHandler.js';
import { healthRoutes, type DatabaseHealthCheck } from './health.routes.js';
import { createRateLimiters, type RateLimitGroup } from './rateLimiters.js';
import { requestId } from './requestId.js';
import { corsPolicy, securityHeaders } from './security.js';
import { requestTimeout } from './timeout.js';

export const JSON_BODY_LIMIT = '10kb';

/**
 * Everything the HTTP app needs from the outside world. Tests build the app
 * with substitutes (local JWKS, fake clock, mock gateways) through this
 * object rather than through environment switches or bypasses.
 */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  checkDatabase: DatabaseHealthCheck;
  verifyToken: JwtVerifier;
  users: UserDirectory;
  nonces: NonceStore;
  chat: ChatService;
  subscriptions: SubscriptionService;
  renewals: RenewalService;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);
  app.set('query parser', 'simple');

  // 1. Request ID (accepted only if a valid UUID; echoed back).
  app.use(requestId);

  // 2. Structured request logging (userId is attached once authentication succeeds).
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customAttributeKeys: { responseTime: 'responseTimeMs' },
      customProps: (_req, res) => ({ userId: (res as Response).locals.actor?.userId }),
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

  // 3–4. Security headers and CORS allowlist.
  app.use(securityHeaders());
  app.use(corsPolicy(config.http.corsOrigins));

  // 5. Per-IP global rate limit (also covers /health).
  const limiters = createRateLimiters(config.rateLimit);
  app.use(limiters.globalPerIp);

  // 6. Global request deadline.
  app.use(requestTimeout(config.http.requestTimeoutMs));

  // 7–8. Strict content type, then a bounded strict JSON parser.
  app.use(requireJsonContentType);
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true, type: 'application/json' }));

  // The single unauthenticated endpoint (D-09).
  app.use(healthRoutes(deps.checkDatabase));

  // 9. Protected route groups: IP limit → authenticate → replay protection → per-user limit.
  const authn = authenticate(deps.verifyToken, deps.users);
  const replay = replayProtection({
    store: deps.nonces,
    clock: deps.clock,
    windowSeconds: config.auth.replayWindowSeconds,
  });
  const protect = (group: RateLimitGroup): RequestHandler[] => [
    limiters.groups[group].perIp,
    authn,
    replay,
    limiters.groups[group].perUser,
  ];

  app.use('/auth', protect('auth'), authRoutes(deps.users, config.auth.replayWindowSeconds));
  app.use('/chat', protect('chat'), chatRoutes(deps.chat));
  app.use('/subscriptions', protect('subscriptions'), subscriptionRoutes(deps.subscriptions));
  app.use(
    '/admin',
    protect('admin'),
    requireRole(Role.ADMIN),
    adminRoutes({ chat: deps.chat, subscriptions: deps.subscriptions, renewals: deps.renewals }),
  );
  app.use(
    '/metrics',
    protect('admin'),
    requireRole(Role.ADMIN),
    metricsRoutes({ chat: deps.chat, subscriptions: deps.subscriptions, clock: deps.clock }),
  );

  // 10. Fallthrough and centralized errors.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
