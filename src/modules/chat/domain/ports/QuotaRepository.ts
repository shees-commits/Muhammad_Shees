import type { BundleQuota } from '../entities/BundleQuota.js';
import type { ChatMessage } from '../entities/ChatMessage.js';
import type { QuotaSource } from '../entities/QuotaSource.js';

export interface NewPendingMessage {
  userId: string;
  question: string;
  requestId: string;
  quotaSource: QuotaSource;
  subscriptionId: string | null;
  createdAt: Date;
}

/** Exactly which unit of quota a message consumed, so it can be refunded precisely. */
export interface Reservation {
  messageId: string;
  userId: string;
  source: QuotaSource;
  /** Free-quota period the unit was taken from (FREE only). */
  period: string;
  subscriptionId: string | null;
}

/**
 * Operations available inside the reserve transaction, which holds an
 * exclusive lock on the user so quota decisions for one user are serialized.
 */
export interface QuotaTransaction {
  /** Current free usage for the period (creating the period row at 0 if needed). */
  freeUsed(userId: string, period: string): Promise<number>;
  incrementFreeUsage(userId: string, period: string): Promise<void>;
  /** Candidate bundles, row-locked for the rest of the transaction. */
  lockCandidateBundles(userId: string, now: Date): Promise<BundleQuota[]>;
  incrementBundleUsage(subscriptionId: string): Promise<void>;
  insertPendingMessage(message: NewPendingMessage): Promise<ChatMessage>;
}

export interface UsageSnapshot {
  freeUsed: number;
  /** Active bundles whose current period contains `now` (including exhausted ones). */
  bundles: BundleQuota[];
}

export interface QuotaRepository {
  /** Runs `work` in one database transaction holding the user's quota lock. */
  runExclusiveForUser<T>(userId: string, work: (tx: QuotaTransaction) => Promise<T>): Promise<T>;
  /**
   * Compensation: marks the message FAILED and returns the exact unit to the
   * source it came from, atomically. A no-op if the message is no longer
   * PENDING, so a unit can never be refunded twice.
   */
  failAndRefund(reservation: Reservation, at: Date): Promise<void>;
  usageSnapshot(userId: string, period: string, now: Date): Promise<UsageSnapshot>;
}
