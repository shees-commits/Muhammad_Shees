import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { Role, type Actor } from '../../../../src/shared/auth/Actor.js';
import { requireRole } from '../../../../src/shared/auth/requireRole.js';
import { errorHandler } from '../../../../src/shared/http/errorHandler.js';

function appWith(actor: Actor | undefined) {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: 'silent' }) }));
  app.use((_req, res, next) => {
    if (actor) res.locals.actor = actor;
    next();
  });
  app.get('/admin-only', requireRole(Role.ADMIN), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('requireRole', () => {
  it('allows the required role', async () => {
    const res = await request(appWith({ userId: 'a', sub: 's', role: 'ADMIN' })).get('/admin-only');
    expect(res.status).toBe(200);
  });

  it('forbids other roles with 403', async () => {
    const res = await request(appWith({ userId: 'u', sub: 's', role: 'USER' })).get('/admin-only');
    expect(res.status).toBe(403);
  });

  it('fails closed with 401 if mounted without authentication', async () => {
    const res = await request(appWith(undefined)).get('/admin-only');
    expect(res.status).toBe(401);
  });
});
