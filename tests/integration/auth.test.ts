import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorOf } from '../helpers/http.js';
import { MOCK_AUDIENCE, MOCK_ISSUER } from '../helpers/mockIdp.js';
import { authHeaders, replayHeaders } from '../helpers/signedRequest.js';
import { createTestApp, type TestApp } from '../helpers/testApp.js';
import { resetDatabase, testPrisma } from '../helpers/testDatabase.js';

const prisma = testPrisma();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function getMe(headers: Record<string, string>) {
  return request(t.app).get('/auth/me').set(headers);
}

describe('authentication: token verification', () => {
  it('rejects a request with no token (401 UNAUTHENTICATED)', async () => {
    const res = await request(t.app).get('/auth/me').set(replayHeaders());
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const token = await t.idp.issueToken();
    const res = await getMe({ ...replayHeaders(), Authorization: `Basic ${token}` });
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('INVALID_TOKEN');
  });

  it('rejects tokens passed in the query string', async () => {
    const token = await t.idp.issueToken();
    const res = await request(t.app).get(`/auth/me?access_token=${token}`).set(authHeaders(token));
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['wrong issuer', { iss: 'https://evil-idp.test/' }],
    ['wrong audience', { aud: 'https://some-other-api' }],
    ['expired', { exp: nowSeconds() - 60 }],
    ['not yet valid (nbf)', { nbf: nowSeconds() + 600 }],
    ['bad signature (untrusted key)', { signWith: 'untrusted' as const }],
    ['missing sub', { omitSub: true }],
  ])('rejects a token with %s (401 INVALID_TOKEN)', async (_label, options) => {
    const token = await t.idp.issueToken(options);
    const res = await getMe(authHeaders(token));
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('INVALID_TOKEN');
    expect(errorOf(res).message).toBe('Access token is invalid or expired');
  });

  it('rejects an unsigned token (alg: none)', async () => {
    const res = await getMe(authHeaders(t.idp.unsignedToken()));
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('INVALID_TOKEN');
  });

  it('rejects a token whose payload was tampered with', async () => {
    const token = await t.idp.issueToken({ roles: [] });
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    claims['https://ggi-api/roles'] = ['admin'];
    const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
    const res = await getMe(authHeaders(forged));
    expect(res.status).toBe(401);
  });

  it('accepts an Auth0-style token (aud array) and returns the provisioned profile', async () => {
    const token = await t.idp.issueToken({
      sub: 'auth0|alice',
      aud: [MOCK_AUDIENCE, `${MOCK_ISSUER}userinfo`],
      email: 'alice@example.com',
    });
    const res = await getMe(authHeaders(token));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sub: 'auth0|alice',
      email: 'alice@example.com',
      role: 'USER',
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const users = await prisma.user.findMany({ where: { authSub: 'auth0|alice' } });
    expect(users).toHaveLength(1);
  });

  it('maps the roles claim to ADMIN and mirrors role changes into the database', async () => {
    const admin = await getMe(
      authHeaders(await t.idp.issueToken({ sub: 'auth0|bob', roles: ['admin'] })),
    );
    expect(admin.body).toMatchObject({ role: 'ADMIN', roles: ['admin'] });

    const demoted = await getMe(
      authHeaders(await t.idp.issueToken({ sub: 'auth0|bob', roles: [] })),
    );
    expect(demoted.body).toMatchObject({ role: 'USER' });
    const user = await prisma.user.findUniqueOrThrow({ where: { authSub: 'auth0|bob' } });
    expect(user.role).toBe('USER');
  });

  it('provisions exactly one user when first requests arrive concurrently', async () => {
    const token = await t.idp.issueToken({ sub: 'auth0|racer' });
    const responses = await Promise.all(Array.from({ length: 8 }, () => getMe(authHeaders(token))));
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(await prisma.user.count({ where: { authSub: 'auth0|racer' } })).toBe(1);
  });
});

describe('authentication: possession of a token is not enough (replay protection)', () => {
  it('rejects a valid token without timestamp/nonce headers', async () => {
    const token = await t.idp.issueToken();
    const res = await request(t.app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it('rejects a replayed request (same nonce) with REPLAY_DETECTED', async () => {
    const headers = authHeaders(await t.idp.issueToken());
    expect((await getMe(headers)).status).toBe(200);

    const replay = await getMe(headers);
    expect(replay.status).toBe(401);
    expect(errorOf(replay).code).toBe('REPLAY_DETECTED');
  });

  it('rejects a stale request timestamp with REQUEST_EXPIRED', async () => {
    const token = await t.idp.issueToken();
    const res = await getMe(authHeaders(token, new Date(Date.now() - 10 * 60_000)));
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('REQUEST_EXPIRED');
  });

  it('POST /auth/session/verify returns token and replay diagnostics', async () => {
    const headers = authHeaders(await t.idp.issueToken({ sub: 'auth0|carol' }));
    const res = await request(t.app).post('/auth/session/verify').set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valid: true,
      sub: 'auth0|carol',
      issuer: MOCK_ISSUER,
      replayProtection: { nonce: headers['X-Request-Nonce'], windowSeconds: 300 },
    });
    expect(res.body).toHaveProperty('audience', [MOCK_AUDIENCE, `${MOCK_ISSUER}userinfo`]);
  });

  it('POST /auth/session/verify rejects unknown body fields', async () => {
    const res = await request(t.app)
      .post('/auth/session/verify')
      .set(await t.headersFor())
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect(errorOf(res).details).toEqual({
      issues: [{ path: 'body.role', message: 'Unknown field' }],
    });
  });
});
