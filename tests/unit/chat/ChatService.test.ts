import { beforeEach, describe, expect, it } from 'vitest';
import { QuotaExceededError } from '../../../src/modules/chat/domain/errors.js';
import type { LLMProvider } from '../../../src/modules/chat/domain/ports/LLMProvider.js';
import { ChatService } from '../../../src/modules/chat/domain/services/ChatService.js';
import { QuotaService } from '../../../src/modules/chat/domain/services/QuotaService.js';
import type { AppError } from '../../../src/shared/errors/AppError.js';
import type { Actor } from '../../../src/shared/auth/Actor.js';
import { FakeClock } from '../../helpers/FakeClock.js';
import { bundle, echoLLM, failingLLM, hangingLLM, InMemoryChatStore } from './fakes.js';

const alice: Actor = { userId: 'alice', sub: 'auth0|alice', role: 'USER' };
const bob: Actor = { userId: 'bob', sub: 'auth0|bob', role: 'USER' };
const admin: Actor = { userId: 'root', sub: 'auth0|root', role: 'ADMIN' };

let store: InMemoryChatStore;
let clock: FakeClock;

function service(llm: LLMProvider = echoLLM, llmTimeoutMs = 1000): ChatService {
  return new ChatService({
    quota: new QuotaService(store),
    chats: store,
    llm,
    clock,
    llmTimeoutMs,
  });
}

