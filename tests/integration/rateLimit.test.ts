import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { errorOf } from '../helpers/http.js';
import { createTestApp } from '../helpers/testApp.js';
import { resetDatabase, testPrisma } from '../helpers/testDatabase.js';

beforeEach(async () => {
  await resetDatabase(testPrisma());
});

describe('rate limiting (production default limits)', () => {
  it('limits the auth group per user (5/min) with 429, Retry-After and RateLimit-* headers', async () => {
    const t = await createTestApp({ realRateLimits: true });
    const alice = t.as({ sub: 'auth0|alice' });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await alice.get('/auth/me')).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);

    const limited = await alice.get('/auth/me');
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['ratelimit-limit']).toBe('5');
    expect(limited.headers['ratelimit-remaining']).toBe('0');
  });

  it('limits the auth group per IP (10/min) across different users', async () => {
    const t = await createTestApp({ realRateLimits: true });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await t.as({ sub: `auth0|user-${i}` }).get('/auth/me')).status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
  });

  it('rejects over-limit requests before authentication runs (per-IP limiter first)', async () => {
    const t = await createTestApp({ realRateLimits: true });
    for (let i = 0; i < 10; i++) await request(t.app).get('/auth/me');
    const res = await request(t.app).get('/auth/me');
    expect(res.status).toBe(429);
  });

  it('applies the global per-IP limit to /health', async () => {
    const t = await createTestApp({ env: { RATE_LIMIT_GLOBAL_PER_IP: '3' } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await request(t.app).get('/health')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('rate limiting: chat group', () => {
  it('limits chat per user (20/min) with 429 and Retry-After', async () => {
    const t = await createTestApp({ realRateLimits: true });
    const alice = t.as({ sub: 'auth0|chatty' });
    for (let i = 0; i < 20; i++) expect((await alice.get('/chat/usage')).status).toBe(200);

    const limited = await alice.get('/chat/usage');
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('the auth group is stricter than the chat group for the same user', async () => {
    const t = await createTestApp({ realRateLimits: true });
    const user = t.as({ sub: 'auth0|compare' });
    const authStatuses: number[] = [];
    const chatStatuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      authStatuses.push((await user.get('/auth/me')).status);
      chatStatuses.push((await user.get('/chat/usage')).status);
    }
    expect(authStatuses.at(-1)).toBe(429);
    expect(chatStatuses).toEqual(Array(6).fill(200));
  });
});
