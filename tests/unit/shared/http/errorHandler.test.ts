import express from 'express';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../../src/shared/errors/AppError.js';
import { ErrorCode } from '../../../../src/shared/errors/errorCodes.js';
import {
  errorHandler,
  httpStatusFor,
  notFoundHandler,
} from '../../../../src/shared/http/errorHandler.js';
import { errorOf } from '../../../helpers/http.js';

function appThrowing(error: unknown): express.Express {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: 'silent' }), genReqId: () => 'req-123' }));
  app.get('/boom', () => {
    throw error;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('renders typed errors in the standard envelope with the mapped status', async () => {
    const res = await request(
      appThrowing(
        new AppError(ErrorCode.QUOTA_EXCEEDED, 'No quota left', { freeUsed: 3, freeLimit: 3 }),
      ),
    ).get('/boom');

    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'No quota left',
        details: { freeUsed: 3, freeLimit: 3 },
        requestId: 'req-123',
      },
    });
  });

  it('hides internals of unexpected errors behind a generic 500', async () => {
    const res = await request(
      appThrowing(new Error('connection to db at 10.0.0.5 failed: password=hunter2')),
    ).get('/boom');

    expect(res.status).toBe(500);
    expect(errorOf(res).code).toBe('INTERNAL_ERROR');
    expect(errorOf(res).message).toBe('An unexpected error occurred');
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|10\.0\.0\.5|stack/);
  });

  it('renders unknown routes as NOT_FOUND', async () => {
    const res = await request(appThrowing(new Error('unused'))).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
    expect(errorOf(res).requestId).toBe('req-123');
  });

  it('maps every error code to an HTTP status', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(httpStatusFor(code)).toBeGreaterThanOrEqual(400);
    }
    expect(httpStatusFor(ErrorCode.REQUEST_TIMEOUT)).toBe(503);
    expect(httpStatusFor(ErrorCode.REPLAY_DETECTED)).toBe(401);
  });
});
