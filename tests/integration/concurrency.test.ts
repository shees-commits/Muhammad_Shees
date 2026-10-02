import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { periodOf } from '../../src/modules/chat/domain/entities/QuotaPeriod.js';
import { insertBundle, provisionUser } from '../helpers/fixtures.js';
import { errorOf } from '../helpers/http.js';
import { createTestApp, type TestApp } from '../helpers/testApp.js';
import { resetDatabase, testPrisma } from '../helpers/testDatabase.js';

const prisma = testPrisma();
let t: TestApp;

beforeAll(async () => {
  // Real (small) LLM latency so requests genuinely overlap.
  t = await createTestApp({ env: { LLM_MIN_LATENCY_MS: '20', LLM_MAX_LATENCY_MS: '80' } });
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

async function fireInParallel(sub: string, count: number) {
  const client = t.as({ sub });
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      client.post('/chat/messages', { question: `parallel ${i}` }),
    ),
  );
}

describe('quota deduction under concurrent requests', () => {
  it('10 parallel requests from a fresh user: exactly 3 succeed, 7 get QUOTA_EXCEEDED', async () => {
    const userId = await provisionUser(t, 'auth0|burst');

    const responses = await fireInParallel('auth0|burst', 10);

    const ok = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 402);
    expect(ok).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) expect(errorOf(r).code).toBe('QUOTA_EXCEEDED');

    const usage = await prisma.monthlyFreeUsage.findUniqueOrThrow({
      where: { userId_period: { userId, period: periodOf(new Date()) } },
    });
    expect(usage.used).toBe(3);
    expect(await prisma.chatMessage.count({ where: { userId, status: 'COMPLETED' } })).toBe(3);
    expect(await prisma.chatMessage.count({ where: { userId } })).toBe(3);
  });

  it('BASIC bundle + 20 parallel requests: exactly 13 succeed (3 free + 10 bundle)', async () => {
    const userId = await provisionUser(t, 'auth0|basic-burst');
    const bundle = await insertBundle(prisma, userId, { tier: 'BASIC' });

    const responses = await fireInParallel('auth0|basic-burst', 20);

    const ok = responses.filter((r) => r.status === 201);
    expect(ok).toHaveLength(13);
    expect(responses.filter((r) => r.status === 402)).toHaveLength(7);

    const sources = ok.map((r) => (r.body as { quotaSource: string }).quotaSource);
    expect(sources.filter((s) => s === 'FREE')).toHaveLength(3);
    expect(sources.filter((s) => s === 'SUBSCRIPTION')).toHaveLength(10);

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: bundle.id } });
    expect(sub.usedMessages).toBe(10);
    const free = await prisma.monthlyFreeUsage.findFirstOrThrow({ where: { userId } });
    expect(free.used).toBe(3);
    expect(await prisma.chatMessage.count({ where: { userId, status: 'COMPLETED' } })).toBe(13);
    expect(
      await prisma.chatMessage.count({
        where: { userId, quotaSource: 'SUBSCRIPTION', subscriptionId: bundle.id },
      }),
    ).toBe(10);
  });

  it('spreads parallel load across bundles newest-first without overspending any', async () => {
    const userId = await provisionUser(t, 'auth0|two-bundles');
    const day = 24 * 3600_000;
    const older = await insertBundle(prisma, userId, { startDate: new Date(Date.now() - 3 * day) });
    const newer = await insertBundle(prisma, userId, { startDate: new Date(Date.now() - day) });

    const responses = await fireInParallel('auth0|two-bundles', 25);

    expect(responses.filter((r) => r.status === 201)).toHaveLength(23);
    const [o, n] = await Promise.all([
      prisma.subscription.findUniqueOrThrow({ where: { id: older.id } }),
      prisma.subscription.findUniqueOrThrow({ where: { id: newer.id } }),
    ]);
    expect(n.usedMessages).toBe(10);
    expect(o.usedMessages).toBe(10);
  });

  it('isolates users: parallel bursts from different users do not interfere', async () => {
    await Promise.all([provisionUser(t, 'auth0|u1'), provisionUser(t, 'auth0|u2')]);
    const [a, b] = await Promise.all([
      fireInParallel('auth0|u1', 5),
      fireInParallel('auth0|u2', 5),
    ]);
    expect(a.filter((r) => r.status === 201)).toHaveLength(3);
    expect(b.filter((r) => r.status === 201)).toHaveLength(3);
  });
});
