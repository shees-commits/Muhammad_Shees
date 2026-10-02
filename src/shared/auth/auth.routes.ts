import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { actorOf } from '../http/locals.js';
import { validate } from '../http/validate.js';
import { NONCE_HEADER, TIMESTAMP_HEADER } from './replayProtection.middleware.js';
import type { UserDirectory } from './UserDirectory.js';

const NoBody = z.strictObject({}).optional();
const NoQuery = z.strictObject({});

/**
 * The backend's "authentication endpoints" (A-06). Login itself happens at the
 * identity provider; these let a client confirm its token and session headers.
 * They are mounted behind authenticate + replay protection like every route.
 */
export function authRoutes(users: UserDirectory, replayWindowSeconds: number): Router {
  const router = Router();

  const meSchema = validate({ query: NoQuery });
  router.get('/me', meSchema, async (_req, res) => {
    const actor = actorOf(res);
    const profile = await users.findById(actor.userId);
    if (!profile) throw new AppError(ErrorCode.UNAUTHENTICATED, 'User not provisioned');
    res.json({
      id: profile.id,
      sub: profile.authSub,
      email: profile.email,
      role: actor.role,
      roles: res.locals.token?.roles ?? [],
      createdAt: profile.createdAt.toISOString(),
    });
  });

  const verifySchema = validate({ body: NoBody, query: NoQuery });
  router.post('/session/verify', verifySchema, (req, res) => {
    const actor = actorOf(res);
    const token = res.locals.token;
    if (!token) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
    res.json({
      valid: true,
      sub: actor.sub,
      userId: actor.userId,
      role: actor.role,
      issuer: token.issuer,
      audience: token.audience,
      issuedAt: token.issuedAt?.toISOString() ?? null,
      expiresAt: token.expiresAt.toISOString(),
      replayProtection: {
        timestamp: Number(req.get(TIMESTAMP_HEADER)),
        nonce: req.get(NONCE_HEADER),
        windowSeconds: replayWindowSeconds,
        nonceConsumed: true,
      },
    });
  });

  return router;
}
