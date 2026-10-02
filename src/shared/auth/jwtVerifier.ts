import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';
import type { Clock } from '../kernel/Clock.js';
import { Role } from './Actor.js';

export interface VerifiedToken {
  sub: string;
  role: Role;
  /** Raw role names from the roles claim (informational). */
  roles: readonly string[];
  email: string | null;
  issuer: string;
  audience: readonly string[];
  issuedAt: Date | null;
  expiresAt: Date;
}

export type JwtVerifier = (token: string) => Promise<VerifiedToken>;

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  rolesClaim: string;
  /** Claim carrying the user's email (optional in access tokens). */
  emailClaim?: string;
  /** Key source: remote JWKS in production, a local JWKS in tests. */
  jwks: JWTVerifyGetKey;
  clock: Clock;
  clockToleranceSeconds?: number;
}

const MAX_CLOCK_TOLERANCE_SECONDS = 5;

/** Production key source: Auth0's JWKS endpoint, cached and rate-limited by jose. */
export function remoteJwks(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri), {
    timeoutDuration: 3_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
}

function rolesFrom(payload: JWTPayload, claim: string): string[] {
  const value = payload[claim];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Verifies an access token server-side: signature against the IdP's keys,
 * RS256 only (rejects `alg: none` and HS256 key-confusion), exact issuer,
 * audience (Auth0 sends `aud` as an array; any match is accepted), expiry and
 * not-before with at most 5 s of clock skew, and a non-empty `sub`.
 */
export function createJwtVerifier(options: JwtVerifierOptions): JwtVerifier {
  const clockTolerance = Math.min(
    options.clockToleranceSeconds ?? MAX_CLOCK_TOLERANCE_SECONDS,
    MAX_CLOCK_TOLERANCE_SECONDS,
  );

  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, options.jwks, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ['RS256'],
        clockTolerance,
        currentDate: options.clock.now(),
        requiredClaims: ['sub', 'exp', 'iss', 'aud'],
      }));
    } catch (error) {
      // One generic message for every failure: callers learn nothing about which check failed.
      throw new AppError(
        ErrorCode.INVALID_TOKEN,
        'Access token is invalid or expired',
        {},
        {
          cause: error,
        },
      );
    }

    const { sub, exp, iat, iss, aud } = payload;
    if (typeof sub !== 'string' || sub.length === 0 || exp === undefined || iss === undefined) {
      throw new AppError(ErrorCode.INVALID_TOKEN, 'Access token is invalid or expired');
    }

    const roles = rolesFrom(payload, options.rolesClaim);
    const email = payload[options.emailClaim ?? 'email'];
    return {
      sub,
      roles,
      role: roles.some((r) => r.toLowerCase() === 'admin') ? Role.ADMIN : Role.USER,
      email: typeof email === 'string' ? email : null,
      issuer: iss,
      audience: Array.isArray(aud) ? aud : aud === undefined ? [] : [aud],
      issuedAt: iat === undefined ? null : new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
    };
  };
}