async function ask(svc: ChatService, actor: Actor = alice) {
  return svc.ask(actor, { question: 'What is DDD?', requestId: 'req-1' });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

beforeEach(() => {
  store = new InMemoryChatStore();
  clock = new FakeClock('2026-03-15T12:00:00.000Z');
});

describe('quota deduction', () => {
  it('uses the 3 free messages first', async () => {
    const svc = service();
    store.bundles.push(bundle({ userId: alice.userId }));
    for (let i = 0; i < 3; i++) {
      const message = await ask(svc);
      expect(message.quotaSource).toBe('FREE');
      expect(message.subscriptionId).toBeNull();
    }
    expect(store.freeUsedOf('alice', '2026-03')).toBe(3);
    expect(store.bundles[0]?.usedMessages).toBe(0);
  });

  it('charges the 4th message to a bundle', async () => {
    const svc = service();
    const basic = bundle({ userId: alice.userId });
    store.bundles.push(basic);
    for (let i = 0; i < 3; i++) await ask(svc);

    const fourth = await ask(svc);
    expect(fourth.quotaSource).toBe('SUBSCRIPTION');
    expect(fourth.subscriptionId).toBe(basic.id);
    expect(store.bundle(basic.id).usedMessages).toBe(1);
  });

  it('charges the newest eligible bundle and skips exhausted ones', async () => {
    const svc = service();
    store.free.set('alice:2026-03', 3);
    const old = bundle({ userId: 'alice', startDate: new Date('2026-03-01T00:00:00Z') });
    const newest = bundle({
      userId: 'alice',
      startDate: new Date('2026-03-12T00:00:00Z'),
      maxMessages: 2,
    });
    store.bundles.push(old, newest);

    expect((await ask(svc)).subscriptionId).toBe(newest.id);
    expect((await ask(svc)).subscriptionId).toBe(newest.id);
    // newest is now exhausted → fall back to the older bundle
    expect((await ask(svc)).subscriptionId).toBe(old.id);
    expect(store.bundle(newest.id).usedMessages).toBe(2);
    expect(store.bundle(old.id).usedMessages).toBe(1);
  });

  it('never runs out on an Enterprise (unlimited) bundle', async () => {
    const svc = service();
    store.free.set('alice:2026-03', 3);
    const ent = bundle({
      userId: 'alice',
      tier: 'ENTERPRISE',
      maxMessages: null,
      usedMessages: 5000,
    });
    store.bundles.push(ent);
    for (let i = 0; i < 5; i++) expect((await ask(svc)).subscriptionId).toBe(ent.id);
    expect(store.bundle(ent.id).usedMessages).toBe(5005);
  });

  it('ignores expired and inactive bundles', async () => {
    const svc = service();
    store.free.set('alice:2026-03', 3);
    store.bundles.push(
      bundle({ userId: 'alice', status: 'INACTIVE' }),
      bundle({
        userId: 'alice',
        startDate: new Date('2026-02-01T00:00:00Z'),
        endDate: new Date('2026-03-01T00:00:00Z'),
      }),
    );
    expect(await rejection(ask(svc))).toBeInstanceOf(QuotaExceededError);
  });

  it('never charges another user’s bundle', async () => {
    const svc = service();
    store.free.set('alice:2026-03', 3);
    store.bundles.push(bundle({ userId: 'bob' }));
    expect(await rejection(ask(svc))).toBeInstanceOf(QuotaExceededError);
  });

  it('raises a typed QuotaExceededError with reset date when nothing is left', async () => {
    const svc = service();
    for (let i = 0; i < 3; i++) await ask(svc);
    store.bundles.push(bundle({ userId: 'alice', usedMessages: 10 }));

    const error = await rejection(ask(svc));
    expect(error).toBeInstanceOf(QuotaExceededError);
    const quotaError = error as QuotaExceededError;
    expect(quotaError.code).toBe('QUOTA_EXCEEDED');
    expect(quotaError.details).toEqual({
      freeUsed: 3,
      freeLimit: 3,
      resetsAt: '2026-04-01T00:00:00.000Z',
      activeBundles: 0,
      exhaustedBundles: 1,
    });
    expect(store.messages.size).toBe(3); // no message recorded for the rejected request
  });

  it('resets the free quota when the UTC month rolls over', async () => {
    const svc = service();
    for (let i = 0; i < 3; i++) await ask(svc);
    expect(await rejection(ask(svc))).toBeInstanceOf(QuotaExceededError);

    clock.set('2026-04-01T00:00:00.000Z');
    const message = await ask(svc);
    expect(message.quotaSource).toBe('FREE');
    expect(store.freeUsedOf('alice', '2026-04')).toBe(1);
    expect(store.freeUsedOf('alice', '2026-03')).toBe(3); // history preserved
  });

  it('keeps users independent', async () => {
    const svc = service();
    for (let i = 0; i < 3; i++) await ask(svc, alice);
    expect((await ask(svc, bob)).quotaSource).toBe('FREE');
  });
});

describe('reserve → generate → finalize', () => {
  it('stores question, answer, tokens and request metadata', async () => {
    const message = await ask(service());
    expect(message).toMatchObject({
      status: 'COMPLETED',
      userId: 'alice',
      question: 'What is DDD?',
      answer: 'echo: What is DDD?',
      requestId: 'req-1',
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      createdAt: clock.now(),
    });
  });

  it('refunds the free unit and marks the message FAILED when the LLM fails', async () => {
    const error = await rejection(ask(service(failingLLM)));
    expect((error as AppError).code).toBe('LLM_UNAVAILABLE');
    expect(store.freeUsedOf('alice', '2026-03')).toBe(0);
    expect([...store.messages.values()].map((m) => m.status)).toEqual(['FAILED']);
  });

  it('refunds the exact bundle unit when the LLM fails on a paid message', async () => {
    store.free.set('alice:2026-03', 3);
    const b = bundle({ userId: 'alice', usedMessages: 4 });
    store.bundles.push(b);
    await rejection(ask(service(failingLLM)));
    expect(store.bundle(b.id).usedMessages).toBe(4);
    expect(store.freeUsedOf('alice', '2026-03')).toBe(3);
  });

  it('times out a hanging LLM and refunds', async () => {
    const error = await rejection(ask(service(hangingLLM, 20)));
    expect((error as AppError).code).toBe('LLM_UNAVAILABLE');
    expect(store.freeUsedOf('alice', '2026-03')).toBe(0);
  });

  it('aborts and refunds when the HTTP request is aborted', async () => {
    const controller = new AbortController();
    const pending = service(hangingLLM, 10_000).ask(alice, {
      question: 'q',
      requestId: 'r',
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort(new Error('request timed out'));
    }, 10);
    expect(((await rejection(pending)) as AppError).code).toBe('LLM_UNAVAILABLE');
    expect(store.freeUsedOf('alice', '2026-03')).toBe(0);
  });

  it('never refunds twice', async () => {
    await rejection(ask(service(failingLLM)));
    const [failed] = [...store.messages.values()];
    if (!failed) throw new Error('missing message');
    await store.failAndRefund(
      {
        messageId: failed.id,
        userId: 'alice',
        source: 'FREE',
        period: '2026-03',
        subscriptionId: null,
      },
      clock.now(),
    );
    expect(store.freeUsedOf('alice', '2026-03')).toBe(0);
  });
});

describe('stale PENDING recovery (crash between reserve and finalize)', () => {
  it('fails and refunds messages stuck in PENDING past the cut-off, to their original source', async () => {
    const quota = new QuotaService(store);
    store.free.set('alice:2026-03', 0);
    const b = bundle({ userId: 'alice', usedMessages: 0 });
    store.bundles.push(b);
    // Simulate crashes: reserve without finalize.
    for (let i = 0; i < 4; i++) {
      await quota.reserve({ userId: 'alice', question: 'q', requestId: 'r', now: clock.now() });
    }
    expect(store.freeUsedOf('alice', '2026-03')).toBe(3);
    expect(store.bundle(b.id).usedMessages).toBe(1);

    const svc = service();
    expect(await svc.recoverStalePending(60_000)).toBe(0); // not stale yet

    clock.advance(2 * 60_000);
    expect(await svc.recoverStalePending(60_000)).toBe(4);
    expect(store.freeUsedOf('alice', '2026-03')).toBe(0);
    expect(store.bundle(b.id).usedMessages).toBe(0);
    expect([...store.messages.values()].every((m) => m.status === 'FAILED')).toBe(true);
  });
});

describe('domain authorization (ChatPolicy via ChatService)', () => {
  it('lets owners read their message, hides it from others (404) and allows admins', async () => {
    const svc = service();
    const message = await ask(svc, alice);

    expect((await svc.getMessage(alice, message.id)).id).toBe(message.id);
    expect(((await rejection(svc.getMessage(bob, message.id))) as AppError).code).toBe('NOT_FOUND');
    expect((await svc.getMessage(admin, message.id)).id).toBe(message.id);
  });

  it('only admins may list another user’s history or read system stats', async () => {
    const svc = service();
    expect(
      ((await rejection(svc.listMessagesOf(bob, 'alice', { limit: 10, offset: 0 }))) as AppError)
        .code,
    ).toBe('FORBIDDEN');
    expect((await svc.listMessagesOf(alice, 'alice', { limit: 10, offset: 0 })).total).toBe(0);
    expect(((await rejection(svc.systemStats(alice, clock.now()))) as AppError).code).toBe(
      'FORBIDDEN',
    );
  });
});

describe('usage summary', () => {
  it('reports free remaining, reset date and per-bundle remaining', async () => {
    const svc = service();
    const basic = bundle({ userId: 'alice', usedMessages: 4 });
    store.bundles.push(basic, bundle({ userId: 'alice', status: 'INACTIVE' }));
    await ask(svc);

    const usage = await svc.usage(alice);
    expect(usage.free).toEqual({
      limit: 3,
      used: 1,
      remaining: 2,
      resetsAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    expect(usage.bundles).toHaveLength(1);
    expect(usage.bundles[0]).toMatchObject({ subscriptionId: basic.id, remaining: 6 });
    expect(usage.totalRemaining).toBe(8);
  });

  it('reports unlimited remaining when an Enterprise bundle is active', async () => {
    store.bundles.push(bundle({ userId: 'alice', maxMessages: null, tier: 'ENTERPRISE' }));
    expect((await service().usage(alice)).totalRemaining).toBeNull();
  });
});
