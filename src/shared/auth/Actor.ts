/**
 * The authenticated principal, derived only from a verified access token.
 * Framework-free so domain policies can depend on it.
 */
export const Role = {
  USER: 'USER',
  ADMIN: 'ADMIN',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export interface Actor {
  /** Internal user ID (UUID), provisioned just-in-time from the token subject. */
  readonly userId: string;
  /** Identity-provider subject (`sub` claim). */
  readonly sub: string;
  readonly role: Role;
}

export function isAdmin(actor: Actor): boolean {
  return actor.role === Role.ADMIN;
}
