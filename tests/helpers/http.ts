import type { Response } from 'supertest';
import type { ErrorBody } from '../../src/shared/http/errorHandler.js';

/** Typed view of a supertest response carrying the standard error envelope. */
export function errorOf(res: Response): ErrorBody['error'] {
  return (res.body as ErrorBody).error;
}
