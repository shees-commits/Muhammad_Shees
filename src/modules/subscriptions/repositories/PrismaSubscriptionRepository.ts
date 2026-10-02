import { Prisma, type PrismaClient, type Subscription as SubscriptionRow } from '@prisma/client';
import { Subscription, type SubscriptionProps } from '../domain/entities/Subscription.js';
import { ConcurrentModificationError, SubscriptionNotFoundError } from '../domain/errors.js';
import type {
  LockedSubscriptionTransaction,
  LockedWork,
  PaymentRecord,
  SubscriptionFilter,
  SubscriptionPage,
  SubscriptionRepository,
  SubscriptionStats,
} from '../domain/ports/SubscriptionRepository.js';

const LOCKED_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 10_000,
  timeout: 15_000,
};

function toDomain(row: SubscriptionRow): Subscription {
  return Subscription.restore({
    id: row.id,
    userId: row.userId,
    tier: row.tier,
    billingCycle: row.billingCycle,
    maxMessages: row.maxMessages,
    usedMessages: row.usedMessages,
    priceCents: row.priceCents,
    currency: row.currency,
    startDate: row.startDate,
    endDate: row.endDate,
    renewalDate: row.renewalDate,
    autoRenew: row.autoRenew,
    status: row.status,
    inactiveReason: row.inactiveReason,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  });
}

/** Fields a lifecycle transition may change. Usage counters are deliberately absent. */
function lifecycleFields(s: Readonly<SubscriptionProps>) {
  return {
    startDate: s.startDate,
    endDate: s.endDate,
    renewalDate: s.renewalDate,
    autoRenew: s.autoRenew,
    status: s.status,
    inactiveReason: s.inactiveReason,
    cancelledAt: s.cancelledAt,
    updatedAt: s.updatedAt,
  };
}

function paymentData(payment: PaymentRecord) {
  return {
    subscriptionId: payment.subscriptionId,
    amountCents: payment.amountCents,
    status: payment.status,
    kind: payment.kind,
    failureReason: payment.failureReason,
    createdAt: payment.createdAt,
  };
}

class LockedTransaction implements LockedSubscriptionTransaction {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async save(subscription: Subscription): Promise<void> {
    const s = subscription.snapshot;
    // The row is locked by this transaction, so writing the usage reset is safe here.
    await this.tx.subscription.update({
      where: { id: s.id },
      data: { ...lifecycleFields(s), usedMessages: s.usedMessages, version: { increment: 1 } },
    });
  }

  async recordPayment(payment: PaymentRecord): Promise<void> {
    await this.tx.paymentAttempt.create({ data: paymentData(payment) });
  }
}

