# MASTER PROMPT — Secure AI Chat & Subscription Backend

You are a senior backend engineer building a production-grade, security-first backend for a timed technical assessment. The hard deadline is in ~5 hours. Work phase by phase (see "Execution Plan"). After each phase run `npm run check` (typecheck + lint + tests), fix all failures, commit with a conventional commit message, then STOP and give me a short summary.

Do not ask unnecessary questions. When something is ambiguous, choose the most defensible option, implement it, and record it in the README "Assumptions" or "Decision Log" section. Never silently skip a requirement. If something cannot be done, write it in README "Known Limitations".

---

## 1. Non-negotiable rules

- TypeScript `strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noImplicitOverride`. No `any`, no `@ts-ignore`, no non-null assertions unless justified in a comment.
- No custom authentication. Identity comes only from the external OIDC provider (Auth0).
- No auth bypass of any kind. No `if (NODE_ENV === 'test') skipAuth`, no debug routes, no hardcoded tokens. Tests must use a mocked identity provider (locally generated RSA keys + local JWKS) running through the real verification code.
- The domain layer must not import Express, Prisma, pino, or any framework. Enforce this with ESLint `no-restricted-imports` overrides scoped to `src/modules/*/domain/**`.
- Never pass `req.body` directly to Prisma. Always do validated DTO → explicit mapping → domain.
- Money is stored as integer cents. All dates are stored in UTC.
- Every endpoint is authenticated except `GET /health` (see Decision D-09).
- Secrets come only from environment variables, validated at startup with Zod. Fail fast if invalid. Commit `.env.example`, never `.env`.

---

## 2. Tech stack (fixed — do not substitute)

Node 22 LTS, TypeScript, Express 5, PostgreSQL 16 (docker-compose), Prisma (schema + migrations), Zod, `jose`, `helmet`, `cors`, `express-rate-limit`, `xss` (or `sanitize-html` configured with zero allowed tags), `pino` + `pino-http`, `node-cron`, Vitest + Supertest, ESLint (typescript-eslint `strict-type-checked`) + Prettier, GitHub Actions CI.

No LangChain or agent frameworks: the LLM is mocked by requirement. Expose an `LLMProvider` port so a real provider can be plugged in later.

---

## 3. Folder structure (Clean Architecture / DDD)

```
src/
  modules/
    chat/
      domain/
        entities/        ChatMessage.ts, QuotaSource.ts
        services/        QuotaService.ts, ChatService.ts
        policies/        ChatPolicy.ts
        ports/           LLMProvider.ts, ChatRepository.ts, QuotaRepository.ts, Clock.ts
        errors.ts        typed domain errors
      repositories/      PrismaChatRepository.ts, PrismaQuotaRepository.ts
      infrastructure/    MockLLMProvider.ts
      controllers/       chat.controller.ts, chat.routes.ts, chat.schemas.ts
    subscriptions/
      domain/
        entities/        Subscription.ts (aggregate with lifecycle methods), Tier.ts, BillingCycle.ts
        services/        SubscriptionService.ts, RenewalService.ts
        policies/        SubscriptionPolicy.ts
        ports/           SubscriptionRepository.ts, PaymentGateway.ts
        errors.ts
      repositories/      PrismaSubscriptionRepository.ts
      infrastructure/    MockPaymentGateway.ts, renewal.job.ts
      controllers/       subscription.controller.ts, subscription.routes.ts, subscription.schemas.ts
    admin/               metrics + system-wide read endpoints (controllers only; reuses module services)
  shared/
    auth/                jwtVerifier.ts, authenticate.middleware.ts, replayProtection.middleware.ts, requireRole.ts, Actor.ts
    http/                app.ts (express factory), errorHandler.ts, requestId.ts, timeout.ts, contentType.ts, validate.ts, rateLimiters.ts, security.ts
    config/              env.ts (Zod-validated)
    logging/             logger.ts
    db/                  prisma.ts
    errors/              AppError.ts, errorCodes.ts
  container.ts           manual dependency injection / composition root
  server.ts              entrypoint (listen + cron + graceful shutdown)
prisma/
  schema.prisma
  migrations/
  seed.ts
tests/
  unit/
  integration/
  helpers/               mockIdp.ts (keypair + JWKS + token factory), signedRequest.ts, testApp.ts
.github/workflows/ci.yml
docker-compose.yml       postgres (dev) + postgres-test
```

