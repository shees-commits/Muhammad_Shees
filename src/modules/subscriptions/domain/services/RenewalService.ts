import type { Actor } from '../../../../shared/auth/Actor.js';
import type { Clock } from '../../../../shared/kernel/Clock.js';
import { SubscriptionAccessDeniedError } from '../errors.js';
import { SubscriptionPolicy } from '../policies/SubscriptionPolicy.js';
import type { Subscription } from '../entities/Subscription.js';
import type { PaymentGateway } from '../ports/PaymentGateway.js';
import type {
  LockedSubscriptionTransaction,
  SubscriptionRepository,
} from '../ports/SubscriptionRepository.js';

export type RenewalOutcome =
  | { subscriptionId: string; outcome: 'RENEWED'; newEndDate: Date }
  | { subscriptionId: string; outcome: 'PAYMENT_FAILED'; reason: string }
  | { subscriptionId: string; outcome: 'EXPIRED' | 'CANCELLED' }
  | { subscriptionId: string; outcome: 'ERROR'; error: string };

export interface RenewalRunResult {
  startedAt: Date;
  renewed: number;
  paymentFailed: number;
  expired: number;
  errors: number;
  outcomes: RenewalOutcome[];
}

/**
 * Billing simulation. Each due subscription is claimed with
 * FOR UPDATE SKIP LOCKED and processed in its own transaction (D-06): the
 * charge, the state change and the PaymentAttempt commit together, and
 * concurrent runs on other instances skip rows already being processed.
 */
export class RenewalService {
  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly payments: PaymentGateway,
    private readonly clock: Clock,
    private readonly batchSize: number,
  ) {}

  /** Admin-triggered run (POST /admin/billing/run-renewals). */
  async runAs(actor: Actor): Promise<RenewalRunResult> {
    if (!SubscriptionPolicy.canRunBilling(actor)) throw new SubscriptionAccessDeniedError();
    return this.runOnce();
  }

  async runOnce(): Promise<RenewalRunResult> {
    const now = this.clock.now();
    const outcomes: RenewalOutcome[] = [];
    const attempted: string[] = [];

    // 1. Renew everything that is due (auto-renew on, not cancelled, renewalDate reached).
    while (attempted.length < this.batchSize) {
      let claimedId: string | undefined;
      let outcome: RenewalOutcome | undefined;
      try {
        const claimed = await this.repo.withNextDueForRenewal(now, attempted, async (sub, tx) => {
          claimedId = sub.id;
          outcome = await this.renewLocked(sub, tx, now);
        });
        if (claimed === null) break;
        attempted.push(claimed);
        // Recorded only after the transaction committed.
        if (outcome) outcomes.push(outcome);
      } catch (error) {
        // That subscription's transaction rolled back; record it, skip it, keep going.
        if (claimedId === undefined) throw error;
        attempted.push(claimedId);
        outcomes.push({ subscriptionId: claimedId, outcome: 'ERROR', error: String(error) });
      }
    }

    // 2. Close out periods that ended without renewal (cancelled or auto-renew off).
    const expired: string[] = [];
    while (expired.length < this.batchSize) {
      let outcome: RenewalOutcome | undefined;
      const claimed = await this.repo.withNextExpirable(now, expired, async (sub, tx) => {
        sub.expire(now);
        await tx.save(sub);
        outcome = {
          subscriptionId: sub.id,
          outcome: sub.snapshot.inactiveReason === 'CANCELLED' ? 'CANCELLED' : 'EXPIRED',
        };
      });
      if (claimed === null) break;
      expired.push(claimed);
      if (outcome) outcomes.push(outcome);
    }

    return {
      startedAt: now,
      renewed: outcomes.filter((o) => o.outcome === 'RENEWED').length,
      paymentFailed: outcomes.filter((o) => o.outcome === 'PAYMENT_FAILED').length,
      expired: outcomes.filter((o) => o.outcome === 'EXPIRED' || o.outcome === 'CANCELLED').length,
      errors: outcomes.filter((o) => o.outcome === 'ERROR').length,
      outcomes,
    };
  }

  /** Charge → apply outcome → persist state and payment attempt, all under the row lock. */
  private async renewLocked(
    sub: Subscription,
    tx: LockedSubscriptionTransaction,
    now: Date,
  ): Promise<RenewalOutcome> {
    const { priceCents, currency, endDate } = sub.snapshot;
    const result = await this.payments.charge({
      subscriptionId: sub.id,
      userId: sub.userId,
      amountCents: priceCents,
      currency,
      kind: 'RENEWAL',
      idempotencyKey: `${sub.id}:renewal:${endDate.toISOString()}`,
    });
    sub.renew(result, now);
    await tx.save(sub);
    await tx.recordPayment({
      subscriptionId: sub.id,
      amountCents: priceCents,
      status: result.status,
      kind: 'RENEWAL',
      failureReason: result.status === 'FAILED' ? result.reason : null,
      createdAt: now,
    });
    return result.status === 'SUCCEEDED'
      ? { subscriptionId: sub.id, outcome: 'RENEWED', newEndDate: sub.snapshot.endDate }
      : { subscriptionId: sub.id, outcome: 'PAYMENT_FAILED', reason: result.reason };
  }
}