export class PrismaSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(subscription: Subscription, payment: PaymentRecord): Promise<void> {
    const s = subscription.snapshot;
    await this.prisma.$transaction([
      this.prisma.subscription.create({
        data: {
          id: s.id,
          userId: s.userId,
          tier: s.tier,
          billingCycle: s.billingCycle,
          maxMessages: s.maxMessages,
          usedMessages: s.usedMessages,
          priceCents: s.priceCents,
          currency: s.currency,
          createdAt: s.createdAt,
          ...lifecycleFields(s),
        },
      }),
      this.prisma.paymentAttempt.create({ data: paymentData(payment) }),
    ]);
  }

  async findById(id: string): Promise<Subscription | null> {
    const row = await this.prisma.subscription.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async listByUser(userId: string): Promise<Subscription[]> {
    const rows = await this.prisma.subscription.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toDomain);
  }

  async list(
    filter: SubscriptionFilter,
    page: SubscriptionPage,
  ): Promise<{ items: Subscription[]; total: number }> {
    const where: Prisma.SubscriptionWhereInput = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.tier ? { tier: filter.tier } : {}),
      ...(filter.userId ? { userId: filter.userId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit,
        skip: page.offset,
      }),
      this.prisma.subscription.count({ where }),
    ]);
    return { items: rows.map(toDomain), total };
  }

  async saveLifecycle(subscription: Subscription): Promise<Subscription> {
    const s = subscription.snapshot;
    const { count } = await this.prisma.subscription.updateMany({
      where: { id: s.id, version: s.version },
      data: { ...lifecycleFields(s), version: { increment: 1 } },
    });
    if (count !== 1) {
      const exists = await this.prisma.subscription.count({ where: { id: s.id } });
      throw exists ? new ConcurrentModificationError(s.id) : new SubscriptionNotFoundError();
    }
    const saved = await this.findById(s.id);
    if (!saved) throw new SubscriptionNotFoundError();
    return saved;
  }

  async withNextDueForRenewal(
    now: Date,
    exclude: readonly string[],
    work: LockedWork,
  ): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      // SKIP LOCKED: rows another worker is already renewing are invisible here,
      // so two instances can never charge the same subscription twice.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Subscription"
        WHERE status = 'ACTIVE'
          AND "autoRenew" = true
          AND "cancelledAt" IS NULL
          AND "renewalDate" IS NOT NULL
          AND "renewalDate" <= ${now.toISOString()}::timestamptz
          AND NOT (id = ANY(${[...exclude]}::uuid[]))
        ORDER BY "renewalDate" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      return this.runLocked(tx, rows[0]?.id, work);
    }, LOCKED_TX_OPTIONS);
  }

  async withNextExpirable(
    now: Date,
    exclude: readonly string[],
    work: LockedWork,
  ): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Subscription"
        WHERE status = 'ACTIVE'
          AND "endDate" <= ${now.toISOString()}::timestamptz
          AND ("autoRenew" = false OR "cancelledAt" IS NOT NULL OR "renewalDate" IS NULL)
          AND NOT (id = ANY(${[...exclude]}::uuid[]))
        ORDER BY "endDate" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      return this.runLocked(tx, rows[0]?.id, work);
    }, LOCKED_TX_OPTIONS);
  }

  async statsSince(since: Date): Promise<SubscriptionStats> {
    const [activeByTier, inactiveByReason, cancelledButActive, payments] = await Promise.all([
      this.prisma.subscription.groupBy({
        by: ['tier'],
        where: { status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.subscription.groupBy({
        by: ['inactiveReason'],
        where: { status: 'INACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.subscription.count({ where: { status: 'ACTIVE', cancelledAt: { not: null } } }),
      this.prisma.paymentAttempt.groupBy({
        by: ['kind', 'status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
    ]);

    const stats: SubscriptionStats = {
      activeByTier: { BASIC: 0, PRO: 0, ENTERPRISE: 0 },
      inactiveByReason: { PAYMENT_FAILED: 0, EXPIRED: 0, CANCELLED: 0 },
      cancelledButActive,
      payments: {
        INITIAL: { succeeded: 0, failed: 0, revenueCents: 0 },
        RENEWAL: { succeeded: 0, failed: 0, revenueCents: 0 },
      },
    };
    for (const g of activeByTier) stats.activeByTier[g.tier] = g._count._all;
    for (const g of inactiveByReason) {
      if (g.inactiveReason) stats.inactiveByReason[g.inactiveReason] = g._count._all;
    }
    for (const g of payments) {
      const bucket = stats.payments[g.kind];
      if (g.status === 'SUCCEEDED') {
        bucket.succeeded = g._count._all;
        bucket.revenueCents = g._sum.amountCents ?? 0;
      } else {
        bucket.failed = g._count._all;
      }
    }
    return stats;
  }

  private async runLocked(
    tx: Prisma.TransactionClient,
    id: string | undefined,
    work: LockedWork,
  ): Promise<string | null> {
    if (id === undefined) return null;
    const row = await tx.subscription.findUniqueOrThrow({ where: { id } });
    await work(toDomain(row), new LockedTransaction(tx));
    return id;
  }
}
