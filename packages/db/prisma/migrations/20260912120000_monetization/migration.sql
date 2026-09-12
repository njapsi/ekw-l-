-- CreateEnum
CREATE TYPE "MonetizationChannel" AS ENUM ('PLATFORM_MONETIZATION', 'SPONSORSHIP', 'AFFILIATE', 'DIGITAL_PRODUCT', 'SERVICE', 'MEMBERSHIP', 'SUBSCRIPTION', 'LEAD_GENERATION', 'CONSULTING', 'COURSE', 'BRAND_PARTNERSHIP');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('SUGGESTED', 'IN_PROGRESS', 'ACTIVE', 'COMPLETED', 'DISMISSED');

-- CreateTable
CREATE TABLE "business_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "updatedById" TEXT,
    "niche" TEXT,
    "audienceDescription" TEXT,
    "offerings" TEXT[],
    "goals" TEXT[],
    "audienceSizeNote" TEXT,
    "emailListSize" INTEGER,
    "hasWebsite" BOOLEAN NOT NULL DEFAULT false,
    "sellsProducts" BOOLEAN NOT NULL DEFAULT false,
    "doesSponsorships" BOOLEAN NOT NULL DEFAULT false,
    "doesAffiliates" BOOLEAN NOT NULL DEFAULT false,
    "doesConsulting" BOOLEAN NOT NULL DEFAULT false,
    "hasMembership" BOOLEAN NOT NULL DEFAULT false,
    "hasCourse" BOOLEAN NOT NULL DEFAULT false,
    "attestations" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monetization_opportunities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "channel" "MonetizationChannel" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'SUGGESTED',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "audienceFit" TEXT NOT NULL DEFAULT 'unknown',
    "difficulty" TEXT NOT NULL DEFAULT 'medium',
    "potential" TEXT NOT NULL DEFAULT 'Moderate',
    "potentialBasis" TEXT NOT NULL,
    "requiredActions" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "isEstimate" BOOLEAN NOT NULL DEFAULT true,
    "priorityScore" DOUBLE PRECISION,
    "sourceAgentRunId" TEXT,
    "dismissedReason" TEXT,
    "completedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monetization_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "channel" "MonetizationChannel" NOT NULL,
    "source" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revenue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_profiles_organizationId_key" ON "business_profiles"("organizationId");

-- CreateIndex
CREATE INDEX "monetization_opportunities_organizationId_status_idx" ON "monetization_opportunities"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "monetization_opportunities_organizationId_channel_key" ON "monetization_opportunities"("organizationId", "channel");

-- CreateIndex
CREATE INDEX "revenue_entries_organizationId_periodStart_idx" ON "revenue_entries"("organizationId", "periodStart");

-- CreateIndex
CREATE INDEX "revenue_entries_organizationId_channel_idx" ON "revenue_entries"("organizationId", "channel");

-- AddForeignKey
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monetization_opportunities" ADD CONSTRAINT "monetization_opportunities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

