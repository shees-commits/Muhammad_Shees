-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('BASIC', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "InactiveReason" AS ENUM ('PAYMENT_FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('INITIAL', 'RENEWAL');

-- CreateEnum
CREATE TYPE "ChatMessageStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "QuotaSource" AS ENUM ('FREE', 'SUBSCRIPTION');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "authSub" TEXT NOT NULL,
    "email" TEXT,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyFreeUsage" (
    "userId" UUID NOT NULL,
    "period" CHAR(7) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MonthlyFreeUsage_pkey" PRIMARY KEY ("userId","period")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tier" "Tier" NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "maxMessages" INTEGER,
    "usedMessages" INTEGER NOT NULL DEFAULT 0,
    "priceCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "startDate" TIMESTAMPTZ(3) NOT NULL,
    "endDate" TIMESTAMPTZ(3) NOT NULL,
    "renewalDate" TIMESTAMPTZ(3),
    "autoRenew" BOOLEAN NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "inactiveReason" "InactiveReason",
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "status" "ChatMessageStatus" NOT NULL DEFAULT 'PENDING',
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "model" TEXT,
    "quotaSource" "QuotaSource" NOT NULL,
    "subscriptionId" UUID,
    "requestId" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsedNonce" (
    "userSub" TEXT NOT NULL,
    "nonce" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UsedNonce_pkey" PRIMARY KEY ("userSub","nonce")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_authSub_key" ON "User"("authSub");

-- CreateIndex
CREATE INDEX "Subscription_userId_status_idx" ON "Subscription"("userId", "status");

-- CreateIndex
CREATE INDEX "Subscription_status_renewalDate_idx" ON "Subscription"("status", "renewalDate");

-- CreateIndex
CREATE INDEX "PaymentAttempt_subscriptionId_idx" ON "PaymentAttempt"("subscriptionId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_createdAt_idx" ON "PaymentAttempt"("createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_userId_createdAt_idx" ON "ChatMessage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_subscriptionId_idx" ON "ChatMessage"("subscriptionId");

-- CreateIndex
CREATE INDEX "ChatMessage_createdAt_idx" ON "ChatMessage"("createdAt");

-- CreateIndex
CREATE INDEX "UsedNonce_expiresAt_idx" ON "UsedNonce"("expiresAt");

-- AddForeignKey
ALTER TABLE "MonthlyFreeUsage" ADD CONSTRAINT "MonthlyFreeUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity constraints Prisma's schema language cannot express.
-- These are the last line of defence for quota/money invariants: even a buggy
-- code path cannot drive a counter negative or past its bundle limit.
-- ---------------------------------------------------------------------------
ALTER TABLE "MonthlyFreeUsage"
  ADD CONSTRAINT "MonthlyFreeUsage_used_non_negative" CHECK ("used" >= 0),
  ADD CONSTRAINT "MonthlyFreeUsage_period_format" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_used_non_negative" CHECK ("usedMessages" >= 0),
  ADD CONSTRAINT "Subscription_used_within_limit" CHECK ("maxMessages" IS NULL OR "usedMessages" <= "maxMessages"),
  ADD CONSTRAINT "Subscription_max_positive" CHECK ("maxMessages" IS NULL OR "maxMessages" > 0),
  ADD CONSTRAINT "Subscription_price_non_negative" CHECK ("priceCents" >= 0),
  ADD CONSTRAINT "Subscription_period_order" CHECK ("endDate" > "startDate"),
  ADD CONSTRAINT "Subscription_inactive_has_reason" CHECK (("status" = 'ACTIVE') = ("inactiveReason" IS NULL));

ALTER TABLE "PaymentAttempt"
  ADD CONSTRAINT "PaymentAttempt_amount_non_negative" CHECK ("amountCents" >= 0);

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_subscription_matches_source" CHECK (("quotaSource" = 'SUBSCRIPTION') = ("subscriptionId" IS NOT NULL)),
  ADD CONSTRAINT "ChatMessage_tokens_non_negative" CHECK (
    coalesce("promptTokens", 0) >= 0 AND coalesce("completionTokens", 0) >= 0 AND coalesce("totalTokens", 0) >= 0
  );
