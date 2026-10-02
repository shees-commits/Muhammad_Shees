import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createPrismaClient } from '../../src/shared/db/prisma.js';
import { errorOf } from '../helpers/http.js';
import { createTestApp } from '../helpers/testApp.js';

describe('GET /health', () => {
  it('returns 200 with only status information when the database is reachable', async () => {
    const { app } = await createTestApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'ok' } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns 503 when the database is unreachable', async () => {
    const unreachable = createPrismaClient(
      'postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1',
    );
    const { app } = await createTestApp({ overrides: { prisma: unreachable } });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', checks: { database: 'unreachable' } });
    await unreachable.$disconnect();
  });

  it('renders unknown routes in the standard error envelope', async () => {
    const { app } = await createTestApp();
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
  });
});
