import { describe, expect, it } from 'vitest';
import { isUsable, selectBundle } from '../../../src/modules/chat/domain/entities/BundleQuota.js';
import {
  nextPeriodStart,
  periodOf,
} from '../../../src/modules/chat/domain/entities/QuotaPeriod.js';
import { bundle } from './fakes.js';

const now = new Date('2026-03-15T12:00:00Z');
const userId = 'u1';

describe('periodOf / nextPeriodStart (UTC calendar month)', () => {
  it('uses the UTC month, not local time', () => {
    expect(periodOf(new Date('2026-03-31T23:59:59.999Z'))).toBe('2026-03');
    expect(periodOf(new Date('2026-04-01T00:00:00.000Z'))).toBe('2026-04');
  });

  it('resets at 00:00 UTC on the 1st of the next month, across year boundaries', () => {
    expect(nextPeriodStart(now).toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(nextPeriodStart(new Date('2026-12-31T10:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});

describe('selectBundle (A-01: newest usable bundle)', () => {
  it('picks the bundle with the latest startDate', () => {
    const older = bundle({ userId, startDate: new Date('2026-03-01T00:00:00Z') });
    const newer = bundle({ userId, startDate: new Date('2026-03-10T00:00:00Z') });
    expect(selectBundle([older, newer], now)?.id).toBe(newer.id);
  });

  it('breaks startDate ties by latest createdAt', () => {
    const first = bundle({ userId, createdAt: new Date('2026-03-01T00:00:00Z') });
    const second = bundle({ userId, createdAt: new Date('2026-03-01T00:00:01Z') });
    expect(selectBundle([first, second], now)?.id).toBe(second.id);
  });

  it('skips an exhausted newer bundle in favour of an older one with quota', () => {
    const older = bundle({ userId, startDate: new Date('2026-03-01T00:00:00Z') });
    const exhausted = bundle({
      userId,
      startDate: new Date('2026-03-10T00:00:00Z'),
      usedMessages: 10,
    });
    expect(selectBundle([older, exhausted], now)?.id).toBe(older.id);
  });

  it('treats a null maxMessages (Enterprise) as unlimited', () => {
    const enterprise = bundle({ userId, tier: 'ENTERPRISE', maxMessages: null, usedMessages: 1e6 });
    expect(isUsable(enterprise, now)).toBe(true);
  });

  it('ignores inactive, expired and not-yet-started bundles', () => {
    expect(
      selectBundle(
        [
          bundle({ userId, status: 'INACTIVE' }),
          bundle({ userId, endDate: new Date('2026-03-15T12:00:00Z') }), // end is exclusive
          bundle({
            userId,
            startDate: new Date('2026-03-16T00:00:00Z'),
            endDate: new Date('2026-04-16T00:00:00Z'),
          }),
        ],
        now,
      ),
    ).toBeUndefined();
  });
});
