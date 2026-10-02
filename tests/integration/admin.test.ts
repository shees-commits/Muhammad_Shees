import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { provisionUser } from '../helpers/fixtures.js';
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

const admin = () => t.as({ sub: 'auth0|admin', roles: ['admin'] });
const alice = () => t.as({ sub: 'auth0|alice' });

describe('RBAC', () => {
  it('GET /metrics: 401 without a token, 403 for a user, 200 for an admin', async () => {
    expect((await request(t.app).get('/metrics')).status).toBe(401);

    const asUser = await alice().get('/metrics');
    expect(asUser.status).toBe(403);
    expect(errorOf(asUser).code).toBe('FORBIDDEN');

    expect((await admin().get('/metrics')).status).toBe(200);
  });

  it('a user cannot read another user’s message (404) but an admin can, system-wide', async () => {
    const created = await alice().post('/chat/messages', { question: 'private' });
    const id = (created.body as { id: string }).id;
    const aliceId = await provisionUser(t, 'auth0|alice');

    expect((await t.as({ sub: 'auth0|bob' }).get(`/chat/messages/${id}`)).status).toBe(404);
    expect((await admin().get(`/chat/messages/${id}`)).status).toBe(200);

    const history = await admin().get(`/admin/users/${aliceId}/chats`);
    expect(history.status).toBe(200);
    expect((history.body as { items: { id: string }[] }).items.map((m) => m.id)).toEqual([id]);

    expect((await alice().get(`/admin/users/${aliceId}/chats`)).status).toBe(403);
    expect((await admin().get('/admin/users/not-a-uuid/chats')).status).toBe(400);
  });

  it('a forged role claim (bad signature) cannot reach admin routes', async () => {
    const token = await t.idp.issueToken({ roles: ['admin'], signWith: 'untrusted' });
    const res = await request(t.app)
      .get('/metrics')
      .set({
        Authorization: `Bearer ${token}`,
        'X-Request-Timestamp': String(Date.now()),
        'X-Request-Nonce': crypto.randomUUID(),
      });
    expect(res.status).toBe(401);
  });
});

describe('GET /metrics', () => {
  it('reports usage by source, tokens, subscriptions by tier and payment outcomes', async () => {
    const bob = t.as({ sub: 'auth0|bob' });
    for (let i = 0; i < 3; i++) await alice().post('/chat/messages', { question: `q${i}` });
    await bob.post('/subscriptions', { tier: 'PRO', billingCycle: 'MONTHLY', autoRenew: true });
    for (let i = 0; i < 4; i++) await bob.post('/chat/messages', { question: `b${i}` });

    const failing = await createTestApp({ env: { PAYMENT_FAILURE_RATE: '1' } });
    await failing
      .as({ sub: 'auth0|carol' })
      .post('/subscriptions', { tier: 'BASIC', billingCycle: 'MONTHLY', autoRenew: true });

    const res = await admin().get('/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      chat: {
        messagesThisMonth: { total: 7, bySource: { FREE: 6, SUBSCRIPTION: 1 } },
        failedMessagesThisMonth: 0,
      },
      subscriptions: {
        activeTotal: 1,
        activeByTier: { BASIC: 0, PRO: 1, ENTERPRISE: 0 },
        inactiveByReason: { PAYMENT_FAILED: 1, EXPIRED: 0, CANCELLED: 0 },
      },
      payments: {
        thisMonth: { succeeded: 1, failed: 1, successRate: 0.5, revenueCents: 2_999 },
        initial: { succeeded: 1, failed: 1, revenueCents: 2_999 },
      },
      renewals: { succeeded: 0, failed: 0, successRate: null },
    });
    const tokens = (res.body as { chat: { tokensThisMonth: { totalTokens: number } } }).chat
      .tokensThisMonth;
    expect(tokens.totalTokens).toBeGreaterThan(0);
  });
});
