import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NonceStore } from '../../../../src/shared/auth/NonceStore.js';
import { assertFreshRequest } from '../../../../src/shared/auth/replayProtection.middleware.js';
import { AppError } from '../../../../src/shared/errors/AppError.js';
import { FakeClock } from '../../../helpers/FakeClock.js';

class InMemoryNonceStore implements NonceStore {
  readonly entries = new Map<string, Date>();

  consume(sub: string, nonce: string, expiresAt: Date): Promise<boolean> {
    const key = `${sub}:${nonce}`;
    if (this.entries.has(key)) return Promise.resolve(false);
    this.entries.set(key, expiresAt);
    return Promise.resolve(true);
  }

  purgeExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
}

describe('assertFreshRequest (timestamp + nonce replay protection)', () => {
  const clock = new FakeClock('2026-05-01T10:00:00.000Z');
  const deps = () => ({ store: new InMemoryNonceStore(), clock, windowSeconds: 300 });
  const now = () => clock.now().getTime();

  it('accepts a fresh timestamp and an unused nonce, recording expiry at timestamp + window', async () => {
    const d = deps();
    const nonce = randomUUID();
    await assertFreshRequest({ sub: 'u1', timestamp: String(now()), nonce }, d);
    expect(d.store.entries.get(`u1:${nonce}`)?.getTime()).toBe(now() + 300_000);
  });

  it('rejects a stale timestamp with REQUEST_EXPIRED', async () => {
    const stale = String(now() - 301_000);
    expect(
      await codeOf(
        assertFreshRequest({ sub: 'u1', timestamp: stale, nonce: randomUUID() }, deps()),
      ),
    ).toBe('REQUEST_EXPIRED');
  });

  it('rejects a future timestamp beyond the window with REQUEST_EXPIRED', async () => {
    const future = String(now() + 301_000);
    expect(
      await codeOf(
        assertFreshRequest({ sub: 'u1', timestamp: future, nonce: randomUUID() }, deps()),
      ),
    ).toBe('REQUEST_EXPIRED');
  });

  it('accepts timestamps at the edge of the window', async () => {
    const d = deps();
    await assertFreshRequest(
      { sub: 'u1', timestamp: String(now() - 300_000), nonce: randomUUID() },
      d,
    );
    await assertFreshRequest(
      { sub: 'u1', timestamp: String(now() + 300_000), nonce: randomUUID() },
      d,
    );
  });

  it('rejects a reused nonce with REPLAY_DETECTED', async () => {
    const d = deps();
    const input = { sub: 'u1', timestamp: String(now()), nonce: randomUUID() };
    await assertFreshRequest(input, d);
    expect(await codeOf(assertFreshRequest(input, d))).toBe('REPLAY_DETECTED');
  });

  it('treats nonce case variants as the same nonce', async () => {
    const d = deps();
    const nonce = randomUUID();
    await assertFreshRequest({ sub: 'u1', timestamp: String(now()), nonce }, d);
    expect(
      await codeOf(
        assertFreshRequest({ sub: 'u1', timestamp: String(now()), nonce: nonce.toUpperCase() }, d),
      ),
    ).toBe('REPLAY_DETECTED');
  });

  it('binds nonces to the token subject', async () => {
    const d = deps();
    const nonce = randomUUID();
    await assertFreshRequest({ sub: 'u1', timestamp: String(now()), nonce }, d);
    await assertFreshRequest({ sub: 'u2', timestamp: String(now()), nonce }, d);
    expect(d.store.entries.size).toBe(2);
  });

  it.each([
    ['missing timestamp', undefined, randomUUID()],
    ['missing nonce', 'now', undefined],
    ['seconds instead of ms', 'seconds', randomUUID()],
    ['non-UUID nonce', 'now', 'abc'],
    ['UUID v1 nonce', 'now', 'c232ab00-9414-11ec-b3c8-9e6bdeced846'],
  ])('rejects %s with UNAUTHENTICATED', async (_label, ts, nonce) => {
    const timestamp =
      ts === 'now' ? String(now()) : ts === 'seconds' ? String(Math.floor(now() / 1000)) : ts;
    expect(await codeOf(assertFreshRequest({ sub: 'u1', timestamp, nonce }, deps()))).toBe(
      'UNAUTHENTICATED',
    );
  });
});
