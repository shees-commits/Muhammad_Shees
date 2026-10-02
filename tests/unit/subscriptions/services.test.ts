import { beforeEach, describe, expect, it } from 'vitest';
import { MockPaymentGateway } from '../../../src/modules/subscriptions/infrastructure/MockPaymentGateway.js';
import { SubscriptionPolicy } from '../../../src/modules/subscriptions/domain/policies/SubscriptionPolicy.js';
import { RenewalService } from '../../../src/modules/subscriptions/domain/services/RenewalService.js';
import { SubscriptionService } from '../../../src/modules/subscriptions/domain/services/SubscriptionService.js';
import type { Actor } from '../../../src/shared/auth/Actor.js';
import { AppError } from '../../../src/shared/errors/AppError.js';
import { FakeClock } from '../../helpers/FakeClock.js';
import { InMemorySubscriptionRepository, ScriptedGateway } from './fakes.js';

const alice: Actor = { userId: 'alice', sub: 'auth0|alice', role: 'USER' };
const bob: Actor = { userId: 'bob', sub: 'auth0|bob', role: 'USER' };
const admin: Actor = { userId: 'root', sub: 'auth0|root', role: 'ADMIN' };

let repo: InMemorySubscriptionRepository;
let clock: FakeClock;

beforeEach(() => {
  repo = new InMemorySubscriptionRepository();
  clock = new FakeClock('2026-03-15T12:00:00.000Z');
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return undefined;
}

describe('SubscriptionService', () => {
  it('creates an active bundle and records a successful INITIAL payment', async () => {
    const gateway = new ScriptedGateway(['ok']);
    const svc = new SubscriptionService(repo, gateway, clock);
    const sub = await svc.create(alice, { tier: 'PRO', billingCycle: 'MONTHLY', autoRenew: true });

    expect(sub.snapshot).toMatchObject({ userId: 'alice', status: 'ACTIVE', priceCents: 2_999 });
    expect(gateway.charges).toEqual([
      expect.objectContaining({
        kind: 'INITIAL',
        amountCents: 2_999,
        idempotencyKey: `${sub.id}:initial`,
      }),
    ]);
    expect(repo.payments).toEqual([
      expect.objectContaining({ subscriptionId: sub.id, status: 'SUCCEEDED', kind: 'INITIAL' }),
    ]);
  });

  it('persists a declined first payment as INACTIVE and raises PAYMENT_FAILED', async () => {
    const svc = new SubscriptionService(repo, new ScriptedGateway(['fail']), clock);
    expect(
      await codeOf(svc.create(alice, { tier: 'BASIC', billingCycle: 'MONTHLY', autoRenew: true })),
    ).toBe('PAYMENT_FAILED');

    const [row] = [...repo.rows.values()];
    expect(row).toMatchObject({ status: 'INACTIVE', inactiveReason: 'PAYMENT_FAILED' });
    expect(repo.payments[0]).toMatchObject({ status: 'FAILED', failureReason: 'card_declined' });
  });

  it('hides other users’ subscriptions (404) but lets admins read them', async () => {
    const svc = new SubscriptionService(repo, new ScriptedGateway(), clock);
    const sub = await svc.create(alice, {
      tier: 'BASIC',
      billingCycle: 'MONTHLY',
      autoRenew: true,
    });

    expect(await codeOf(svc.get(bob, sub.id))).toBe('NOT_FOUND');
    expect(await codeOf(svc.cancel(bob, sub.id))).toBe('NOT_FOUND');
    expect(await codeOf(svc.setAutoRenew(bob, sub.id, false))).toBe('NOT_FOUND');
    expect((await svc.get(admin, sub.id)).id).toBe(sub.id);
    expect(await codeOf(svc.listAll(alice, {}, { limit: 10, offset: 0 }))).toBe('FORBIDDEN');
    expect((await svc.listAll(admin, {}, { limit: 10, offset: 0 })).total).toBe(1);
  });

  it('cancels once, keeps the bundle active, then rejects a second cancel', async () => {
    const svc = new SubscriptionService(repo, new ScriptedGateway(), clock);
    const sub = await svc.create(alice, {
      tier: 'BASIC',
      billingCycle: 'MONTHLY',
      autoRenew: true,
    });

    const cancelled = await svc.cancel(alice, sub.id);
    expect(cancelled.snapshot).toMatchObject({
      status: 'ACTIVE',
      autoRenew: false,
      renewalDate: null,
    });
    expect(await codeOf(svc.cancel(alice, sub.id))).toBe('ALREADY_CANCELLED');
  });
});

describe('RenewalService', () => {
  async function seed(svc: SubscriptionService, autoRenew: boolean, actor = alice) {
    return svc.create(actor, { tier: 'BASIC', billingCycle: 'MONTHLY', autoRenew });
  }

  it('renews due subscriptions, resets usage and records RENEWAL payments', async () => {
    const gateway = new ScriptedGateway();
    const svc = new SubscriptionService(repo, gateway, clock);
    const sub = await seed(svc, true);
    repo.get(sub.id).usedMessages = 9;

    clock.set('2026-04-15T12:00:01.000Z');
    const result = await new RenewalService(repo, gateway, clock, 50).runOnce();

    expect(result).toMatchObject({ renewed: 1, paymentFailed: 0, expired: 0, errors: 0 });
    expect(repo.get(sub.id)).toMatchObject({ status: 'ACTIVE', usedMessages: 0 });
    expect(repo.get(sub.id).endDate.toISOString()).toBe('2026-05-15T12:00:00.000Z');
    expect(repo.payments.filter((p) => p.kind === 'RENEWAL')).toHaveLength(1);
  });

  it('marks a subscription INACTIVE when the renewal payment fails', async () => {
    const gateway = new ScriptedGateway(['ok', 'fail']);
    const svc = new SubscriptionService(repo, gateway, clock);
    const sub = await seed(svc, true);

    clock.set('2026-04-16T00:00:00.000Z');
    const result = await new RenewalService(repo, gateway, clock, 50).runOnce();

    expect(result.paymentFailed).toBe(1);
    expect(repo.get(sub.id)).toMatchObject({
      status: 'INACTIVE',
      inactiveReason: 'PAYMENT_FAILED',
    });
    expect(repo.payments.at(-1)).toMatchObject({ kind: 'RENEWAL', status: 'FAILED' });
  });

  it('does not renew cancelled subscriptions; it closes them at endDate', async () => {
    const gateway = new ScriptedGateway();
    const svc = new SubscriptionService(repo, gateway, clock);
    const sub = await seed(svc, true);
    await svc.cancel(alice, sub.id);

    clock.set('2026-04-16T00:00:00.000Z');
    const result = await new RenewalService(repo, gateway, clock, 50).runOnce();

    expect(result).toMatchObject({ renewed: 0, expired: 1 });
    expect(repo.get(sub.id)).toMatchObject({ status: 'INACTIVE', inactiveReason: 'CANCELLED' });
    expect(gateway.charges.filter((c) => c.kind === 'RENEWAL')).toHaveLength(0);
  });

  it('expires non-renewing subscriptions and leaves current ones alone', async () => {
    const gateway = new ScriptedGateway();
    const svc = new SubscriptionService(repo, gateway, clock);
    const ending = await seed(svc, false);
    clock.set('2026-04-01T00:00:00.000Z');
    const current = await seed(svc, false, bob);

    clock.set('2026-04-15T12:00:00.000Z');
    const result = await new RenewalService(repo, gateway, clock, 50).runOnce();

    expect(result.expired).toBe(1);
    expect(repo.get(ending.id)).toMatchObject({ status: 'INACTIVE', inactiveReason: 'EXPIRED' });
    expect(repo.get(current.id).status).toBe('ACTIVE');
  });

  it('isolates a failing subscription and continues with the rest of the batch', async () => {
    const gateway = new ScriptedGateway(['ok', 'ok', 'throw', 'ok']);
    const svc = new SubscriptionService(repo, gateway, clock);
    const first = await seed(svc, true);
    const second = await seed(svc, true, bob);

    clock.set('2026-04-16T00:00:00.000Z');
    const result = await new RenewalService(repo, gateway, clock, 50).runOnce();

    expect(result.errors).toBe(1);
    expect(result.renewed).toBe(1);
    const states = [repo.get(first.id), repo.get(second.id)].map((r) => r.endDate.toISOString());
    expect(states.sort()).toEqual(['2026-04-15T12:00:00.000Z', '2026-05-15T12:00:00.000Z']);
  });

  it('only admins may trigger a billing run', async () => {
    const renewals = new RenewalService(repo, new ScriptedGateway(), clock, 50);
    expect(await codeOf(renewals.runAs(alice))).toBe('FORBIDDEN');
    expect((await renewals.runAs(admin)).renewed).toBe(0);
  });
});

describe('MockPaymentGateway', () => {
  const request = {
    subscriptionId: 's',
    userId: 'u',
    amountCents: 999,
    currency: 'USD',
    kind: 'INITIAL' as const,
    idempotencyKey: 'k',
  };

  it('fails when the injected random draw is below the failure rate', async () => {
    expect((await new MockPaymentGateway(0.2, () => 0.1).charge(request)).status).toBe('FAILED');
    expect((await new MockPaymentGateway(0.2, () => 0.2).charge(request)).status).toBe('SUCCEEDED');
  });

  it('never fails at rate 0 and always fails at rate 1', async () => {
    expect((await new MockPaymentGateway(0, () => 0).charge(request)).status).toBe('SUCCEEDED');
    expect((await new MockPaymentGateway(1, () => 0.999).charge(request)).status).toBe('FAILED');
  });
});

describe('SubscriptionPolicy', () => {
  const resource = { userId: 'alice' };

  it('owner may view and modify', () => {
    expect(SubscriptionPolicy.canView(alice, resource)).toBe(true);
    expect(SubscriptionPolicy.canModify(alice, resource)).toBe(true);
  });

  it('another user may neither view nor modify', () => {
    expect(SubscriptionPolicy.canView(bob, resource)).toBe(false);
    expect(SubscriptionPolicy.canModify(bob, resource)).toBe(false);
  });

  it('admin may view everything and run billing, but not change a user’s billing choices', () => {
    expect(SubscriptionPolicy.canView(admin, resource)).toBe(true);
    expect(SubscriptionPolicy.canViewAll(admin)).toBe(true);
    expect(SubscriptionPolicy.canRunBilling(admin)).toBe(true);
    expect(SubscriptionPolicy.canModify(admin, resource)).toBe(false);
    expect(SubscriptionPolicy.canViewAll(alice)).toBe(false);
  });
});
