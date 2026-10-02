import {
  Subscription,
  type SubscriptionProps,
} from '../../../src/modules/subscriptions/domain/entities/Subscription.js';
import { ConcurrentModificationError } from '../../../src/modules/subscriptions/domain/errors.js';
import type {
  PaymentGateway,
  PaymentResult,
} from '../../../src/modules/subscriptions/domain/ports/PaymentGateway.js';
import type {
  LockedWork,
  PaymentRecord,
  SubscriptionFilter,
  SubscriptionRepository,
  SubscriptionStats,
} from '../../../src/modules/subscriptions/domain/ports/SubscriptionRepository.js';

/** In-memory repository; locked work is applied only if it completes (rollback on throw). */
export class InMemorySubscriptionRepository implements SubscriptionRepository {
  readonly rows = new Map<string, SubscriptionProps>();
  readonly payments: PaymentRecord[] = [];

  get(id: string): SubscriptionProps {
    const row = this.rows.get(id);
    if (!row) throw new Error(`missing ${id}`);
    return row;
  }

  create(subscription: Subscription, payment: PaymentRecord): Promise<void> {
    this.rows.set(subscription.id, { ...subscription.snapshot });
    this.payments.push(payment);
    return Promise.resolve();
  }

  findById(id: string): Promise<Subscription | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? Subscription.restore(row) : null);
  }

  listByUser(userId: string): Promise<Subscription[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.userId === userId)
        .map((r) => Subscription.restore(r)),
    );
  }

  list(filter: SubscriptionFilter): Promise<{ items: Subscription[]; total: number }> {
    const items = [...this.rows.values()]
      .filter((r) => (filter.status ? r.status === filter.status : true))
      .map((r) => Subscription.restore(r));
    return Promise.resolve({ items, total: items.length });
  }

  saveLifecycle(subscription: Subscription): Promise<Subscription> {
    const s = subscription.snapshot;
    const current = this.get(s.id);
    if (current.version !== s.version) throw new ConcurrentModificationError(s.id);
    const { usedMessages } = current; // lifecycle saves never touch usage
    this.rows.set(s.id, { ...s, usedMessages, version: s.version + 1 });
    return Promise.resolve(Subscription.restore(this.get(s.id)));
  }

  withNextDueForRenewal(now: Date, exclude: readonly string[], work: LockedWork) {
    const next = [...this.rows.values()]
      .filter((r) => !exclude.includes(r.id) && Subscription.restore(r).isDueForRenewal(now))
      .sort((a, b) => (a.renewalDate?.getTime() ?? 0) - (b.renewalDate?.getTime() ?? 0))[0];
    return this.runLocked(next, work);
  }

  withNextExpirable(now: Date, exclude: readonly string[], work: LockedWork) {
    const next = [...this.rows.values()].find(
      (r) => !exclude.includes(r.id) && Subscription.restore(r).shouldExpire(now),
    );
    return this.runLocked(next, work);
  }

  statsSince(): Promise<SubscriptionStats> {
    throw new Error('not used in unit tests');
  }

  private async runLocked(row: SubscriptionProps | undefined, work: LockedWork) {
    if (!row) return null;
    let saved: SubscriptionProps | undefined;
    const pending: PaymentRecord[] = [];
    await work(Subscription.restore(row), {
      save: (sub) => {
        saved = { ...sub.snapshot, version: sub.snapshot.version + 1 };
        return Promise.resolve();
      },
      recordPayment: (p) => {
        pending.push(p);
        return Promise.resolve();
      },
    });
    if (saved) this.rows.set(row.id, saved);
    this.payments.push(...pending);
    return row.id;
  }
}

/** Gateway returning a scripted sequence of outcomes (then always succeeding). */
export class ScriptedGateway implements PaymentGateway {
  readonly charges: { kind: string; amountCents: number; idempotencyKey: string }[] = [];

  constructor(private readonly script: ('ok' | 'fail' | 'throw')[] = []) {}

  charge(request: Parameters<PaymentGateway['charge']>[0]): Promise<PaymentResult> {
    this.charges.push(request);
    const next = this.script.shift() ?? 'ok';
    if (next === 'throw') return Promise.reject(new Error('gateway unreachable'));
    return Promise.resolve(
      next === 'ok'
        ? { status: 'SUCCEEDED', reference: 'ref' }
        : { status: 'FAILED', reason: 'card_declined' },
    );
  }
}
