import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LLMProvider } from '../../src/modules/chat/domain/ports/LLMProvider.js';
import { insertBundle, provisionUser } from '../helpers/fixtures.js';
import { errorOf } from '../helpers/http.js';
import { createTestApp, type TestApp } from '../helpers/testApp.js';
import { resetDatabase, testPrisma } from '../helpers/testDatabase.js';

const prisma = testPrisma();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

describe('POST /chat/messages', () => {
  it('answers with a mocked completion and stores question, answer, tokens and metadata', async () => {
    const alice = t.as({ sub: 'auth0|alice' });
    const res = await alice.post('/chat/messages', { question: '  What is DDD?  ' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      question: 'What is DDD?',
      status: 'COMPLETED',
      quotaSource: 'FREE',
      subscriptionId: null,
      model: 'gpt-4o-mini (mock)',
    });
    const body = res.body as { id: string; answer: string; requestId: string };
    expect(body.answer).toContain('What is DDD?');
    expect(body.requestId).toBe(res.headers['x-request-id']);

    const row = await prisma.chatMessage.findUniqueOrThrow({ where: { id: body.id } });
    const user = await prisma.user.findUniqueOrThrow({ where: { authSub: 'auth0|alice' } });
    expect(row).toMatchObject({
      userId: user.id,
      question: 'What is DDD?',
      answer: body.answer,
      status: 'COMPLETED',
      requestId: body.requestId,
    });
    expect(row.totalTokens).toBe((row.promptTokens ?? 0) + (row.completionTokens ?? 0));
    expect(row.totalTokens).toBeGreaterThan(0);
    expect(row.completedAt).not.toBeNull();
  });

  it('stores questions sanitized (XSS)', async () => {
    const res = await t
      .as({ sub: 'auth0|alice' })
      .post('/chat/messages', { question: '<script>alert("x")</script>Hello <b>there</b>' });
    expect(res.status).toBe(201);
    const row = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: (res.body as { id: string }).id },
    });
    expect(row.question).toBe('Hello there');
  });

  it.each([
    ['empty question', { question: '   ' }],
    ['markup-only question', { question: '<script>x</script>' }],
    ['too long question', { question: 'a'.repeat(2001) }],
    ['non-string question', { question: 42 }],
    ['missing question', {}],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await t.as({ sub: 'auth0|alice' }).post('/chat/messages', body);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('stores SQL-looking input verbatim as data (parameterised queries)', async () => {
    const payload = `Robert'); DROP TABLE "User"; -- and ' OR '1'='1`;
    const res = await t.as({ sub: 'auth0|bobby' }).post('/chat/messages', { question: payload });
    expect(res.status).toBe(201);
    const row = await prisma.chatMessage.findUniqueOrThrow({
      where: { id: (res.body as { id: string }).id },
    });
    expect(row.question).toBe(payload);
    expect(await prisma.user.count()).toBeGreaterThan(0); // table intact

    const probe = await t
      .as({ sub: 'auth0|bobby' })
      .get(`/chat/messages/${encodeURIComponent("1' OR '1'='1")}`);
    expect(probe.status).toBe(400);
  });

  it('rejects mass-assignment fields (userId, quotaSource, tokens)', async () => {
    const res = await t.as({ sub: 'auth0|alice' }).post('/chat/messages', {
      question: 'hi',
      userId: '00000000-0000-4000-8000-000000000000',
      quotaSource: 'SUBSCRIPTION',
      totalTokens: 0,
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toEqual({
      issues: [
        { path: 'body.userId', message: 'Unknown field' },
        { path: 'body.quotaSource', message: 'Unknown field' },
        { path: 'body.totalTokens', message: 'Unknown field' },
      ],
    });
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it('returns a structured QUOTA_EXCEEDED (402) once free quota is gone and no bundle exists', async () => {
    const alice = t.as({ sub: 'auth0|alice' });
    for (let i = 0; i < 3; i++)
      expect((await alice.post('/chat/messages', { question: `q${i}` })).status).toBe(201);

    const res = await alice.post('/chat/messages', { question: 'one more' });
    expect(res.status).toBe(402);
    const error = errorOf(res);
    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.details).toMatchObject({ freeUsed: 3, freeLimit: 3, activeBundles: 0 });
    expect(String(error.details['resetsAt'])).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
  });

  it('refunds the quota unit and returns 503 when the LLM fails', async () => {
    const failing: LLMProvider = { complete: () => Promise.reject(new Error('down')) };
    const broken = await createTestApp({ overrides: { llm: failing } });
    const userId = await provisionUser(broken, 'auth0|unlucky');

    const res = await broken.as({ sub: 'auth0|unlucky' }).post('/chat/messages', { question: 'q' });

    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe('LLM_UNAVAILABLE');
    const usage = await prisma.monthlyFreeUsage.findFirstOrThrow({ where: { userId } });
    expect(usage.used).toBe(0);
    const messages = await prisma.chatMessage.findMany({ where: { userId } });
    expect(messages.map((m) => m.status)).toEqual(['FAILED']);
  });
});

describe('reading chat history', () => {
  it('lists only the caller’s own messages, newest first, with capped pagination', async () => {
    const alice = t.as({ sub: 'auth0|alice' });
    const bob = t.as({ sub: 'auth0|bob' });
    await alice.post('/chat/messages', { question: 'a1' });
    await alice.post('/chat/messages', { question: 'a2' });
    await bob.post('/chat/messages', { question: 'b1' });

    const res = await alice.get('/chat/messages?limit=1');
    expect(res.status).toBe(200);
    const body = res.body as {
      items: { question: string }[];
      page: { total: number; nextOffset: number | null };
    };
    expect(body.items.map((m) => m.question)).toEqual(['a2']);
    expect(body.page).toMatchObject({ total: 2, nextOffset: 1 });

    expect((await alice.get('/chat/messages?limit=51')).status).toBe(400);
    expect((await alice.get('/chat/messages?sort=desc')).status).toBe(400);
  });

  it('returns 404 (not 403) for another user’s message and 400 for a malformed ID', async () => {
    const created = await t
      .as({ sub: 'auth0|alice' })
      .post('/chat/messages', { question: 'secret' });
    const id = (created.body as { id: string }).id;

    expect((await t.as({ sub: 'auth0|alice' }).get(`/chat/messages/${id}`)).status).toBe(200);
    const stranger = await t.as({ sub: 'auth0|mallory' }).get(`/chat/messages/${id}`);
    expect(stranger.status).toBe(404);
    expect(errorOf(stranger).code).toBe('NOT_FOUND');
    expect((await t.as({ sub: 'auth0|alice' }).get('/chat/messages/not-a-uuid')).status).toBe(400);
  });

  it('reports usage: free remaining, reset date and per-bundle remaining', async () => {
    const userId = await provisionUser(t, 'auth0|alice');
    const bundle = await insertBundle(prisma, userId, { tier: 'BASIC', usedMessages: 4 });
    await t.as({ sub: 'auth0|alice' }).post('/chat/messages', { question: 'q' });

    const res = await t.as({ sub: 'auth0|alice' }).get('/chat/usage');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      free: { limit: 3, used: 1, remaining: 2 },
      bundles: [
        {
          subscriptionId: bundle.id,
          tier: 'BASIC',
          maxMessages: 10,
          usedMessages: 4,
          remaining: 6,
        },
      ],
      totalRemaining: 8,
    });
  });
});

describe('authentication is required on every chat route', () => {
  it.each(['/chat/messages', '/chat/usage'])('GET %s without a token → 401', async (path) => {
    expect((await request(t.app).get(path)).status).toBe(401);
  });
});
