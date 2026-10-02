import { describe, expect, it } from 'vitest';
import {
  addCycle,
  addMonthsUtc,
} from '../../../src/modules/subscriptions/domain/entities/BillingCycle.js';
import { Subscription } from '../../../src/modules/subscriptions/domain/entities/Subscription.js';
import {
  maxMessagesFor,
  priceCentsFor,
} from '../../../src/modules/subscriptions/domain/entities/Tier.js';
import { AppError } from '../../../src/shared/errors/AppError.js';

const now = new Date('2026-03-15T12:00:00.000Z');
const ok = { status: 'SUCCEEDED', reference: 'r' } as const;
const declined = { status: 'FAILED', reason: 'card_declined' } as const;

function create(overrides: Partial<Parameters<typeof Subscription.create>[0]> = {}) {
  return Subscription.create({
    userId: 'u1',
    tier: 'BASIC',
    billingCycle: 'MONTHLY',
    autoRenew: true,
    now,
    ...overrides,
  });
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return undefined;
}

describe('tier catalogue', () => {
  it.each([
    ['BASIC', 'MONTHLY', 10, 999],
    ['BASIC', 'YEARLY', 120, 9_990],
    ['PRO', 'MONTHLY', 100, 2_999],
    ['PRO', 'YEARLY', 1_200, 29_990],
    ['ENTERPRISE', 'MONTHLY', null, 9_999],
    ['ENTERPRISE', 'YEARLY', null, 99_990],
  ] as const)('%s %s → %s messages, %s cents', (tier, cycle, messages, price) => {
    expect(maxMessagesFor(tier, cycle)).toBe(messages);
    expect(priceCentsFor(tier, cycle)).toBe(price);
  });
});

