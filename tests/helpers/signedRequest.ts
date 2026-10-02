import { randomUUID } from 'node:crypto';

/** Fresh replay-protection headers (timestamp + single-use nonce). */
export function replayHeaders(now: Date = new Date()): Record<string, string> {
  return {
    'X-Request-Timestamp': String(now.getTime()),
    'X-Request-Nonce': randomUUID(),
  };
}

/** Bearer token plus fresh replay headers: what every authenticated request needs. */
export function authHeaders(token: string, now: Date = new Date()): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...replayHeaders(now) };
}
