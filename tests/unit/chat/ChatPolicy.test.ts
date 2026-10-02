import { describe, expect, it } from 'vitest';
import { ChatPolicy } from '../../../src/modules/chat/domain/policies/ChatPolicy.js';
import type { Actor } from '../../../src/shared/auth/Actor.js';

const owner: Actor = { userId: 'alice', sub: 'a', role: 'USER' };
const other: Actor = { userId: 'bob', sub: 'b', role: 'USER' };
const admin: Actor = { userId: 'root', sub: 'r', role: 'ADMIN' };
const message = { userId: 'alice' };

describe('ChatPolicy', () => {
  it('owner allowed', () => {
    expect(ChatPolicy.canView(owner, message)).toBe(true);
    expect(ChatPolicy.canViewHistoryOf(owner, 'alice')).toBe(true);
  });

  it('other user denied', () => {
    expect(ChatPolicy.canView(other, message)).toBe(false);
    expect(ChatPolicy.canViewHistoryOf(other, 'alice')).toBe(false);
    expect(ChatPolicy.canViewSystemMetrics(other)).toBe(false);
  });

  it('admin allowed', () => {
    expect(ChatPolicy.canView(admin, message)).toBe(true);
    expect(ChatPolicy.canViewHistoryOf(admin, 'alice')).toBe(true);
    expect(ChatPolicy.canViewSystemMetrics(admin)).toBe(true);
  });
});
