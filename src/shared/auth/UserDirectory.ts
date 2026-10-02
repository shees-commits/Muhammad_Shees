import type { Role } from './Actor.js';

export interface UserIdentity {
  sub: string;
  email: string | null;
  role: Role;
}

export interface UserProfile {
  id: string;
  authSub: string;
  email: string | null;
  role: Role;
  createdAt: Date;
}

/** Port for just-in-time user provisioning from verified token identities. */
export interface UserDirectory {
  /** Idempotent and safe under concurrent first requests for the same subject. */
  provision(identity: UserIdentity): Promise<UserProfile>;
  findById(id: string): Promise<UserProfile | null>;
}
