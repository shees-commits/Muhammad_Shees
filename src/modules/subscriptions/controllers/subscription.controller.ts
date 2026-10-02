import type { Subscription } from '../domain/entities/Subscription.js';

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/** Aggregate → response DTO. */
export function toSubscriptionDto(subscription: Subscription) {
  const s = subscription.snapshot;
  return {
    id: s.id,
    userId: s.userId,
    tier: s.tier,
    billingCycle: s.billingCycle,
    maxMessages: s.maxMessages,
    usedMessages: s.usedMessages,
    remainingMessages: s.maxMessages === null ? null : Math.max(0, s.maxMessages - s.usedMessages),
    priceCents: s.priceCents,
    currency: s.currency,
    startDate: s.startDate.toISOString(),
    endDate: s.endDate.toISOString(),
    renewalDate: iso(s.renewalDate),
    autoRenew: s.autoRenew,
    status: s.status,
    inactiveReason: s.inactiveReason,
    cancelledAt: iso(s.cancelledAt),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
