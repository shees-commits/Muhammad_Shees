import type { Subscription, SubscriptionStatus } from '../entities/Subscription.js';
import type { Tier } from '../entities/Tier.js';
import type { PaymentKind } from './PaymentGateway.js';

export interface PaymentRecord {
  subscriptionId: string;
  amountCents: number;
  status: 'SUCCEEDED' | 'FAILED';
  kind: PaymentKind;
  failureReason: string | null;
  createdAt: Date;
}

export interface SubscriptionFilter {
  status?: SubscriptionStatus | undefined;
  tier?: Tier | undefined;
  userId?: string | undefined;
}

export interface SubscriptionPage {
  limit: number;
  offset: number;
}

export interface SubscriptionStats {
  activeByTier: Record<Tier, number>;
  inactiveByReason: Record<'PAYMENT_FAILED' | 'EXPIRED' | 'CANCELLED', number>;
  cancelledButActive: number;
  payments: Record<PaymentKind, { succeeded: number; failed: number; revenueCents: number }>;
}

/** Operations inside a renewal transaction that holds the subscription's row lock. */
export interface LockedSubscriptionTransaction {
  /** Persists every field, including the usage reset a renewal performs. */
  save(subscription: Subscription): Promise<void>;
  recordPayment(payment: PaymentRecord): Promise<void>;
}

export type LockedWork = (
  subscription: Subscription,
  tx: LockedSubscriptionTransaction,
) => Promise<void>;

export interface SubscriptionRepository {
  /** Inserts a new subscription and its initial payment attempt atomically. */
  create(subscription: Subscription, payment: PaymentRecord): Promise<void>;
  findById(id: string): Promise<Subscription | null>;
  listByUser(userId: string): Promise<Subscription[]>;
  list(
    filter: SubscriptionFilter,
    page: SubscriptionPage,
  ): Promise<{ items: Subscription[]; total: number }>;
  /**
   * Persists lifecycle changes (auto-renew, cancellation) with an optimistic
   * version check. Never overwrites usage counters, which the chat module
   * updates under its own row lock.
   */
  saveLifecycle(subscription: Subscription): Promise<Subscription>;
  /**
   * Claims the next subscription due for renewal with FOR UPDATE SKIP LOCKED
   * and runs `work` in that transaction. Rows locked by another instance are
   * skipped, never double-processed. Returns the claimed ID, or null when none is due.
   */
  withNextDueForRenewal(
    now: Date,
    exclude: readonly string[],
    work: LockedWork,
  ): Promise<string | null>;
  /** Same claiming strategy for subscriptions whose period ended without renewal. */
  withNextExpirable(
    now: Date,
    exclude: readonly string[],
    work: LockedWork,
  ): Promise<string | null>;
  statsSince(since: Date): Promise<SubscriptionStats>;
}
