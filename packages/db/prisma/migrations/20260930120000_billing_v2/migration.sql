-- Phase 13: Billing, Usage, Entitlements & Enterprise Plans.
-- Purely additive: two new enums, two new tables. No DROP, no column
-- rewrite on any existing table. Hand-authored and reviewed by eye against
-- every prior migration's identical CreateEnum/CreateTable/CreateIndex/
-- AddForeignKey pattern — this sandbox has no live Postgres to run
-- `prisma migrate dev` against, the same disclosed limitation every phase
-- since Phase 24 has had for a hand-authored migration.

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('PURCHASE', 'GRANT', 'CONSUMPTION', 'REFUND', 'ADJUSTMENT', 'EXPIRATION');

-- CreateEnum
CREATE TYPE "EnterpriseContractStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "credit_transactions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "meter" "UsageMeter" NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "source" TEXT,
    "referenceId" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_contracts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "EnterpriseContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "contractStart" TIMESTAMP(3) NOT NULL,
    "contractEnd" TIMESTAMP(3),
    "seatLimit" INTEGER,
    "customEntitlements" JSONB NOT NULL,
    "billingTerms" TEXT,
    "supportLevel" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_transactions_organizationId_meter_createdAt_idx" ON "credit_transactions"("organizationId", "meter", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_contracts_organizationId_key" ON "enterprise_contracts"("organizationId");

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_contracts" ADD CONSTRAINT "enterprise_contracts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
