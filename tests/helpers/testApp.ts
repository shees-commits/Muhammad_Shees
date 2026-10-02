import type { Express } from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { createContainer, type Container, type ContainerOverrides } from '../../src/container.js';
import { createApp } from '../../src/shared/http/app.js';
import type { Clock } from '../../src/shared/kernel/Clock.js';
import { createMockIdp, type MockIdp, type TokenOptions } from './mockIdp.js';
import { authHeaders } from './signedRequest.js';
import { testConfig } from './testConfig.js';
import { testPrisma } from './testDatabase.js';

export interface TestApp {
  app: Express;
  idp: MockIdp;
  container: Container;
  clock: Clock;
  /** Issues a token (aligned with the app clock) and returns full auth + replay headers. */
  headersFor: (options?: TokenOptions) => Promise<Record<string, string>>;
  /** Shorthand for an authenticated agent bound to one identity. */
  as: (options: TokenOptions) => AuthedClient;
}

export interface AuthedClient {
  get: (path: string) => Promise<request.Response>;
  post: (path: string, body?: object) => Promise<request.Response>;
  patch: (path: string, body?: object) => Promise<request.Response>;
}

/** Generous limits so only the dedicated rate-limit tests ever hit them. */
const RELAXED_LIMITS: Record<string, string> = {
  RATE_LIMIT_GLOBAL_PER_IP: '100000',
  RATE_LIMIT_AUTH_PER_IP: '100000',
  RATE_LIMIT_AUTH_PER_USER: '100000',
  RATE_LIMIT_CHAT_PER_IP: '100000',
  RATE_LIMIT_CHAT_PER_USER: '100000',
  RATE_LIMIT_SUBSCRIPTIONS_PER_IP: '100000',
  RATE_LIMIT_SUBSCRIPTIONS_PER_USER: '100000',
  RATE_LIMIT_ADMIN_PER_IP: '100000',
  RATE_LIMIT_ADMIN_PER_USER: '100000',
};

export interface TestAppOptions {
  env?: Record<string, string>;
  overrides?: Omit<ContainerOverrides, 'jwks'>;
  /** Keep production-default rate limits instead of relaxed ones. */
  realRateLimits?: boolean;
}

/**
 * Builds the real application through the real composition root. The only
 * substitutions are adapters a test environment cannot reach (Auth0's JWKS)
 * or must control (clock, randomness) — authentication itself is never bypassed.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const idp = await createMockIdp();
  const config = testConfig({ ...(options.realRateLimits ? {} : RELAXED_LIMITS), ...options.env });
  const container = createContainer(config, {
    logger: pino({ level: 'silent' }),
    prisma: testPrisma(),
    ...options.overrides,
    jwks: idp.jwks,
  });
  const app = createApp(container.appDeps);
  const clock = container.appDeps.clock;

  const headersFor = async (tokenOptions: TokenOptions = {}) =>
    authHeaders(await idp.issueToken({ now: clock.now(), ...tokenOptions }), clock.now());

  const as = (tokenOptions: TokenOptions): AuthedClient => ({
    get: async (path) =>
      request(app)
        .get(path)
        .set(await headersFor(tokenOptions)),
    post: async (path, body) => {
      const req = request(app)
        .post(path)
        .set(await headersFor(tokenOptions));
      return body === undefined ? req : req.send(body);
    },
    patch: async (path, body) => {
      const req = request(app)
        .patch(path)
        .set(await headersFor(tokenOptions));
      return body === undefined ? req : req.send(body);
    },
  });

  return { app, idp, container, clock, headersFor, as };
}
