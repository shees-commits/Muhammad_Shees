import type { Actor } from '../../../../shared/auth/Actor.js';
import type { Clock } from '../../../../shared/kernel/Clock.js';
import type { BillingCycle } from '../entities/BillingCycle.js';
import { Subscription } from '../entities/Subscription.js';
import type { Tier } from '../entities/Tier.js';
import {
  PaymentFailedError,
  SubscriptionAccessDeniedError,
  SubscriptionNotFoundError,
} from '../errors.js';
import { SubscriptionPolicy } from '../policies/SubscriptionPolicy.js';
import type { PaymentGateway } from '../ports/PaymentGateway.js';
import type {
  SubscriptionFilter,
  SubscriptionPage,
  SubscriptionRepository,
  SubscriptionStats,
} from '../ports/SubscriptionRepository.js';

export interface CreateSubscriptionCommand {
  tier: Tier;
  billingCycle: BillingCycle;
  autoRenew: boolean;
}

export class SubscriptionService {
  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly payments: PaymentGateway,
    private readonly clock: Clock,
  ) {}

  /**
   * Creates a bundle and charges the first cycle. A declined payment still
   * persists the subscription (INACTIVE/PAYMENT_FAILED) and its payment
   * attempt for history (A-05), then surfaces PAYMENT_FAILED (402).
   */
  async create(actor: Actor, command: CreateSubscriptionCommand): Promise<Subscription> {
    if (!SubscriptionPolicy.canCreate(actor)) throw new SubscriptionAccessDeniedError();
    const now = this.clock.now();
    const subscription = Subscription.create({ userId: actor.userId, ...command, now });
    const { priceCents, currency } = subscription.snapshot;

    const result = await this.payments.charge({
      subscriptionId: subscription.id,
      userId: actor.userId,
      amountCents: priceCents,
      currency,
      kind: 'INITIAL',
      idempotencyKey: `${subscription.id}:initial`,
    });
    if (result.status === 'FAILED') subscription.failInitialPayment(now);

    await this.repo.create(subscription, {
      subscriptionId: subscription.id,
      amountCents: priceCents,
      status: result.status,
      kind: 'INITIAL',
      failureReason: result.status === 'FAILED' ? result.reason : null,
      createdAt: now,
    });

    if (result.status === 'FAILED') throw new PaymentFailedError(subscription.id, result.reason);
    return subscription;
  }

  async get(actor: Actor, id: string): Promise<Subscription> {
    const subscription = await this.repo.findById(id);
    // D-08: other users' subscriptions are indistinguishable from missing ones.
    if (!subscription || !SubscriptionPolicy.canView(actor, subscription)) {
      throw new SubscriptionNotFoundError();
    }
    return subscription;
  }

  async listOwn(actor: Actor): Promise<Subscription[]> {
    return this.repo.listByUser(actor.userId);
  }

  async setAutoRenew(actor: Actor, id: string, enabled: boolean): Promise<Subscription> {
    const subscription = await this.loadForModification(actor, id);
    subscription.setAutoRenew(enabled, this.clock.now());
    return this.repo.saveLifecycle(subscription);
  }

  async cancel(actor: Actor, id: string): Promise<Subscription> {
    const subscription = await this.loadForModification(actor, id);
    subscription.cancel(this.clock.now());
    return this.repo.saveLifecycle(subscription);
  }

  async listAll(
    actor: Actor,
    filter: SubscriptionFilter,
    page: SubscriptionPage,
  ): Promise<{ items: Subscription[]; total: number }> {
    if (!SubscriptionPolicy.canViewAll(actor)) throw new SubscriptionAccessDeniedError();
    return this.repo.list(filter, page);
  }

  async systemStats(actor: Actor, since: Date): Promise<SubscriptionStats> {
    if (!SubscriptionPolicy.canViewSystemMetrics(actor)) throw new SubscriptionAccessDeniedError();
    return this.repo.statsSince(since);
  }

  private async loadForModification(actor: Actor, id: string): Promise<Subscription> {
    const subscription = await this.repo.findById(id);
    if (!subscription || !SubscriptionPolicy.canModify(actor, subscription)) {
      throw new SubscriptionNotFoundError();
    }
    return subscription;
  }
}
