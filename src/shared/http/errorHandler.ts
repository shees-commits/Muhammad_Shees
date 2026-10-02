import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { AppError, type ErrorDetails } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

/**
 * The single place where error codes become HTTP status codes.
 * `satisfies` forces this table to stay exhaustive as codes are added.
 */
const HTTP_STATUS = {
  UNAUTHENTICATED: 401,
  INVALID_TOKEN: 401,
  REQUEST_EXPIRED: 401,
  REPLAY_DETECTED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  MALFORMED_JSON: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  QUOTA_EXCEEDED: 402,
  PAYMENT_FAILED: 402,
  ALREADY_CANCELLED: 409,
  INVALID_STATE_TRANSITION: 409,
  RATE_LIMITED: 429,
  REQUEST_TIMEOUT: 503,
  INTERNAL_ERROR: 500,
} as const satisfies Record<ErrorCode, number>;

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetails;
    requestId: string;
  };
}

export function requestIdOf(req: Request): string {
  const { id } = req;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : 'unknown';
}

export function toErrorBody(error: AppError, requestId: string): ErrorBody {
  return {
    error: { code: error.code, message: error.message, details: error.details, requestId },
  };
}

/** body-parser signals its failures through a `type` property on the error. */
function fromBodyParserError(err: unknown): AppError | undefined {
  if (typeof err !== 'object' || err === null || !('type' in err)) return undefined;
  switch (err.type) {
    case 'entity.too.large':
      return new AppError(ErrorCode.PAYLOAD_TOO_LARGE, 'Request body exceeds the size limit');
    case 'entity.parse.failed':
      return new AppError(ErrorCode.MALFORMED_JSON, 'Request body is not valid JSON');
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, 'Unsupported body encoding');
    default:
      return undefined;
  }
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(ErrorCode.NOT_FOUND, 'Resource not found'));
};

/**
 * Centralised error renderer. Known errors are rendered as-is; anything else
 * becomes a generic 500 with no message, stack or internals. The full error
 * is logged server-side with the request ID for correlation.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    // A response is already on the wire (e.g. the request timed out).
    // Let Express abort the connection rather than writing twice.
    req.log.warn({ err }, 'Error after response headers were sent');
    next(err);
    return;
  }

  const known = err instanceof AppError ? err : fromBodyParserError(err);
  const appError = known ?? new AppError(ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred');

  if (!known) {
    req.log.error({ err }, 'Unhandled error');
  }

  res.status(httpStatusFor(appError.code)).json(toErrorBody(appError, requestIdOf(req)));
};
