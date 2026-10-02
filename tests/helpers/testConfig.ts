import { loadConfig, type AppConfig } from '../../src/shared/config/env.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

/**
 * A complete, valid environment for tests. It is run through the real
 * `loadConfig` so tests exercise the same validation as production.
 */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    AUTH_ISSUER: 'https://mock-idp.test/',
    AUTH_AUDIENCE: 'https://ggi-api',
    AUTH_JWKS_URI: 'https://mock-idp.test/.well-known/jwks.json',
    AUTH_ROLES_CLAIM: 'https://ggi-api/roles',
    CORS_ORIGINS: 'http://localhost:5173',
    LLM_MIN_LATENCY_MS: '0',
    LLM_MAX_LATENCY_MS: '0',
    // Payments succeed unless a test opts into failures.
    PAYMENT_FAILURE_RATE: '0',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig(testEnv(overrides));
}
