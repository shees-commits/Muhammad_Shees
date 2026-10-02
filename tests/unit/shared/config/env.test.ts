import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../../src/shared/config/env.js';
import { testEnv } from '../../../helpers/testConfig.js';

function problemsFor(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected loadConfig to fail');
}

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const { PAYMENT_FAILURE_RATE: _pinnedForTests, ...env } = testEnv();
    const config = loadConfig(env);
    expect(config.auth.issuer).toBe('https://mock-idp.test/');
    expect(config.auth.replayWindowSeconds).toBe(300);
    expect(config.http.requestTimeoutMs).toBe(10_000);
    expect(config.http.trustProxy).toBe(false);
    expect(config.rateLimit.auth).toEqual({ perIp: 10, perUser: 5 });
    expect(config.rateLimit.chat).toEqual({ perIp: 60, perUser: 20 });
    expect(config.billing.paymentFailureRate).toBe(0.2);
  });

  it('fails fast when a required secret is missing', () => {
    const { AUTH_ISSUER: _omitted, ...env } = testEnv();
    expect(problemsFor(env).some((p) => p.startsWith('AUTH_ISSUER'))).toBe(true);
  });

  it('rejects a non-https issuer or JWKS URI', () => {
    const problems = problemsFor(
      testEnv({ AUTH_ISSUER: 'http://idp.test/', AUTH_JWKS_URI: 'http://idp.test/jwks' }),
    );
    expect(problems.some((p) => p.startsWith('AUTH_ISSUER'))).toBe(true);
    expect(problems.some((p) => p.startsWith('AUTH_JWKS_URI'))).toBe(true);
  });

  it('rejects wildcard and malformed CORS origins', () => {
    expect(problemsFor(testEnv({ CORS_ORIGINS: '*' }))[0]).toMatch(/^CORS_ORIGINS/);
    expect(problemsFor(testEnv({ CORS_ORIGINS: 'https://app.test/path' }))[0]).toMatch(
      /^CORS_ORIGINS/,
    );
  });

  it('parses a comma-separated CORS allowlist', () => {
    const config = loadConfig(
      testEnv({ CORS_ORIGINS: 'https://a.example.com, https://b.example.com:8443' }),
    );
    expect(config.http.corsOrigins).toEqual([
      'https://a.example.com',
      'https://b.example.com:8443',
    ]);
  });

  it('refuses TRUST_PROXY=true (would allow X-Forwarded-For spoofing)', () => {
    expect(problemsFor(testEnv({ TRUST_PROXY: 'true' }))[0]).toMatch(/^TRUST_PROXY/);
    expect(loadConfig(testEnv({ TRUST_PROXY: '1' })).http.trustProxy).toBe(1);
  });

  it('validates numeric ranges and cross-field rules', () => {
    expect(problemsFor(testEnv({ PAYMENT_FAILURE_RATE: '1.5' }))[0]).toMatch(
      /^PAYMENT_FAILURE_RATE/,
    );
    expect(
      problemsFor(testEnv({ LLM_MIN_LATENCY_MS: '2000', LLM_MAX_LATENCY_MS: '100' }))[0],
    ).toMatch(/^LLM_MAX_LATENCY_MS/);
    expect(problemsFor(testEnv({ RENEWAL_CRON: 'not a cron' }))[0]).toMatch(/^RENEWAL_CRON/);
  });

  it('never echoes configuration values in error messages', () => {
    const secretLookingValue = 'postgres-but-not-a-url-s3cr3t';
    const error = (() => {
      try {
        loadConfig(testEnv({ DATABASE_URL: secretLookingValue }));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).not.toContain(secretLookingValue);
  });
});
