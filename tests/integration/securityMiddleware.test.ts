import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/shared/http/app.js';
import { errorOf } from '../helpers/http.js';
import { createTestApp, type TestApp } from '../helpers/testApp.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

describe('security headers', () => {
  it('sets helmet headers suitable for a JSON API and hides the framework', async () => {
    const res = await request(t.app).get('/health');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none'",
    );
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('request ID', () => {
  it('echoes a valid caller-supplied UUID', async () => {
    const id = '0b5c1c9e-8f2a-4d3b-9c6e-1f2a3b4c5d6e';
    const res = await request(t.app).get('/health').set('X-Request-Id', id);
    expect(res.headers['x-request-id']).toBe(id);
  });

  it('replaces a malformed request ID (log-injection attempt)', async () => {
    const res = await request(t.app).get('/health').set('X-Request-Id', 'abc"} {"level":"fatal');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });
});

describe('CORS', () => {
  it('allows an allowlisted origin without credentials', async () => {
    const res = await request(t.app).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers preflight for an allowlisted origin with explicit methods and headers', async () => {
    const res = await request(t.app)
      .options('/chat/messages')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PATCH');
    expect(res.headers['access-control-allow-headers']).toContain('X-Request-Nonce');
  });

  it('rejects a disallowed origin with 403 and no CORS headers', async () => {
    const res = await request(t.app).get('/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('body handling', () => {
  it('rejects a non-JSON content type with 415', async () => {
    const res = await request(t.app)
      .post('/auth/session/verify')
      .set(await t.headersFor())
      .set('Content-Type', 'text/plain')
      .send('hello');
    expect(res.status).toBe(415);
    expect(errorOf(res).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects form-encoded bodies with 415 before authentication runs', async () => {
    const res = await request(t.app).post('/auth/session/verify').type('form').send({ a: 'b' });
    expect(res.status).toBe(415);
  });

  it('rejects a body over 10 KB with 413', async () => {
    const res = await request(t.app)
      .post('/auth/session/verify')
      .set(await t.headersFor())
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(11 * 1024) }));
    expect(res.status).toBe(413);
    expect(errorOf(res).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects malformed JSON with 400 MALFORMED_JSON', async () => {
    const res = await request(t.app)
      .post('/auth/session/verify')
      .set('Content-Type', 'application/json')
      .send('{"unterminated": ');
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('MALFORMED_JSON');
  });

  it('rejects non-object JSON roots (strict parser)', async () => {
    const res = await request(t.app)
      .post('/auth/session/verify')
      .set('Content-Type', 'application/json')
      .send('"just a string"');
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('MALFORMED_JSON');
  });
});

describe('global request timeout', () => {
  it('answers 503 REQUEST_TIMEOUT for a slow handler, exactly once', async () => {
    const slow = await createTestApp({ env: { REQUEST_TIMEOUT_MS: '100', LLM_TIMEOUT_MS: '50' } });
    let handlerFinished = false;
    const app = createApp({
      ...slow.container.appDeps,
      checkDatabase: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            handlerFinished = true;
            resolve(true);
          }, 400),
        ),
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe('REQUEST_TIMEOUT');
    // The late handler must not crash the process or produce a second response.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(handlerFinished).toBe(true);
  });
});