`app.ts` exports `createApp(deps)` so tests can build the app with a mock JWKS, a mock payment gateway, and a fake clock, all injected rather than bypassed.

---

## 4. Data model (Prisma)

- **User**: `id` (uuid), `authSub` (unique; from token `sub`), `email`, `role` (`USER`|`ADMIN`; mirrored from token claim), `createdAt`, `updatedAt`. Provisioned just-in-time on first authenticated request (upsert by `authSub`).
- **MonthlyFreeUsage**: `userId`, `period` (string `YYYY-MM`, UTC), `used` (int). Unique on `(userId, period)`. The monthly reset is automatic: a new period means a new row starting at 0. No cron needed (Decision D-03).
- **Subscription**: `id`, `userId`, `tier` (`BASIC`|`PRO`|`ENTERPRISE`), `billingCycle` (`MONTHLY`|`YEARLY`), `maxMessages` (int, nullable; null = unlimited), `usedMessages` (int), `priceCents`, `currency`, `startDate`, `endDate`, `renewalDate` (nullable when autoRenew false), `autoRenew` (bool), `status` (`ACTIVE`|`INACTIVE`), `inactiveReason` (nullable: `PAYMENT_FAILED`|`EXPIRED`|`CANCELLED`), `cancelledAt` (nullable), `createdAt`, `updatedAt`, `version` (int, optimistic concurrency).
- **PaymentAttempt**: `id`, `subscriptionId`, `amountCents`, `status` (`SUCCEEDED`|`FAILED`), `kind` (`INITIAL`|`RENEWAL`), `failureReason`, `createdAt`. Append-only history.
- **ChatMessage**: `id`, `userId`, `question`, `answer` (nullable until completed), `status` (`PENDING`|`COMPLETED`|`FAILED`), `promptTokens`, `completionTokens`, `totalTokens`, `model`, `quotaSource` (`FREE`|`SUBSCRIPTION`), `subscriptionId` (nullable), `requestId`, `latencyMs`, `createdAt`, `completedAt`.
- **UsedNonce**: `userSub`, `nonce`, `expiresAt`. PK `(userSub, nonce)`. Expired rows are cleaned by cron.

Add indexes for every foreign key, for `(userId, createdAt)` on ChatMessage, and for `(status, renewalDate)` on Subscription.

---

## 5. Domain rules

### 5.1 Tier catalogue (constants in the domain)

| Tier | maxMessages per billing cycle | Monthly price | Yearly price |
|---|---|---|---|
| BASIC | 10 | 999 cents | 9990 cents |
| PRO | 100 | 2999 cents | 29990 cents |
| ENTERPRISE | unlimited (null) | 9999 cents | 99990 cents |

Assumption A-04: quota is per billing cycle and resets on renewal. Yearly bundles receive `maxMessages × 12`. Document this.

### 5.2 Quota deduction algorithm (the core; must be atomic and concurrency-safe)

Use a **reserve → generate → finalize** pattern (Decision D-02) so database locks are never held during the simulated LLM latency.

**Transaction 1 (reserve)**, using a Prisma interactive transaction (READ COMMITTED + explicit row locks):
1. `SELECT ... FROM "User" WHERE id = $1 FOR UPDATE` to serialize all quota operations for one user.
2. Upsert the `MonthlyFreeUsage` row for the current UTC period. If `used < 3`, increment it; source = FREE.
3. Otherwise, select eligible subscriptions: `status = ACTIVE AND startDate <= now < endDate AND (maxMessages IS NULL OR usedMessages < maxMessages)`, `ORDER BY startDate DESC, createdAt DESC`, `FOR UPDATE`. Take the first and increment `usedMessages`; source = SUBSCRIPTION. This is the interpretation of "bundle with the latest remaining quota" (Assumption A-01: newest active bundle that still has remaining quota).
4. If nothing is eligible, throw `QuotaExceededError` (typed; includes `freeUsed`, `freeLimit`, `resetsAt` = 1st of next month 00:00 UTC, `activeBundles: 0`).
5. Insert a `ChatMessage` with `status = PENDING`, `quotaSource`, and `subscriptionId`.

**Generate (outside the transaction):** call `LLMProvider.complete(question)`. The mock waits a random 300–1500 ms (configurable via env; 0 in tests), returns a deterministic-looking answer, and estimates tokens (≈ chars/4).

**Transaction 2 (finalize):** update the message to COMPLETED with answer, tokens, and latency.

