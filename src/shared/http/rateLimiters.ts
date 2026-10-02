import type { RequestHandler } from 'express';
import { rateLimit, type AugmentedRequest, type Options } from 'express-rate-limit';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { actorOf } from './locals.js';

export type RateLimitGroup = 'auth' | 'chat' | 'subscriptions' | 'admin';

export interface GroupLimiters {
  perIp: RequestHandler;
  perUser: RequestHandler;
}

export interface RateLimiters {
  globalPerIp: RequestHandler;
  groups: Record<RateLimitGroup, GroupLimiters>;
}

const rejectWithAppError: Options['handler'] = (req, res, next) => {
  const resetTime = (req as AugmentedRequest)['rateLimit']?.resetTime;
  const retryAfterSeconds = resetTime
    ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
    : 60;
  res.setHeader('Retry-After', String(retryAfterSeconds));
  next(new AppError(ErrorCode.RATE_LIMITED, 'Too many requests', { retryAfterSeconds }));
};

/**
 * In-memory fixed-window limiters (one store per limiter, created per app
 * instance). Per-IP limits run before authentication so floods are dropped
 * before any JWT or database work; per-user limits key on the verified user ID.
 * Production would back these with Redis (see Known Limitations).
 */
export function createRateLimiters(config: AppConfig['rateLimit']): RateLimiters {
  const base: Partial<Options> = {
    windowMs: config.windowMs,
    standardHeaders: 'draft-6',
    legacyHeaders: false,
    handler: rejectWithAppError,
  };

  const perIp = (limit: number, prefix: string): RequestHandler =>
    rateLimit({ ...base, limit, identifier: prefix });

  const perUser = (limit: number, prefix: string): RequestHandler =>
    rateLimit({
      ...base,
      limit,
      identifier: prefix,
      keyGenerator: (_req, res) => `user:${actorOf(res).userId}`,
    });

  const group = (name: RateLimitGroup, limits: { perIp: number; perUser: number }) => ({
    perIp: perIp(limits.perIp, `${name}-ip`),
    perUser: perUser(limits.perUser, `${name}-user`),
  });

  return {
    globalPerIp: perIp(config.globalPerIp, 'global-ip'),
    groups: {
      auth: group('auth', config.auth),
      chat: group('chat', config.chat),
      subscriptions: group('subscriptions', config.subscriptions),
      admin: group('admin', config.admin),
    },
  };
}
