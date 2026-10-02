import type { ErrorCode } from './errorCodes.js';

export type ErrorDetails = Readonly<Record<string, unknown>>;

/**
 * Base class for every typed, expected error (domain and transport alike).
 * Framework-free so domain modules can extend it. Anything that is not an
 * AppError is treated as an unexpected failure and rendered as INTERNAL_ERROR.
 */
export class AppError extends Error {
  override readonly name: string = 'AppError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: ErrorDetails = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
