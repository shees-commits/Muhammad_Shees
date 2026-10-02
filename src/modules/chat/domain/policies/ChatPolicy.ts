import { isAdmin, type Actor } from '../../../../shared/auth/Actor.js';

/**
 * Domain-level authorization for chat (second layer, D-07). Pure functions:
 * users see only their own messages; admins see everything.
 */
export const ChatPolicy = {
  canAsk(_actor: Actor): boolean {
    return true;
  },

  canView(actor: Actor, message: { userId: string }): boolean {
    return isAdmin(actor) || message.userId === actor.userId;
  },

  canViewHistoryOf(actor: Actor, userId: string): boolean {
    return isAdmin(actor) || actor.userId === userId;
  },

  canViewSystemMetrics(actor: Actor): boolean {
    return isAdmin(actor);
  },
} as const;
