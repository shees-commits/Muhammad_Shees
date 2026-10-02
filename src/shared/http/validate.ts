import type { RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

interface RequestSchemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

type Parsed<S extends RequestSchemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

export type ValidationMiddleware<S extends RequestSchemas> = RequestHandler & {
  /** Typed access to the validated DTOs inside the controller. */
  data: (res: Response) => Parsed<S>;
};

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Schema-based validation for body, query and params. Schemas are strict, so
 * unknown fields (mass-assignment attempts such as `price` or `status`) are
 * rejected with 400 and the offending paths. Controllers only ever read the
 * parsed DTOs, never `req.body` directly.
 */
export function validate<S extends RequestSchemas>(schemas: S): ValidationMiddleware<S> {
  const middleware: RequestHandler = (req, res, next) => {
    const issues: ValidationIssue[] = [];
    const parsed: Record<string, unknown> = {};
    const sources = { body: req.body as unknown, query: req.query, params: req.params };

    for (const key of ['body', 'query', 'params'] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(sources[key]);
      if (result.success) {
        parsed[key] = result.data;
      } else {
        for (const issue of result.error.issues) {
          const keys = issue.code === 'unrecognized_keys' ? issue.keys : [];
          const path = [key, ...issue.path.map(String)].join('.');
          if (keys.length > 0) {
            for (const unknownKey of keys) {
              issues.push({ path: `${path}.${unknownKey}`, message: 'Unknown field' });
            }
          } else {
            issues.push({ path, message: issue.message });
          }
        }
      }
    }

    if (issues.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Request validation failed', { issues });
    }
    res.locals.validated = parsed;
    next();
  };

  return Object.assign(middleware, {
    data: (res: Response) => res.locals.validated as Parsed<S>,
  });
}
