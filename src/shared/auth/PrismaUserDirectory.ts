import { Prisma, type PrismaClient, type User } from '@prisma/client';
import type { UserDirectory, UserIdentity, UserProfile } from './UserDirectory.js';

function toProfile(user: User): UserProfile {
  return {
    id: user.id,
    authSub: user.authSub,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class PrismaUserDirectory implements UserDirectory {
  constructor(private readonly prisma: PrismaClient) {}

  async provision(identity: UserIdentity): Promise<UserProfile> {
    let user = await this.prisma.user.findUnique({ where: { authSub: identity.sub } });

    if (!user) {
      try {
        user = await this.prisma.user.create({
          data: { authSub: identity.sub, email: identity.email, role: identity.role },
        });
      } catch (error) {
        // Several first requests raced to create the same user; the winner's row is the one.
        if (!isUniqueViolation(error)) throw error;
        user = await this.prisma.user.findUniqueOrThrow({ where: { authSub: identity.sub } });
      }
    }

    // The token is the source of truth for role (A-07); mirror changes into the DB.
    const emailChanged = identity.email !== null && identity.email !== user.email;
    if (user.role !== identity.role || emailChanged) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { role: identity.role, ...(emailChanged ? { email: identity.email } : {}) },
      });
    }

    return toProfile(user);
  }

  async findById(id: string): Promise<UserProfile | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? toProfile(user) : null;
  }
}
