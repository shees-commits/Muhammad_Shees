import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import { actorOf } from '../http/locals.js';
import type { Role } from './Actor.js';

/** Controller-level RBAC gate (the domain policies are the second layer, D-07). */
export function requireRole(role: Role): RequestHandler {
  return (_req, res, next) => {
    if (actorOf(res).role !== role) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Insufficient permissions');
    }
    next();
  };
}
