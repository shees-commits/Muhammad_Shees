import cron from 'node-cron';
import { z } from 'zod';

/**
 * Environment configuration. Every variable is validated at startup and the
 * process refuses to boot on any problem (fail fast). Secrets never have
 * defaults; operational knobs do.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const positiveInt = z.coerce.number().int().positive();

const httpsUrl = z.url({ protocol: /^https$/, error: 'must be an https URL' });

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgresql:// URL');

const cronExpression = z
  .string()
  .min(1)
  .refine((value) => cron.validate(value), 'must be a valid cron expression');

/** Comma-separated list of exact origins (scheme://host[:port]); wildcards are rejected. */
const corsOrigins = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .refine((origin) => !origin.includes('*'), 'wildcard origins are not allowed')
          .refine((origin) => {
            try {
              return new URL(origin).origin === origin;
            } catch {
              return false;
            }
          }, 'must be an exact origin like https://app.example.com (no path or trailing slash)'),
      )
      .min(1),
  );

/**
 * Express `trust proxy`. Only `false` or a hop count is accepted: `true`
 * would trust any X-Forwarded-For value and let clients spoof their IP to
 * evade per-IP rate limits.
 */
const trustProxy = z
  .string()
  .regex(/^(false|\d+)$/, 'must be "false" or a number of proxy hops')
  .transform((value) => (value === 'false' ? false : Number(value)));

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

    DATABASE_URL: postgresUrl,

    AUTH_ISSUER: httpsUrl,
    AUTH_AUDIENCE: z.string().min(1),
    AUTH_JWKS_URI: httpsUrl,
    AUTH_ROLES_CLAIM: z.string().min(1),

    REPLAY_WINDOW_SECONDS: positiveInt.max(3600).default(300),

    CORS_ORIGINS: corsOrigins,
    TRUST_PROXY: trustProxy.default(false),
    REQUEST_TIMEOUT_MS: positiveInt.max(120_000).default(10_000),

    RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000),
    RATE_LIMIT_GLOBAL_PER_IP: positiveInt.default(300),
    RATE_LIMIT_AUTH_PER_IP: positiveInt.default(10),
    RATE_LIMIT_AUTH_PER_USER: positiveInt.default(5),
    RATE_LIMIT_CHAT_PER_IP: positiveInt.default(60),
    RATE_LIMIT_CHAT_PER_USER: positiveInt.default(20),
    RATE_LIMIT_SUBSCRIPTIONS_PER_IP: positiveInt.default(60),
    RATE_LIMIT_SUBSCRIPTIONS_PER_USER: positiveInt.default(30),
    RATE_LIMIT_ADMIN_PER_IP: positiveInt.default(60),
    RATE_LIMIT_ADMIN_PER_USER: positiveInt.default(30),

    LLM_MIN_LATENCY_MS: z.coerce.number().int().min(0).default(300),
    LLM_MAX_LATENCY_MS: z.coerce.number().int().min(0).default(1500),
    LLM_TIMEOUT_MS: positiveInt.default(5000),

    PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.2),
    RENEWAL_CRON: cronExpression.default('* * * * *'),
    RENEWAL_BATCH_SIZE: positiveInt.max(1000).default(50),
    NONCE_CLEANUP_CRON: cronExpression.default('*/5 * * * *'),
  })
  .refine((env) => env.LLM_MIN_LATENCY_MS <= env.LLM_MAX_LATENCY_MS, {
    path: ['LLM_MAX_LATENCY_MS'],
    message: 'must be >= LLM_MIN_LATENCY_MS',
  })
  .refine((env) => env.LLM_TIMEOUT_MS < env.REQUEST_TIMEOUT_MS, {
    path: ['LLM_TIMEOUT_MS'],
    message:
      'must be < REQUEST_TIMEOUT_MS so failures can be compensated before the request times out',
  });

type Env = z.infer<typeof EnvSchema>;

export interface RateLimitGroupConfig {
  perIp: number;
  perUser: number;
}

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  auth: {
    issuer: string;
    audience: string;
    jwksUri: string;
    rolesClaim: string;
    replayWindowSeconds: number;
  };
  http: {
    corsOrigins: readonly string[];
    trustProxy: false | number;
    requestTimeoutMs: number;
  };
  rateLimit: {
    windowMs: number;
    globalPerIp: number;
    auth: RateLimitGroupConfig;
    chat: RateLimitGroupConfig;
    subscriptions: RateLimitGroupConfig;
    admin: RateLimitGroupConfig;
  };
  llm: { minLatencyMs: number; maxLatencyMs: number; timeoutMs: number };
  billing: {
    paymentFailureRate: number;
    renewalCron: string;
    renewalBatchSize: number;
    nonceCleanupCron: string;
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Parses and validates configuration. Error messages name the offending
 * variable and rule but never echo its value, so secrets cannot leak into logs.
 */
export function loadConfig(source: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    auth: {
      issuer: env.AUTH_ISSUER,
      audience: env.AUTH_AUDIENCE,
      jwksUri: env.AUTH_JWKS_URI,
      rolesClaim: env.AUTH_ROLES_CLAIM,
      replayWindowSeconds: env.REPLAY_WINDOW_SECONDS,
    },
    http: {
      corsOrigins: env.CORS_ORIGINS,
      trustProxy: env.TRUST_PROXY,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    },
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      globalPerIp: env.RATE_LIMIT_GLOBAL_PER_IP,
      auth: { perIp: env.RATE_LIMIT_AUTH_PER_IP, perUser: env.RATE_LIMIT_AUTH_PER_USER },
      chat: { perIp: env.RATE_LIMIT_CHAT_PER_IP, perUser: env.RATE_LIMIT_CHAT_PER_USER },
      subscriptions: {
        perIp: env.RATE_LIMIT_SUBSCRIPTIONS_PER_IP,
        perUser: env.RATE_LIMIT_SUBSCRIPTIONS_PER_USER,
      },
      admin: { perIp: env.RATE_LIMIT_ADMIN_PER_IP, perUser: env.RATE_LIMIT_ADMIN_PER_USER },
    },
    llm: {
      minLatencyMs: env.LLM_MIN_LATENCY_MS,
      maxLatencyMs: env.LLM_MAX_LATENCY_MS,
      timeoutMs: env.LLM_TIMEOUT_MS,
    },
    billing: {
      paymentFailureRate: env.PAYMENT_FAILURE_RATE,
      renewalCron: env.RENEWAL_CRON,
      renewalBatchSize: env.RENEWAL_BATCH_SIZE,
      nonceCleanupCron: env.NONCE_CLEANUP_CRON,
    },
  };
}
