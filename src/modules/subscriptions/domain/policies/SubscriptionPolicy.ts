import { isAdmin, type Actor } from '../../../../shared/auth/Actor.js';

/** Domain-level authorization for subscriptions (second layer, D-07). */
export const SubscriptionPolicy = {
  canCreate(_actor: Actor): boolean {
    return true;
  },

  canView(actor: Actor, subscription: { userId: string }): boolean {
    return isAdmin(actor) || subscription.userId === actor.userId;
  },

  /** Only the owner changes their own billing; admins have read-only system-wide access. */
  canModify(actor: Actor, subscription: { userId: string }): boolean {
    return subscription.userId === actor.userId;
  },

  canViewAll(actor: Actor): boolean {
    return isAdmin(actor);
  },

  canRunBilling(actor: Actor): boolean {
    return isAdmin(actor);
  },

  canViewSystemMetrics(actor: Actor): boolean {
    return isAdmin(actor);
  },
} as const;
