import { Prisma, type PrismaClient } from '@prisma/client';
import type { NonceStore } from './NonceStore.js';

export class PrismaNonceStore implements NonceStore {
  constructor(private readonly prisma: PrismaClient) {}

  async consume(sub: string, nonce: string, expiresAt: Date): Promise<boolean> {
    try {
      // The composite primary key makes this insert the atomic "first use wins" check.
      await this.prisma.usedNonce.create({ data: { userSub: sub, nonce, expiresAt } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  async purgeExpired(now: Date): Promise<number> {
    const { count } = await this.prisma.usedNonce.deleteMany({ where: { expiresAt: { lt: now } } });
    return count;
  }
}
