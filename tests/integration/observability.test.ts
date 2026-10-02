import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/testApp.js';

interface LogLine {
  level: string;
  msg: string;
  userId?: string;
  responseTimeMs?: number;
  req?: { id: string; method: string; path: string };
  res?: { statusCode: number };
}

describe('structured request logging', () => {
  it('logs request ID, user ID, route, status and response time — never credentials', async () => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'info', formatters: { level: (label) => ({ level: label }) } },
      { write: (line: string) => lines.push(line) },
    );
    const t = await createTestApp({ overrides: { logger } });
    const headers = await t.headersFor({ sub: 'auth0|logged' });

    const res = await request(t.app).get('/chat/messages?limit=7').set(headers);
    expect(res.status).toBe(200);
    const me = await t.as({ sub: 'auth0|logged' }).get('/auth/me');

    const entries = lines.map((l) => JSON.parse(l) as LogLine);
    const completed = entries.find((e) => e.msg === 'request completed');
    expect(completed).toMatchObject({
      level: 'info',
      userId: (me.body as { id: string }).id,
      req: { id: res.headers['x-request-id'], method: 'GET', path: '/chat/messages' },
      res: { statusCode: 200 },
    });
    expect(typeof completed?.responseTimeMs).toBe('number');

    const raw = lines.join('\n');
    const token = headers['Authorization']?.slice('Bearer '.length) ?? '';
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('limit=7'); // query strings are stripped from logged paths
    expect(raw).not.toContain(headers['X-Request-Nonce'] ?? 'nonce');
  });

  it('logs unexpected errors server-side while the client sees a generic 500', async () => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'info', formatters: { level: (label) => ({ level: label }) } },
      { write: (line: string) => lines.push(line) },
    );
    const t = await createTestApp({
      overrides: {
        logger,
        llm: {
          complete: () =>
            Promise.resolve({
              answer: 'x',
              model: 'm',
              usage: { promptTokens: -1, completionTokens: 0, totalTokens: -1 },
            }),
        },
      },
    });

    // Negative token counts violate a DB CHECK constraint → unexpected error path.
    const res = await t.as({ sub: 'auth0|err' }).post('/chat/messages', { question: 'q' });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/constraint|prisma|ChatMessage_tokens/i);
    expect(lines.some((l) => l.includes('"level":"error"') && l.includes('Unhandled error'))).toBe(
      true,
    );
  });
});
