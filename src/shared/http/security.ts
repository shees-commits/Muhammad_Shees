import cors from 'cors';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

/**
 * Security headers for a JSON API: nothing may be rendered, framed or
 * sniffed, and responses are never cached by intermediaries.
 */
export function securityHeaders(): RequestHandler[] {
  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      xContentTypeOptions: true,
      xFrameOptions: { action: 'deny' },
    }),
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  ];
}

export const ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-Request-Id',
  'X-Request-Timestamp',
  'X-Request-Nonce',
  'X-Request-Signature',
];

/**
 * Explicit origin allowlist; no wildcard, no credentials. Requests from an
 * origin outside the list are refused with 403 instead of being processed
 * without CORS headers. Requests without an Origin (curl, server-to-server)
 * are not browser cross-origin requests and pass through to authentication.
 */
export function corsPolicy(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin, callback) => {
      if (origin === undefined || allowed.has(origin)) {
        callback(null, origin);
        return;
      }
      callback(new AppError(ErrorCode.FORBIDDEN, 'Origin not allowed'));
    },
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ALLOWED_HEADERS,
    exposedHeaders: [
      'X-Request-Id',
      'Retry-After',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
    ],
    credentials: false,
    maxAge: 600,
  });
}
