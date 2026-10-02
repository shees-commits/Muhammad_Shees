import type { Actor } from '../auth/Actor.js';
import type { VerifiedToken } from '../auth/jwtVerifier.js';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

declare module 'express-serve-static-core' {
  interface Locals {
    /** Set by `authenticate` once the token is verified and the user provisioned. */
    actor?: Actor;
    token?: VerifiedToken;
    /** Aborted by the request-timeout middleware; long-running work should honour it. */
    abortSignal?: AbortSignal;
    /** Output of the `validate` middleware. */
    validated?: unknown;
  }
}

/** Returns the authenticated actor, failing closed if a route was mounted without `authenticate`. */
export function actorOf(res: { locals: { actor?: Actor } }): Actor {
  const { actor } = res.locals;
  if (!actor) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
  }
  return actor;
}
