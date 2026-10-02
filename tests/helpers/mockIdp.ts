import { randomUUID } from 'node:crypto';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';

export const MOCK_ISSUER = 'https://mock-idp.test/';
export const MOCK_AUDIENCE = 'https://ggi-api';
export const MOCK_ROLES_CLAIM = 'https://ggi-api/roles';

export interface TokenOptions {
  sub?: string;
  roles?: string[];
  /** Auth0 issues `aud` as an array; a string is also allowed. */
  aud?: string | string[];
  iss?: string;
  /** Seconds since epoch; defaults to now + 1h. */
  exp?: number;
  nbf?: number;
  /** "now" used for iat/exp defaults (lets tests align tokens with a fake clock). */
  now?: Date;
  email?: string;
  /** Sign with a different key than the one published in the JWKS. */
  signWith?: 'trusted' | 'untrusted';
  omitSub?: boolean;
}

export interface MockIdp {
  /** Local JWKS injected into the app in place of Auth0's remote JWKS. */
  jwks: JWTVerifyGetKey;
  issueToken: (options?: TokenOptions) => Promise<string>;
  /** An unsigned token (`alg: none`) — must always be rejected. */
  unsignedToken: (options?: TokenOptions) => string;
}

/**
 * A stand-in identity provider: a fresh RS256 key pair per test run,
 * published as a local JWKS. Tokens go through the real verifier unchanged.
 */
export async function createMockIdp(): Promise<MockIdp> {
  const kid = randomUUID();
  const trusted = await generateKeyPair('RS256', { extractable: true });
  const untrusted = await generateKeyPair('RS256');
  const publicJwk: JWK = { ...(await exportJWK(trusted.publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [publicJwk] });

  const claimsFor = (options: TokenOptions) => {
    const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
    return {
      nowSeconds,
      claims: {
        [MOCK_ROLES_CLAIM]: options.roles ?? [],
        ...(options.email === undefined ? {} : { email: options.email }),
      },
    };
  };

  const issueToken = async (options: TokenOptions = {}): Promise<string> => {
    const { nowSeconds, claims } = claimsFor(options);
    const key: CryptoKey =
      options.signWith === 'untrusted' ? untrusted.privateKey : trusted.privateKey;
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer(options.iss ?? MOCK_ISSUER)
      .setAudience(options.aud ?? [MOCK_AUDIENCE, 'https://mock-idp.test/userinfo'])
      .setIssuedAt(nowSeconds)
      .setExpirationTime(options.exp ?? nowSeconds + 3600);
    if (!options.omitSub) jwt = jwt.setSubject(options.sub ?? `auth0|${randomUUID()}`);
    if (options.nbf !== undefined) jwt = jwt.setNotBefore(options.nbf);
    return jwt.sign(key);
  };

  const unsignedToken = (options: TokenOptions = {}): string => {
    const { nowSeconds, claims } = claimsFor(options);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'none', typ: 'JWT' });
    const payload = encode({
      ...claims,
      sub: options.sub ?? 'auth0|attacker',
      iss: options.iss ?? MOCK_ISSUER,
      aud: options.aud ?? MOCK_AUDIENCE,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    });
    return `${header}.${payload}.`;
  };

  return { jwks, issueToken, unsignedToken };
}
