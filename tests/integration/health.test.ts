import { pino } from 'pino';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createPrismaClient, pingDatabase } from '../../src/shared/db/prisma.js';
import { createApp } from '../../src/shared/http/app.js';
import { errorOf } from '../helpers/http.js';
import { testConfig } from '../helpers/testConfig.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

const prisma = createPrismaClient(TEST_DATABASE_URL);
const logger = pino({ level: 'silent' });

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /health', () => {
  it('returns 200 with only status information when the database is reachable', async () => {
    const app = createApp({
      config: testConfig(),
      logger,
      checkDatabase: () => pingDatabase(prisma),
    });

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
    const app = createApp({
      config: testConfig(),
      logger,
      checkDatabase: () => pingDatabase(unreachable, 1500),
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', checks: { database: 'unreachable' } });
    await unreachable.$disconnect();
  });

  it('renders unknown routes in the standard error envelope', async () => {
    const app = createApp({
      config: testConfig(),
      logger,
      checkDatabase: () => Promise.resolve(true),
    });
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
  });
});
