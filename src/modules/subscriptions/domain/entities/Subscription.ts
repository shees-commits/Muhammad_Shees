import { AlreadyCancelledError, InvalidStateTransitionError } from '../errors.js';
import type { PaymentResult } from '../ports/PaymentGateway.js';
import { addCycle, type BillingCycle } from './BillingCycle.js';
import { CURRENCY, maxMessagesFor, priceCentsFor, type Tier } from './Tier.js';

export type SubscriptionStatus = 'ACTIVE' | 'INACTIVE';
export type InactiveReason = 'PAYMENT_FAILED' | 'EXPIRED' | 'CANCELLED';

export interface SubscriptionProps {
  id: string;
  userId: string;
  tier: Tier;
  billingCycle: BillingCycle;
  maxMessages: number | null;
  usedMessages: number;
  priceCents: number;
  currency: string;
  startDate: Date;
  endDate: Date;
  renewalDate: Date | null;
  autoRenew: boolean;
  status: SubscriptionStatus;
  inactiveReason: InactiveReason | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Optimistic-concurrency token as last read from storage. */
  version: number;
}

export interface CreateSubscriptionInput {
  userId: string;
  tier: Tier;
  billingCycle: BillingCycle;
  autoRenew: boolean;
  now: Date;
}

/**
 * Subscription aggregate. All lifecycle rules live here as pure methods;
 * time is always passed in (no hidden clock). Price and quota are derived
 * from the tier catalogue, never from client input.
 *
 *   ACTIVE ──cancel──▶ ACTIVE (cancelled, no renewal) ──endDate──▶ INACTIVE/CANCELLED
 *   ACTIVE ──endDate, auto-renew off──▶ INACTIVE/EXPIRED
 *   ACTIVE ──renewal paid──▶ ACTIVE (next period, usage reset)
 *   ACTIVE ──renewal declined / initial payment declined──▶ INACTIVE/PAYMENT_FAILED
 */
export class Subscription {
  private constructor(private props: SubscriptionProps) {}

  static create(input: CreateSubscriptionInput): Subscription {
    const endDate = addCycle(input.now, input.billingCycle);
    return new Subscription({
      id: crypto.randomUUID(),
      userId: input.userId,
      tier: input.tier,
      billingCycle: input.billingCycle,
      maxMessages: maxMessagesFor(input.tier, input.billingCycle),
      usedMessages: 0,
      priceCents: priceCentsFor(input.tier, input.billingCycle),
      currency: CURRENCY,
      startDate: input.now,
      endDate,
      renewalDate: input.autoRenew ? endDate : null,
      autoRenew: input.autoRenew,
      status: 'ACTIVE',
      inactiveReason: null,
      cancelledAt: null,
      createdAt: input.now,
      updatedAt: input.now,
      version: 0,
    });
  }

  static restore(props: SubscriptionProps): Subscription {
    return new Subscription({ ...props });
  }

  get snapshot(): Readonly<SubscriptionProps> {
    return { ...this.props };
  }

  get id(): string {
    return this.props.id;
  }

  get userId(): string {
    return this.props.userId;
  }

  get status(): SubscriptionStatus {
    return this.props.status;
  }

  get isCancelled(): boolean {
    return this.props.cancelledAt !== null;
  }

  /** The initial charge was declined: keep the record for history, but never activate it (A-05). */
  failInitialPayment(now: Date): void {
    this.props = {
      ...this.props,
      status: 'INACTIVE',
      inactiveReason: 'PAYMENT_FAILED',
      autoRenew: false,
      renewalDate: null,
      updatedAt: now,
    };
  }

  setAutoRenew(enabled: boolean, now: Date): void {
    if (this.props.status !== 'ACTIVE') {
      throw new InvalidStateTransitionError(
        'Auto-renew cannot be changed on an inactive subscription',
        {
          status: this.props.status,
        },
      );
    }
    if (this.isCancelled) {
      throw new InvalidStateTransitionError(
        'Auto-renew cannot be changed on a cancelled subscription',
      );
    }
    this.props = {
      ...this.props,
      autoRenew: enabled,
      renewalDate: enabled ? this.props.endDate : null,
      updatedAt: now,
    };
  }

  /**
   * Ends the subscription at the close of the current cycle: it stays ACTIVE
   * and usable until endDate (A-08), will never renew, and keeps all usage history.
   */
  cancel(now: Date): void {
    if (this.isCancelled) throw new AlreadyCancelledError(this.props.id);
    if (this.props.status !== 'ACTIVE') {
      throw new InvalidStateTransitionError('Only an active subscription can be cancelled', {
        status: this.props.status,
      });
    }
    this.props = {
      ...this.props,
      cancelledAt: now,
      autoRenew: false,
      renewalDate: null,
      updatedAt: now,
    };
  }

  isDueForRenewal(now: Date): boolean {
    const { status, autoRenew, renewalDate } = this.props;
    return (
      status === 'ACTIVE' &&
      autoRenew &&
      !this.isCancelled &&
      renewalDate !== null &&
      renewalDate.getTime() <= now.getTime()
    );
  }

  /** Applies the outcome of a renewal charge. */
  renew(payment: PaymentResult, now: Date): void {
    if (!this.isDueForRenewal(now)) {
      throw new InvalidStateTransitionError('Subscription is not due for renewal', {
        subscriptionId: this.props.id,
      });
    }
    if (payment.status === 'FAILED') {
      this.props = {
        ...this.props,
        status: 'INACTIVE',
        inactiveReason: 'PAYMENT_FAILED',
        autoRenew: false,
        renewalDate: null,
        updatedAt: now,
      };
      return;
    }
    // The new period starts exactly where the old one ended: no gap, no overlap.
    const startDate = this.props.endDate;
    const endDate = addCycle(startDate, this.props.billingCycle);
    this.props = {
      ...this.props,
      startDate,
      endDate,
      renewalDate: endDate,
      usedMessages: 0,
      updatedAt: now,
    };
  }

  /** True when the period is over and no renewal will happen. */
  shouldExpire(now: Date): boolean {
    return (
      this.props.status === 'ACTIVE' &&
      now.getTime() >= this.props.endDate.getTime() &&
      !this.isDueForRenewal(now)
    );
  }

  expire(now: Date): void {
    if (!this.shouldExpire(now)) {
      throw new InvalidStateTransitionError('Subscription cannot expire yet', {
        subscriptionId: this.props.id,
      });
    }
    this.props = {
      ...this.props,
      status: 'INACTIVE',
      inactiveReason: this.isCancelled ? 'CANCELLED' : 'EXPIRED',
      autoRenew: false,
      renewalDate: null,
      updatedAt: now,
    };
  }
}