**Compensation:** if the LLM call fails or times out, mark the message FAILED and refund the exact unit to the same source (decrement free usage or the specific subscription) in a transaction. Unit test this.

Free quota is always consumed before paid bundles (Assumption A-02).

### 5.3 Subscription lifecycle (pure methods on the `Subscription` aggregate; inject a `Clock`)

- `create(tier, cycle, autoRenew, now)`: computes `startDate = now`, `endDate = now + 1 month/year`, `renewalDate = autoRenew ? endDate : null`. An initial payment is attempted via `PaymentGateway`. On failure, persist the subscription as INACTIVE with `PAYMENT_FAILED` (history preserved) and return a 402 `PAYMENT_FAILED` error.
- `setAutoRenew(bool)`: not allowed on INACTIVE or cancelled subscriptions.
- `cancel(now)`: sets `cancelledAt`, `autoRenew = false`, `renewalDate = null`. It **stays ACTIVE until `endDate`** (ends the current cycle, prevents future renewal) and never deletes usage history. Idempotent: cancelling twice returns a domain error `ALREADY_CANCELLED`.
- `renew(paymentResult, now)`: on success, the new period starts at the old `endDate`, `usedMessages = 0`, and a new `renewalDate` is set. On failure, `status = INACTIVE`, `inactiveReason = PAYMENT_FAILED`.
- `expire(now)`: when `now >= endDate` and the subscription won't renew, set INACTIVE with reason EXPIRED or CANCELLED.

**Renewal job** (`node-cron`, schedule from env, default every minute): select due subscriptions with `FOR UPDATE SKIP LOCKED` in batches, so multiple instances never double-charge (Decision D-06). Process each in its own transaction, record a `PaymentAttempt`, and log the outcome. Also expose admin endpoint `POST /admin/billing/run-renewals` to trigger it manually.

**MockPaymentGateway:** fails randomly with probability `PAYMENT_FAILURE_RATE` (env, default 0.2). The random source is injected so tests are deterministic.

### 5.4 Policies (domain-level authorization)

`ChatPolicy` and `SubscriptionPolicy` expose pure functions such as `canView(actor, resource)`, `canModify(actor, resource)`, and `canViewSystemMetrics(actor)`. A user may access only resources where `resource.userId === actor.userId`; an admin may access everything. Services call policies before every read or write, so authorization holds even if a controller check is forgotten (defense in depth, Decision D-07). Controllers additionally use `requireRole('ADMIN')` for admin routes.

On access to another user's resource, return **404, not 403**, to avoid leaking resource existence (Decision D-08).

---

## 6. Authentication and token security

**Verification (`jwtVerifier.ts`):**
- `jose.jwtVerify` with `createRemoteJWKSet(AUTH_JWKS_URI)` in production. The JWKS source is injectable so tests use `createLocalJWKSet`.
- Enforce `issuer = AUTH_ISSUER`, `audience = AUTH_AUDIENCE`, `algorithms: ['RS256']`, expiry, `nbf`, max 5s clock tolerance, and require a `sub` claim.
- Roles are read from the custom claim `AUTH_ROLES_CLAIM` (e.g. `https://ggi-api/roles`). Default role is `USER`.
- Only `Authorization: Bearer <token>` is accepted. Reject tokens in query strings.

**Additional mechanism (the token alone is not enough): timestamp + nonce replay protection** (Decision D-04):
- Every authenticated request must send `X-Request-Timestamp` (unix ms) and `X-Request-Nonce` (UUID v4).
- Reject if the timestamp is more than ±300 s from server time (`REQUEST_EXPIRED`).
- Reject if `(sub, nonce)` was already used (`REPLAY_DETECTED`). Insert into `UsedNonce` using the unique constraint for atomicity, with `expiresAt = timestamp + window`.
- Nonces are bound to the token subject, so a captured token cannot be replayed even within its lifetime.
- **Bonus (if time permits):** an HMAC-SHA256 request signature `X-Request-Signature` over `method + path + timestamp + nonce + sha256(body)`, keyed by a per-client secret. Mark this optional in the README.

