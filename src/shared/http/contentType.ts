import type { IncomingHttpHeaders } from 'node:http';
import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function hasBody(headers: IncomingHttpHeaders): boolean {
  const length = headers['content-length'];
  return headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

/** `application/json`, optionally with `charset=utf-8`; nothing else. */
export function isStrictJson(contentType: string): boolean {
  const [mediaType, ...params] = contentType.split(';').map((part) => part.trim().toLowerCase());
  return (
    mediaType === 'application/json' &&
    params.every((param) => param === 'charset=utf-8' || param === '')
  );
}

/**
 * Strict content-type validation: a POST/PUT/PATCH that carries a body must
 * declare exactly `application/json`. Bodyless commands (e.g. cancel) are allowed.
 */
export const requireJsonContentType: RequestHandler = (req, _res, next) => {
  if (!BODY_METHODS.has(req.method) || !hasBody(req.headers)) {
    next();
    return;
  }
  const contentType = req.headers['content-type'];
  if (contentType === undefined || !isStrictJson(contentType)) {
    throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, 'Content-Type must be application/json');
  }
  next();
};
