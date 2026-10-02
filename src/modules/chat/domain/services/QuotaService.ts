import { remainingOf, selectBundle, type BundleQuota } from '../entities/BundleQuota.js';
import type { ChatMessage } from '../entities/ChatMessage.js';
import { FREE_MESSAGES_PER_MONTH, nextPeriodStart, periodOf } from '../entities/QuotaPeriod.js';
import { QuotaSource } from '../entities/QuotaSource.js';
import { QuotaExceededError } from '../errors.js';
import type { QuotaRepository, Reservation } from '../ports/QuotaRepository.js';

export interface ReserveInput {
  userId: string;
  question: string;
  requestId: string;
  now: Date;
}

export interface UsageSummary {
  period: string;
  free: { limit: number; used: number; remaining: number; resetsAt: Date };
  bundles: {
    subscriptionId: string;
    tier: string;
    maxMessages: number | null;
    usedMessages: number;
    remaining: number | null;
    endDate: Date;
  }[];
  /** null = unlimited (an Enterprise bundle is active). */
  totalRemaining: number | null;
}

/**
 * Quota rules (the heart of the chat module):
 *  - free quota first (A-02): 3 per UTC calendar month, period-keyed so it resets itself (D-03);
 *  - then the newest usable bundle (A-01);
 *  - otherwise a typed QuotaExceededError.
 * The decision and the deduction happen in one transaction that holds the user's lock,
 * so concurrent requests cannot both spend the last unit.
 */
export class QuotaService {
  constructor(private readonly repo: QuotaRepository) {}

  /** Transaction 1 (reserve): deduct one unit and create the PENDING message. */
  async reserve(input: ReserveInput): Promise<{ message: ChatMessage; reservation: Reservation }> {
    const { userId, now } = input;
    const period = periodOf(now);

    return this.repo.runExclusiveForUser(userId, async (tx) => {
      let source: QuotaSource;
      let subscriptionId: string | null = null;

      const freeUsed = await tx.freeUsed(userId, period);
      if (freeUsed < FREE_MESSAGES_PER_MONTH) {
        await tx.incrementFreeUsage(userId, period);
        source = QuotaSource.FREE;
      } else {
        const candidates = await tx.lockCandidateBundles(userId, now);
        const bundle = selectBundle(candidates, now);
        if (!bundle) {
          throw new QuotaExceededError({
            freeUsed,
            freeLimit: FREE_MESSAGES_PER_MONTH,
            resetsAt: nextPeriodStart(now).toISOString(),
            activeBundles: 0,
            exhaustedBundles: candidates.filter((b) => inCurrentPeriod(b, now)).length,
          });
        }
        await tx.incrementBundleUsage(bundle.id);
        source = QuotaSource.SUBSCRIPTION;
        subscriptionId = bundle.id;
      }

      const message = await tx.insertPendingMessage({
        userId,
        question: input.question,
        requestId: input.requestId,
        quotaSource: source,
        subscriptionId,
        createdAt: now,
      });
      return {
        message,
        reservation: { messageId: message.id, userId, source, period, subscriptionId },
      };
    });
  }

  /** Compensation: return the reserved unit and mark the message FAILED. */
  async release(reservation: Reservation, at: Date): Promise<void> {
    await this.repo.failAndRefund(reservation, at);
  }

  async usage(userId: string, now: Date): Promise<UsageSummary> {
    const period = periodOf(now);
    const snapshot = await this.repo.usageSnapshot(userId, period, now);
    const freeUsed = Math.min(snapshot.freeUsed, FREE_MESSAGES_PER_MONTH);
    const freeRemaining = FREE_MESSAGES_PER_MONTH - freeUsed;
    const bundles = snapshot.bundles
      .filter((b) => inCurrentPeriod(b, now))
      .sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
    const remainders = bundles.map(remainingOf);

    return {
      period,
      free: {
        limit: FREE_MESSAGES_PER_MONTH,
        used: freeUsed,
        remaining: freeRemaining,
        resetsAt: nextPeriodStart(now),
      },
      bundles: bundles.map((b, i) => ({
        subscriptionId: b.id,
        tier: b.tier,
        maxMessages: b.maxMessages,
        usedMessages: b.usedMessages,
        remaining: remainders[i] ?? null,
        endDate: b.endDate,
      })),
      totalRemaining: remainders.includes(null)
        ? null
        : remainders.reduce<number>((sum, r) => sum + (r ?? 0), freeRemaining),
    };
  }
}

function inCurrentPeriod(bundle: BundleQuota, now: Date): boolean {
  return (
    bundle.status === 'ACTIVE' &&
    bundle.startDate.getTime() <= now.getTime() &&
    now.getTime() < bundle.endDate.getTime()
  );
}
