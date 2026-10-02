import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockPaymentGateway } from '../../src/modules/subscriptions/infrastructure/MockPaymentGateway.js';
import { FakeClock } from '../helpers/FakeClock.js';
import { errorOf } from '../helpers/http.js';
import { createTestApp, type TestApp } from '../helpers/testApp.js';
import { resetDatabase, testPrisma } from '../helpers/testDatabase.js';

const prisma = testPrisma();
const DAY = 24 * 3600_000;

interface SubscriptionDto {
  id: string;
  status: string;
  maxMessages: number | null;
  usedMessages: number;
  priceCents: number;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  autoRenew: boolean;
  cancelledAt: string | null;
  inactiveReason: string | null;
}

let clock: FakeClock;
let t: TestApp;

beforeEach(async () => {
  await resetDatabase(prisma);
  clock = new FakeClock(new Date());
  t = await createTestApp({ overrides: { clock } });
});

const alice = () => t.as({ sub: 'auth0|alice' });
const admin = () => t.as({ sub: 'auth0|admin', roles: ['admin'] });

async function subscribe(body: object, client = alice()) {
  const res = await client.post('/subscriptions', body);
  return { res, sub: res.body as SubscriptionDto };
}

describe('creating subscriptions', () => {
  it('creates a monthly BASIC bundle with catalogue price, quota and dates', async () => {
    const { res, sub } = await subscribe({
      tier: 'BASIC',
      billingCycle: 'MONTHLY',
      autoRenew: true,
    });

    expect(res.status).toBe(201);
    expect(sub).toMatchObject({
      status: 'ACTIVE',
      maxMessages: 10,
      usedMessages: 0,
      priceCents: 999,
      autoRenew: true,
      startDate: clock.now().toISOString(),
    });
    expect(new Date(sub.endDate).getUTCMonth()).toBe((clock.now().getUTCMonth() + 1) % 12);
    expect(sub.renewalDate).toBe(sub.endDate);

    const attempts = await prisma.paymentAttempt.findMany({ where: { subscriptionId: sub.id } });
    expect(attempts).toEqual([
      expect.objectContaining({ kind: 'INITIAL', status: 'SUCCEEDED', amountCents: 999 }),
    ]);
  });

  it('creates a yearly PRO bundle with 12× quota and yearly price', async () => {
    const { sub } = await subscribe({ tier: 'PRO', billingCycle: 'YEARLY', autoRenew: false });
    expect(sub).toMatchObject({ maxMessages: 1200, priceCents: 29_990, renewalDate: null });
    expect(new Date(sub.endDate).getUTCFullYear()).toBe(clock.now().getUTCFullYear() + 1);
  });

  it('creates an unlimited ENTERPRISE bundle', async () => {
    const { sub } = await subscribe({
      tier: 'ENTERPRISE',
      billingCycle: 'MONTHLY',
      autoRenew: true,
    });
    expect(sub).toMatchObject({ maxMessages: null, priceCents: 9_999 });
  });

  it.each([
    ['price', { price: 0 }],
    ['priceCents', { priceCents: 0 }],
    ['status', { status: 'ACTIVE' }],
    ['maxMessages', { maxMessages: 1_000_000 }],
    ['userId', { userId: '00000000-0000-4000-8000-000000000000' }],
  ])('rejects mass assignment of %s with 400', async (field, extra) => {
    const { res } = await subscribe({
      tier: 'BASIC',
      billingCycle: 'MONTHLY',
      autoRenew: true,
      ...extra,
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toEqual({
      issues: [{ path: `body.${field}`, message: 'Unknown field' }],
    });
    expect(await prisma.subscription.count()).toBe(0);
  });

  it('rejects unknown tiers and cycles', async () => {
    expect(
      (await subscribe({ tier: 'FREE', billingCycle: 'MONTHLY', autoRenew: true })).res.status,
    ).toBe(400);
    expect(
      (await subscribe({ tier: 'PRO', billingCycle: 'WEEKLY', autoRenew: true })).res.status,
    ).toBe(400);
  });

  it('records a declined first payment as an INACTIVE subscription and returns 402', async () => {
    const failing = await createTestApp({
      overrides: { clock },
      env: { PAYMENT_FAILURE_RATE: '1' },
    });
    const res = await failing
      .as({ sub: 'auth0|broke' })
      .post('/subscriptions', { tier: 'PRO', billingCycle: 'MONTHLY', autoRenew: true });

    expect(res.status).toBe(402);
    expect(errorOf(res).code).toBe('PAYMENT_FAILED');
    const id = String(errorOf(res).details['subscriptionId']);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'INACTIVE', inactiveReason: 'PAYMENT_FAILED' });
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { subscriptionId: id } });
    expect(attempt).toMatchObject({ status: 'FAILED', kind: 'INITIAL' });
  });
});