**Auth endpoints:** `GET /auth/me` (returns the provisioned user profile and roles) and `POST /auth/session/verify` (validates the token plus replay headers and returns token metadata). These form the "authentication endpoints" rate-limit group (Assumption A-06: login itself happens at Auth0, so the backend's auth endpoints are its token/session endpoints).

---

## 7. HTTP security middleware (order matters)

1. `requestId`: accept a valid UUID `X-Request-Id` or generate one; echo it in the response.
2. `pino-http` logger: log requestId, userId (once known), method, route, status, and responseTimeMs. Redact `authorization`, `cookie`, and `x-request-signature`.
3. `helmet`: API-appropriate config, including CSP `default-src 'none'; frame-ancestors 'none'`, HSTS, `noSniff`, `referrerPolicy: no-referrer`. Disable `x-powered-by`.
4. `cors`: explicit allowlist from `CORS_ORIGINS` (comma-separated). No wildcard. Allowed methods and headers are explicit. Credentials are false.
5. Per-IP global rate limiter.
6. `timeout`: global `REQUEST_TIMEOUT_MS` (default 10000). Respond 503 `REQUEST_TIMEOUT` and make sure no double response is sent.
7. Strict content-type: POST/PUT/PATCH require exactly `application/json`, otherwise 415 `UNSUPPORTED_MEDIA_TYPE`.
8. `express.json({ limit: '10kb', strict: true })`. Oversized bodies get 413 `PAYLOAD_TOO_LARGE`, and malformed JSON gets 400 `MALFORMED_JSON`.
9. Routes: `authenticate` → `replayProtection` → per-user limiter → `validate(zodSchema)` → controller.
10. 404 handler, then the centralized error handler.

**Rate limit groups** (values from env; in-memory store, with Redis noted as the production upgrade in Known Limitations):

| Group | Per IP | Per user |
|---|---|---|
| auth `/auth/*` | 10/min | 5/min |
| chat `/chat/*` | 60/min | 20/min |
| subscriptions `/subscriptions/*` | 60/min | 30/min |
| global fallback | 300/min | — |

Return 429 `RATE_LIMITED` with a `Retry-After` header and standard `RateLimit-*` headers. Set `trust proxy` from env (`TRUST_PROXY`).

**Validation and sanitization:**
- Every body, query, and params object has a Zod `.strict()` schema; unknown fields get 400 `VALIDATION_ERROR` with field paths.
- Chat question: trimmed string, 1–2000 characters, control characters stripped, HTML stripped via the sanitizer.
- IDs are validated as UUIDs, and pagination is capped (`limit` max 50).
- Injection: Prisma's parameterized queries only. Raw SQL must use `$queryRaw` tagged templates, never `$queryRawUnsafe`.
- Mass assignment: DTO fields such as `price`, `maxMessages`, `status`, `userId`, and `role` are never accepted from clients; they are derived from the tier catalogue and the authenticated actor.

---

## 8. Error handling

Single error format everywhere:
```json
{ "error": { "code": "QUOTA_EXCEEDED", "message": "Human readable", "details": {}, "requestId": "..." } }
```
Define the error codes as a TypeScript union / `const` object. Domain errors map to HTTP status codes in exactly one place (`errorHandler.ts`). Unknown errors return 500 `INTERNAL_ERROR` with no stack trace or internals, and the full error is logged server-side.

Codes: `UNAUTHENTICATED` 401, `INVALID_TOKEN` 401, `REQUEST_EXPIRED` 401, `REPLAY_DETECTED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `VALIDATION_ERROR` 400, `MALFORMED_JSON` 400, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, `QUOTA_EXCEEDED` 402, `PAYMENT_FAILED` 402, `ALREADY_CANCELLED` 409, `INVALID_STATE_TRANSITION` 409, `RATE_LIMITED` 429, `REQUEST_TIMEOUT` 503, `INTERNAL_ERROR` 500.

---

## 9. API endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | /health | public (see D-09) | `{status:"ok"}` plus DB ping only; no versions, no internals |
| GET | /auth/me | user | Current profile and roles |
| POST | /auth/session/verify | user | Token + replay check diagnostics |
| POST | /chat/messages | user | Ask a question (quota enforced) |
| GET | /chat/messages | user | Own history, paginated |
| GET | /chat/messages/:id | user | Own message (policy enforced) |
| GET | /chat/usage | user | Free used/remaining, reset date, per-bundle remaining |
| POST | /subscriptions | user | Create bundle `{tier, billingCycle, autoRenew}` only |
| GET | /subscriptions | user | Own subscriptions |
| GET | /subscriptions/:id | user | Own subscription |
| PATCH | /subscriptions/:id/auto-renew | user | `{autoRenew: boolean}` only |
| POST | /subscriptions/:id/cancel | user | Cancel (end of cycle) |
| GET | /metrics | admin | Messages this month by source, tokens, active subscriptions by tier, payment success/failure counts, renewal stats |
| GET | /admin/users/:id/chats | admin | System-wide access |
| GET | /admin/subscriptions | admin | All subscriptions, filterable |
| POST | /admin/billing/run-renewals | admin | Trigger the renewal job |

---

## 10. Testing (Vitest + Supertest, real Postgres test DB)

**Mock IdP (`tests/helpers/mockIdp.ts`):** generate an RS256 keypair at test start, expose it as a local JWKS injected into `createApp`, and provide `issueToken({sub, roles, aud, iss, exp})`. Real `jwtVerifier` code runs. Include a helper that adds valid timestamp + nonce headers.

**Unit tests (no DB; fake clock and fake repositories):**
- Quota: free used first; 4th message goes to a bundle; newest-eligible-bundle selection; exhausted bundle skipped; enterprise unlimited; expired and inactive bundles ignored; no quota → `QuotaExceededError` with correct `resetsAt`; month rollover resets free quota; refund on LLM failure.
- Subscription lifecycle: create with each tier/cycle (dates, price, maxMessages); yearly ×12 quota; cancel keeps ACTIVE until endDate; double cancel errors; renew success resets usage and shifts the period; renew failure → INACTIVE/PAYMENT_FAILED; no renewal after cancel; expire transitions.
- Policies: owner allowed, other user denied, admin allowed.
- Replay protection: stale timestamp, future timestamp, and reused nonce are rejected.

**Integration tests:**
- Auth: missing token 401; wrong issuer, wrong audience, expired, bad signature, and `alg: none` all 401; valid token without nonce headers 401; reused nonce 401; valid request 200.
- RBAC: a user cannot read another user's message (404); a user gets 403 on `/metrics`; admin 200.
- **Concurrency (headline test):** a fresh user fires 10 parallel `POST /chat/messages`. Exactly 3 succeed and 7 get `QUOTA_EXCEEDED`. With a BASIC bundle and 20 parallel requests, exactly 13 succeed. Assert DB counters match the number of successes.
- Rate limiting: exceed the chat per-user limit → 429 with `Retry-After`; the auth group has a stricter limit than chat.
- Security middleware: helmet headers present; `x-powered-by` absent; disallowed CORS origin rejected; `text/plain` body → 415; 11 KB body → 413; unknown field → 400; `<script>` in a question is stored sanitized; slow handler → 503 timeout.
- Subscriptions: create → use quota → cancel → still usable until endDate → renewal job skips it. Forced payment failure → INACTIVE. Mass-assignment attempt (`price: 0`, `status`) → 400.

Scripts: `test`, `test:unit`, `test:integration`, `test:coverage`, and `check` (typecheck + lint + format check + tests).

---

## 11. Tooling and DevEx

- `docker-compose.yml` with `db` and `db-test`; `npm run db:migrate`, `db:seed` (creates demo data), `dev` (tsx watch), `build`, `start`.
- `.env.example` documenting every variable with safe defaults.
- ESLint: typescript-eslint `strict-type-checked` + `stylistic-type-checked`, `no-floating-promises`, `no-misused-promises`, and layer-boundary `no-restricted-imports` for domain folders. Prettier integrated with `eslint-config-prettier`.
- `.github/workflows/ci.yml`: Postgres service, install, migrate, lint, typecheck, and tests on push.
- Graceful shutdown on SIGTERM: stop cron, close the server, disconnect Prisma.

---

## 12. README.md (the evaluators read this first; make it excellent)

Write it progressively; do not leave it all to the end. Sections:

1. **Overview**: what the system does in 5 lines, plus a mermaid architecture diagram (layers + request flow).
2. **Quick start**: prerequisites, `docker compose up -d`, env setup, migrate, seed, run, and run tests. Copy-pasteable commands.
3. **Auth0 setup**: tenant, API audience, Username-Password and Google connections, roles Action (include the Action code snippet), and how to get a test token.
4. **How to call the API**: an example curl with token + timestamp + nonce headers, and a tiny Node script `scripts/signed-request.ts` that generates them.
5. **Architecture decisions**: folder layout, dependency rule, ports/adapters, composition root, why Express/Prisma/Zod/jose.
6. **Security model**: threat-by-threat table (Threat → Mitigation → Where in code → Test that proves it), covering token forgery, token theft/replay, privilege escalation, IDOR, mass assignment, XSS, SQL injection, brute force/DoS, oversized payloads, slowloris/long requests, info leakage in errors, CORS abuse, secrets.
7. **Quota and concurrency design**: the reserve → generate → finalize sequence (mermaid sequence diagram), locking strategy, why locks aren't held during LLM latency, the refund path.
8. **Subscription lifecycle**: mermaid state diagram (ACTIVE → cancelled-but-active → INACTIVE, PAYMENT_FAILED, EXPIRED); renewal job with SKIP LOCKED.
9. **Decision Log** (ADR-style table: ID, Decision, Alternatives considered, Rationale). Include at least:
   - D-01 Express 5 over Fastify/NestJS (familiarity, explicit middleware ordering; NestJS would blur the DDD boundaries the task asks to show).
   - D-02 Reserve → generate → finalize with compensation.
   - D-03 Period-keyed free usage rows instead of a reset cron.
   - D-04 Timestamp + nonce bound to `sub` as the extra token mechanism (vs DPoP: requires client key management; vs mTLS: infra-heavy).
   - D-05 Prisma + raw `FOR UPDATE` only where locking matters.
   - D-06 `FOR UPDATE SKIP LOCKED` renewal batching for multi-instance safety.
   - D-07 Dual-layer authorization (controller + domain policy).
   - D-08 404 instead of 403 for others' resources.
   - D-09 `/health` is the single unauthenticated endpoint: load balancers and orchestrators cannot present JWTs. It returns no data, is IP rate-limited, and `/metrics` is admin-only.
   - D-10 No LangChain/agent framework: the LLM is mocked by spec; the `LLMProvider` port keeps it swappable.
   - D-11 Integer cents, UTC everywhere.
10. **Assumptions**: A-01 "latest remaining quota" = newest active bundle with remaining quota; A-02 free before paid; A-03 calendar month in UTC; A-04 quota per billing cycle, yearly = ×12; A-05 a failed initial payment creates an INACTIVE record for history; A-06 auth endpoints = token/session endpoints because login occurs at Auth0; A-07 roles come from the token claim (source of truth) and are mirrored to the DB; A-08 cancelled subscriptions remain usable until endDate; A-09 tier prices are illustrative.
11. **Evaluation / Requirements Traceability Matrix**: a table mapping every requirement in the assessment PDF → implementation file(s) → test file(s) → status (✅ / ⚠️ partial). This is the "evals" section and must be complete and honest.
12. **Testing strategy**: what is unit vs integration, how the IdP is mocked without bypassing auth, how to run, and coverage summary.
13. **Observability**: log format example, metrics response example, health check.
14. **Known limitations and production next steps**: Redis-backed rate limits and nonce store, real payment provider + webhooks, outbox/event bus, OpenTelemetry tracing, secret manager, key rotation, HMAC signing if not completed.
15. **Use of AI tools**: an honest note that Claude Code assisted, and that the author reviewed and understands the design.

---

## 13. Execution plan (stop after each phase)

- **Phase 0 — Scaffold (≈30 min):** package.json, tsconfig strict, ESLint/Prettier, Vitest, docker-compose, env.ts, Prisma schema + first migration, app factory, health endpoint, error handler, logger, README skeleton with all section headings, CI workflow.
- **Phase 1 — Security foundation (≈45 min):** requestId, helmet, CORS, size limit, content-type, timeout, rate limiters, Zod validate middleware, sanitizer, JWT verifier, replay protection, requireRole, JIT user provisioning, `/auth/*` routes, mock IdP test helper + auth/security integration tests.
- **Phase 2 — Chat + quota (≈60 min):** entities, QuotaService, ChatPolicy, MockLLMProvider, repositories with locking, reserve/finalize/refund, endpoints, unit tests, and the concurrency integration test.
- **Phase 3 — Subscriptions (≈60 min):** aggregate + lifecycle, tier catalogue, MockPaymentGateway, services, policy, endpoints, renewal cron with SKIP LOCKED, admin trigger, unit + integration tests.
- **Phase 4 — Admin + observability (≈20 min):** `/metrics`, admin endpoints, log enrichment with userId, seed script.
- **Phase 5 — Docs and polish (≈30 min):** complete README (all diagrams, Decision Log, Assumptions, Traceability Matrix filled from actual code and tests), `scripts/signed-request.ts`, final `npm run check` green, remove dead code, and verify no secrets are committed.

At the end, print a checklist of every requirement from the assessment with ✅/⚠️ and the evidence location.
