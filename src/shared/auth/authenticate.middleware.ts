import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import type { JwtVerifier } from './jwtVerifier.js';
import type { UserDirectory } from './UserDirectory.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/;
const TOKEN_QUERY_PARAMS = ['access_token', 'token', 'id_token'];

/**
 * Verifies the bearer token and provisions the user just-in-time.
 * Only the `Authorization: Bearer` header is accepted: tokens in query strings
 * leak into logs, proxies and browser history, so they are rejected outright.
 */
export function authenticate(verifyToken: JwtVerifier, users: UserDirectory): RequestHandler {
  return async (req, res, next) => {
    const query = req.query as Record<string, unknown>;
    if (TOKEN_QUERY_PARAMS.some((param) => param in query)) {
      throw new AppError(
        ErrorCode.UNAUTHENTICATED,
        'Access tokens must be sent in the Authorization header',
      );
    }

    const header = req.headers.authorization;
    if (header === undefined || header.length === 0) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Missing bearer token');
    }
    const token = BEARER.exec(header)?.[1];
    if (token === undefined) {
      throw new AppError(ErrorCode.INVALID_TOKEN, 'Authorization header must be "Bearer <JWT>"');
    }

    const verified = await verifyToken(token);
    const user = await users.provision({
      sub: verified.sub,
      email: verified.email,
      role: verified.role,
    });

    res.locals.token = verified;
    res.locals.actor = { userId: user.id, sub: verified.sub, role: verified.role };
    next();
  };
}
