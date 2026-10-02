import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { actorOf } from '../http/locals.js';
import type { Clock } from '../kernel/Clock.js';
import type { NonceStore } from './NonceStore.js';

export const TIMESTAMP_HEADER = 'x-request-timestamp';
export const NONCE_HEADER = 'x-request-nonce';

const UNIX_MS = /^\d{13}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReplayCheckInput {
  sub: string;
  timestamp: string | undefined;
  nonce: string | undefined;
}

export interface ReplayCheckDeps {
  store: NonceStore;
  clock: Clock;
  windowSeconds: number;
}

/**
 * Decision D-04: a bearer token alone is not enough. Every authenticated
 * request carries a fresh timestamp (±window) and a single-use UUIDv4 nonce
 * bound to the token subject, so a captured request cannot be replayed and a
 * stolen token cannot be reused with an old request.
 */
export async function assertFreshRequest(
  input: ReplayCheckInput,
  deps: ReplayCheckDeps,
): Promise<void> {
  const { timestamp, nonce } = input;
  if (timestamp === undefined || nonce === undefined) {
    throw new AppError(
      ErrorCode.UNAUTHENTICATED,
      'X-Request-Timestamp and X-Request-Nonce headers are required',
    );
  }
  if (!UNIX_MS.test(timestamp) || !UUID_V4.test(nonce)) {
    throw new AppError(
      ErrorCode.UNAUTHENTICATED,
      'X-Request-Timestamp must be unix milliseconds and X-Request-Nonce a UUID v4',
    );
  }

  const sentAt = Number(timestamp);
  const windowMs = deps.windowSeconds * 1000;
  if (Math.abs(deps.clock.now().getTime() - sentAt) > windowMs) {
    throw new AppError(
      ErrorCode.REQUEST_EXPIRED,
      'Request timestamp is outside the allowed window',
      {
        windowSeconds: deps.windowSeconds,
      },
    );
  }

  // After sentAt + window the timestamp check alone rejects the request, so the nonce can be purged.
  const firstUse = await deps.store.consume(
    input.sub,
    nonce.toLowerCase(),
    new Date(sentAt + windowMs),
  );
  if (!firstUse) {
    throw new AppError(ErrorCode.REPLAY_DETECTED, 'Request nonce has already been used');
  }
}

export function replayProtection(deps: ReplayCheckDeps): RequestHandler {
  return async (req, res, next) => {
    await assertFreshRequest(
      {
        sub: actorOf(res).sub,
        timestamp: req.get(TIMESTAMP_HEADER),
        nonce: req.get(NONCE_HEADER),
      },
      deps,
    );
    next();
  };
}