describe('ownership', () => {
  it('lists only own subscriptions and returns 404 for someone else’s', async () => {
    const { sub } = await subscribe({ tier: 'BASIC', billingCycle: 'MONTHLY', autoRenew: true });
    const bob = t.as({ sub: 'auth0|bob' });

    expect(((await bob.get('/subscriptions')).body as { items: unknown[] }).items).toHaveLength(0);
    expect((await bob.get(`/subscriptions/${sub.id}`)).status).toBe(404);
    expect(
      (await bob.patch(`/subscriptions/${sub.id}/auto-renew`, { autoRenew: false })).status,
    ).toBe(404);
    expect((await bob.post(`/subscriptions/${sub.id}/cancel`)).status).toBe(404);
    expect((await alice().get(`/subscriptions/${sub.id}`)).status).toBe(200);
  });
});

describe('auto-renew and cancellation', () => {
  it('toggles auto-renew and validates the body strictly', async () => {
    const { sub } = await subscribe({ tier: 'BASIC', billingCycle: 'MONTHLY', autoRenew: true });

    const off = await alice().patch(`/subscriptions/${sub.id}/auto-renew`, { autoRenew: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ autoRenew: false, renewalDate: null });

    expect(
      (await alice().patch(`/subscriptions/${sub.id}/auto-renew`, { autoRenew: 'yes' })).status,
    ).toBe(400);
    expect(
      (
        await alice().patch(`/subscriptions/${sub.id}/auto-renew`, {
          autoRenew: true,
          status: 'ACTIVE',
        })
      ).status,
    ).toBe(400);
  });

  it('cancel keeps the bundle usable until endDate, blocks renewal, then closes it', async () => {
    const { sub } = await subscribe({ tier: 'BASIC', billingCycle: 'MONTHLY', autoRenew: true });
    for (let i = 0; i < 3; i++) await alice().post('/chat/messages', { question: `free ${i}` });
    const paid = await alice().post('/chat/messages', { question: 'paid' });
    expect(paid.body).toMatchObject({ quotaSource: 'SUBSCRIPTION', subscriptionId: sub.id });

    const cancelled = await alice().post(`/subscriptions/${sub.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'ACTIVE',
      autoRenew: false,
      renewalDate: null,
      usedMessages: 1,
    });
    expect((cancelled.body as SubscriptionDto).cancelledAt).not.toBeNull();

    // Second cancel is a domain error.
    const again = await alice().post(`/subscriptions/${sub.id}/cancel`);
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('ALREADY_CANCELLED');

    // Auto-renew can no longer be re-enabled.
    const reenable = await alice().patch(`/subscriptions/${sub.id}/auto-renew`, {
      autoRenew: true,
    });
    expect(reenable.status).toBe(409);
    expect(errorOf(reenable).code).toBe('INVALID_STATE_TRANSITION');

    // Still usable before endDate.
    clock.advance(10 * DAY);
    expect((await alice().post('/chat/messages', { question: 'still works' })).body).toMatchObject({
      quotaSource: 'SUBSCRIPTION',
    });

    // After endDate the renewal job must not renew it; it is closed as CANCELLED.
    clock.set(new Date(new Date(sub.endDate).getTime() + DAY));
    const run = await admin().post('/admin/billing/run-renewals');
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ renewed: 0, expired: 1 });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row).toMatchObject({ status: 'INACTIVE', inactiveReason: 'CANCELLED', usedMessages: 2 });
    expect(
      await prisma.paymentAttempt.count({ where: { subscriptionId: sub.id, kind: 'RENEWAL' } }),
    ).toBe(0);
    // Usage history is preserved.
    expect(await prisma.chatMessage.count({ where: { subscriptionId: sub.id } })).toBe(2);
  });
});

describe('renewal job', () => {
  it('renews an auto-renew bundle: new period at old endDate, usage reset, RENEWAL payment', async () => {
    const { sub } = await subscribe({ tier: 'BASIC', billingCycle: 'MONTHLY', autoRenew: true });
    await prisma.subscription.update({ where: { id: sub.id }, data: { usedMessages: 7 } });

    clock.set(new Date(new Date(sub.endDate).getTime() + 1000));
    const run = await admin().post('/admin/billing/run-renewals');

    expect(run.body).toMatchObject({ renewed: 1, paymentFailed: 0 });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.startDate.toISOString()).toBe(sub.endDate);
    expect(row.usedMessages).toBe(0);
    expect(row.status).toBe('ACTIVE');
    expect(row.renewalDate?.toISOString()).toBe(row.endDate.toISOString());
    const renewal = await prisma.paymentAttempt.findFirstOrThrow({
      where: { subscriptionId: sub.id, kind: 'RENEWAL' },
    });
    expect(renewal).toMatchObject({ status: 'SUCCEEDED', amountCents: 999 });
  });

  it('marks the subscription INACTIVE when the renewal payment fails', async () => {
    const draws = [0.9, 0.1]; // initial charge succeeds, renewal charge fails
    const payments = new MockPaymentGateway(0.5, () => draws.shift() ?? 0.9);
    const app = await createTestApp({ overrides: { clock, payments } });
    const res = await app
      .as({ sub: 'auth0|alice' })
      .post('/subscriptions', { tier: 'PRO', billingCycle: 'MONTHLY', autoRenew: true });
    const sub = res.body as SubscriptionDto;

    clock.set(new Date(new Date(sub.endDate).getTime() + 1000));
    const run = await app
      .as({ sub: 'auth0|admin', roles: ['admin'] })
      .post('/admin/billing/run-renewals');

    expect(run.body).toMatchObject({ renewed: 0, paymentFailed: 1 });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row).toMatchObject({ status: 'INACTIVE', inactiveReason: 'PAYMENT_FAILED' });
    // An inactive bundle no longer serves quota.
    const client = app.as({ sub: 'auth0|alice' });
    for (let i = 0; i < 3; i++) await client.post('/chat/messages', { question: `q${i}` });
    expect((await client.post('/chat/messages', { question: 'q' })).status).toBe(402);
  });

  it('never double-charges when several runners process renewals concurrently (SKIP LOCKED)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { sub } = await subscribe(
        { tier: 'BASIC', billingCycle: 'MONTHLY', autoRenew: true },
        t.as({ sub: `auth0|user-${i}` }),
      );
      ids.push(sub.id);
    }
    const before = await prisma.subscription.findMany({ where: { id: { in: ids } } });

    clock.advance(32 * DAY);
    const renewals = t.container.appDeps.renewals;
    const results = await Promise.all([renewals.runOnce(), renewals.runOnce(), renewals.runOnce()]);

    expect(results.reduce((n, r) => n + r.renewed, 0)).toBe(10);
    expect(results.reduce((n, r) => n + r.errors, 0)).toBe(0);
    expect(await prisma.paymentAttempt.count({ where: { kind: 'RENEWAL' } })).toBe(10);
    const after = await prisma.subscription.findMany({ where: { id: { in: ids } } });
    for (const row of after) {
      const original = before.find((b) => b.id === row.id);
      expect(row.startDate.toISOString()).toBe(original?.endDate.toISOString()); // renewed exactly once
    }
  });

  it('is admin-only (403 for users) at the controller layer', async () => {
    const res = await alice().post('/admin/billing/run-renewals');
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
  });
});

describe('admin subscription listing', () => {
  it('lists all subscriptions with filters for admins only', async () => {
    await subscribe({ tier: 'BASIC', billingCycle: 'MONTHLY', autoRenew: true });
    await subscribe(
      { tier: 'PRO', billingCycle: 'MONTHLY', autoRenew: true },
      t.as({ sub: 'auth0|bob' }),
    );

    const all = await admin().get('/admin/subscriptions');
    expect(all.status).toBe(200);
    expect((all.body as { page: { total: number } }).page.total).toBe(2);

    const pro = await admin().get('/admin/subscriptions?tier=PRO');
    expect((pro.body as { items: { tier: string }[] }).items.map((s) => s.tier)).toEqual(['PRO']);

    expect((await admin().get('/admin/subscriptions?tier=GOLD')).status).toBe(400);
    expect((await alice().get('/admin/subscriptions')).status).toBe(403);
    expect((await request(t.app).get('/admin/subscriptions')).status).toBe(401);
  });
});
