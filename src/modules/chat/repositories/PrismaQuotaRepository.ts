import { Prisma, type PrismaClient } from '@prisma/client';
import type { BundleQuota } from '../domain/entities/BundleQuota.js';
import type { ChatMessage } from '../domain/entities/ChatMessage.js';
import type {
  NewPendingMessage,
  QuotaRepository,
  QuotaTransaction,
  Reservation,
  UsageSnapshot,
} from '../domain/ports/QuotaRepository.js';
import { toChatMessage } from './mappers.js';

interface BundleRow {
  id: string;
  tier: string;
  status: 'ACTIVE' | 'INACTIVE';
  startDate: Date;
  endDate: Date;
  maxMessages: number | null;
  usedMessages: number;
  createdAt: Date;
}

const TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 10_000,
  timeout: 10_000,
};

class PrismaQuotaTransaction implements QuotaTransaction {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async freeUsed(userId: string, period: string): Promise<number> {
    const row = await this.tx.monthlyFreeUsage.upsert({
      where: { userId_period: { userId, period } },
      create: { userId, period, used: 0 },
      update: {},
    });
    return row.used;
  }

  async incrementFreeUsage(userId: string, period: string): Promise<void> {
    await this.tx.monthlyFreeUsage.update({
      where: { userId_period: { userId, period } },
      data: { used: { increment: 1 } },
    });
  }

  async lockCandidateBundles(userId: string, now: Date): Promise<BundleQuota[]> {
    // Parameterised tagged template; FOR UPDATE keeps these rows stable until commit.
    return this.tx.$queryRaw<BundleRow[]>`
      SELECT id, tier::text AS tier, status::text AS status, "startDate", "endDate",
             "maxMessages", "usedMessages", "createdAt"
      FROM "Subscription"
      WHERE "userId" = ${userId}::uuid
        AND status = 'ACTIVE'
        AND "startDate" <= ${now.toISOString()}::timestamptz
        AND "endDate" > ${now.toISOString()}::timestamptz
      ORDER BY "startDate" DESC, "createdAt" DESC
      FOR UPDATE`;
  }

  async incrementBundleUsage(subscriptionId: string): Promise<void> {
    await this.tx.subscription.update({
      where: { id: subscriptionId },
      data: { usedMessages: { increment: 1 } },
    });
  }

  async insertPendingMessage(message: NewPendingMessage): Promise<ChatMessage> {
    const row = await this.tx.chatMessage.create({
      data: {
        userId: message.userId,
        question: message.question,
        requestId: message.requestId,
        quotaSource: message.quotaSource,
        subscriptionId: message.subscriptionId,
        status: 'PENDING',
        createdAt: message.createdAt,
      },
    });
    return toChatMessage(row);
  }
}

export class PrismaQuotaRepository implements QuotaRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async runExclusiveForUser<T>(
    userId: string,
    work: (tx: QuotaTransaction) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize every quota operation for this user (READ COMMITTED + explicit row lock).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new Error(`User ${userId} not found`);
      return work(new PrismaQuotaTransaction(tx));
    }, TX_OPTIONS);
  }

  async failAndRefund(reservation: Reservation, at: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const settled = await tx.chatMessage.updateMany({
        where: { id: reservation.messageId, status: 'PENDING' },
        data: { status: 'FAILED', completedAt: at },
      });
      if (settled.count !== 1) return; // already settled: never refund twice

      if (reservation.source === 'FREE') {
        await tx.monthlyFreeUsage.updateMany({
          where: { userId: reservation.userId, period: reservation.period, used: { gt: 0 } },
          data: { used: { decrement: 1 } },
        });
      } else if (reservation.subscriptionId !== null) {
        await tx.subscription.updateMany({
          where: { id: reservation.subscriptionId, usedMessages: { gt: 0 } },
          data: { usedMessages: { decrement: 1 } },
        });
      }
    }, TX_OPTIONS);
  }

  async usageSnapshot(userId: string, period: string, now: Date): Promise<UsageSnapshot> {
    const [free, bundles] = await Promise.all([
      this.prisma.monthlyFreeUsage.findUnique({ where: { userId_period: { userId, period } } }),
      this.prisma.subscription.findMany({
        where: { userId, status: 'ACTIVE', startDate: { lte: now }, endDate: { gt: now } },
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);
    return {
      freeUsed: free?.used ?? 0,
      bundles: bundles.map((b) => ({
        id: b.id,
        tier: b.tier,
        status: b.status,
        startDate: b.startDate,
        endDate: b.endDate,
        maxMessages: b.maxMessages,
        usedMessages: b.usedMessages,
        createdAt: b.createdAt,
      })),
    };
  }
}