describe('billing cycle date math (UTC)', () => {
  it('adds a month or a year', () => {
    expect(addCycle(now, 'MONTHLY').toISOString()).toBe('2026-04-15T12:00:00.000Z');
    expect(addCycle(now, 'YEARLY').toISOString()).toBe('2027-03-15T12:00:00.000Z');
  });

  it('clamps to the end of shorter months and leap years', () => {
    expect(addMonthsUtc(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(addMonthsUtc(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    expect(addMonthsUtc(new Date('2028-02-29T00:00:00Z'), 12).toISOString()).toBe(
      '2029-02-28T00:00:00.000Z',
    );
  });
});

describe('Subscription.create', () => {
  it.each([
    ['BASIC', 'MONTHLY', 10, 999, '2026-04-15T12:00:00.000Z'],
    ['PRO', 'MONTHLY', 100, 2_999, '2026-04-15T12:00:00.000Z'],
    ['ENTERPRISE', 'MONTHLY', null, 9_999, '2026-04-15T12:00:00.000Z'],
    ['BASIC', 'YEARLY', 120, 9_990, '2027-03-15T12:00:00.000Z'],
    ['PRO', 'YEARLY', 1_200, 29_990, '2027-03-15T12:00:00.000Z'],
    ['ENTERPRISE', 'YEARLY', null, 99_990, '2027-03-15T12:00:00.000Z'],
  ] as const)('%s/%s derives quota, price and period', (tier, billingCycle, max, price, end) => {
    const s = create({ tier, billingCycle }).snapshot;
    expect(s).toMatchObject({
      tier,
      billingCycle,
      maxMessages: max,
      usedMessages: 0,
      priceCents: price,
      currency: 'USD',
      status: 'ACTIVE',
      inactiveReason: null,
      autoRenew: true,
    });
    expect(s.startDate).toEqual(now);
    expect(s.endDate.toISOString()).toBe(end);
    expect(s.renewalDate).toEqual(s.endDate);
  });

  it('has no renewal date when auto-renew is off', () => {
    expect(create({ autoRenew: false }).snapshot.renewalDate).toBeNull();
  });

  it('becomes INACTIVE/PAYMENT_FAILED when the initial payment fails', () => {
    const sub = create();
    sub.failInitialPayment(now);
    expect(sub.snapshot).toMatchObject({
      status: 'INACTIVE',
      inactiveReason: 'PAYMENT_FAILED',
      renewalDate: null,
      autoRenew: false,
    });
  });
});

describe('auto-renew', () => {
  it('toggles the renewal date with the flag', () => {
    const sub = create({ autoRenew: false });
    sub.setAutoRenew(true, now);
    expect(sub.snapshot.renewalDate).toEqual(sub.snapshot.endDate);
    sub.setAutoRenew(false, now);
    expect(sub.snapshot.renewalDate).toBeNull();
  });

  it('cannot be changed on inactive or cancelled subscriptions', () => {
    const inactive = create();
    inactive.failInitialPayment(now);
    expect(
      codeOf(() => {
        inactive.setAutoRenew(true, now);
      }),
    ).toBe('INVALID_STATE_TRANSITION');

    const cancelled = create();
    cancelled.cancel(now);
    expect(
      codeOf(() => {
        cancelled.setAutoRenew(true, now);
      }),
    ).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('cancel', () => {
  it('stays ACTIVE until endDate, stops renewal and keeps usage', () => {
    const sub = Subscription.restore({ ...create().snapshot, usedMessages: 7 });
    sub.cancel(now);
    expect(sub.snapshot).toMatchObject({
      status: 'ACTIVE',
      autoRenew: false,
      renewalDate: null,
      cancelledAt: now,
      usedMessages: 7,
    });
    expect(sub.isDueForRenewal(new Date('2026-05-01T00:00:00Z'))).toBe(false);
  });

  it('refuses to cancel twice (ALREADY_CANCELLED)', () => {
    const sub = create();
    sub.cancel(now);
    expect(
      codeOf(() => {
        sub.cancel(now);
      }),
    ).toBe('ALREADY_CANCELLED');
  });

  it('refuses to cancel an inactive subscription', () => {
    const sub = create();
    sub.failInitialPayment(now);
    expect(
      codeOf(() => {
        sub.cancel(now);
      }),
    ).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('renew', () => {
  const afterEnd = new Date('2026-04-15T12:00:01.000Z');

  it('is due only once renewalDate is reached', () => {
    const sub = create();
    expect(sub.isDueForRenewal(now)).toBe(false);
    expect(sub.isDueForRenewal(afterEnd)).toBe(true);
    expect(
      codeOf(() => {
        sub.renew(ok, now);
      }),
    ).toBe('INVALID_STATE_TRANSITION');
  });

  it('on success starts the next period at the old endDate and resets usage', () => {
    const sub = Subscription.restore({ ...create().snapshot, usedMessages: 10 });
    sub.renew(ok, afterEnd);
    expect(sub.snapshot).toMatchObject({ status: 'ACTIVE', usedMessages: 0, autoRenew: true });
    expect(sub.snapshot.startDate.toISOString()).toBe('2026-04-15T12:00:00.000Z');
    expect(sub.snapshot.endDate.toISOString()).toBe('2026-05-15T12:00:00.000Z');
    expect(sub.snapshot.renewalDate).toEqual(sub.snapshot.endDate);
  });

  it('on payment failure becomes INACTIVE/PAYMENT_FAILED and keeps usage history', () => {
    const sub = Subscription.restore({ ...create().snapshot, usedMessages: 4 });
    sub.renew(declined, afterEnd);
    expect(sub.snapshot).toMatchObject({
      status: 'INACTIVE',
      inactiveReason: 'PAYMENT_FAILED',
      renewalDate: null,
      usedMessages: 4,
    });
  });

  it('never renews a cancelled subscription', () => {
    const sub = create();
    sub.cancel(now);
    expect(sub.isDueForRenewal(afterEnd)).toBe(false);
    expect(
      codeOf(() => {
        sub.renew(ok, afterEnd);
      }),
    ).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('expire', () => {
  const end = new Date('2026-04-15T12:00:00.000Z');

  it('expires a non-renewing subscription at endDate with reason EXPIRED', () => {
    const sub = create({ autoRenew: false });
    expect(sub.shouldExpire(new Date(end.getTime() - 1))).toBe(false);
    expect(sub.shouldExpire(end)).toBe(true);
    sub.expire(end);
    expect(sub.snapshot).toMatchObject({ status: 'INACTIVE', inactiveReason: 'EXPIRED' });
  });

  it('closes a cancelled subscription at endDate with reason CANCELLED', () => {
    const sub = create();
    sub.cancel(now);
    sub.expire(end);
    expect(sub.snapshot).toMatchObject({ status: 'INACTIVE', inactiveReason: 'CANCELLED' });
  });

  it('does not expire a subscription that is due for renewal', () => {
    const sub = create({ autoRenew: true });
    expect(sub.shouldExpire(end)).toBe(false);
    expect(
      codeOf(() => {
        sub.expire(end);
      }),
    ).toBe('INVALID_STATE_TRANSITION');
  });
});
