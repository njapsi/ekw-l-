-- CreateEnum
CREATE TYPE "TikTokOpportunityType" AS ENUM ('CONTENT_EXPANSION', 'UNDEREXPLOITED_TOPIC', 'HIGH_PERFORMER_FOLLOWUP', 'SHORT_FORMAT_OPPORTUNITY', 'EXTENDED_FORMAT_OPPORTUNITY', 'AUDIENCE_OPPORTUNITY', 'TREND_OPPORTUNITY');

-- CreateEnum
CREATE TYPE "TikTokExperimentStatus" AS ENUM ('PLANNED', 'RUNNING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TikTokExperimentDirection" AS ENUM ('INCREASE', 'DECREASE');

-- CreateEnum
CREATE TYPE "TikTokExperimentConclusion" AS ENUM ('SUPPORTED', 'NOT_SUPPORTED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "TikTokContentPlanStatus" AS ENUM ('IDEA', 'PLANNED', 'BRIEFED', 'SCRIPTED', 'DRAFT', 'READY', 'APPROVAL_REQUIRED', 'SCHEDULED', 'PUBLISHED', 'ANALYZING', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "tiktok_opportunities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tikTokAccountId" TEXT NOT NULL,
    "type" "TikTokOpportunityType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'SUGGESTED',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "evidenceStrength" DOUBLE PRECISION NOT NULL,
    "historicalPerformance" DOUBLE PRECISION NOT NULL,
    "contentGap" DOUBLE PRECISION NOT NULL,
    "executionFeasibility" DOUBLE PRECISION NOT NULL,
    "priorityScore" DOUBLE PRECISION NOT NULL,
    "confidence" TEXT NOT NULL,
    "recommendedActions" TEXT[],
    "relatedVideoIds" TEXT[],
    "sourceAgentRunId" TEXT,
    "dismissedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tiktok_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiktok_experiments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tikTokAccountId" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "variable" TEXT NOT NULL,
    "baseline" JSONB NOT NULL,
    "experimentNote" TEXT NOT NULL,
    "successMetric" TEXT NOT NULL,
    "expectedDirection" "TikTokExperimentDirection" NOT NULL,
    "status" "TikTokExperimentStatus" NOT NULL DEFAULT 'PLANNED',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "result" JSONB,
    "conclusion" "TikTokExperimentConclusion",
    "confidence" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tiktok_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiktok_content_plans" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tikTokAccountId" TEXT NOT NULL,
    "contentIdeaId" TEXT,
    "scheduledDate" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" "TikTokContentPlanStatus" NOT NULL DEFAULT 'IDEA',
    "rationale" TEXT NOT NULL,
    "sourceOpportunityId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tiktok_content_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tiktok_opportunities_organizationId_status_priorityScore_idx" ON "tiktok_opportunities"("organizationId", "status", "priorityScore");

-- CreateIndex
CREATE INDEX "tiktok_opportunities_tikTokAccountId_idx" ON "tiktok_opportunities"("tikTokAccountId");

-- CreateIndex
CREATE INDEX "tiktok_experiments_organizationId_status_idx" ON "tiktok_experiments"("organizationId", "status");

-- CreateIndex
CREATE INDEX "tiktok_experiments_tikTokAccountId_idx" ON "tiktok_experiments"("tikTokAccountId");

-- CreateIndex
CREATE INDEX "tiktok_content_plans_organizationId_scheduledDate_idx" ON "tiktok_content_plans"("organizationId", "scheduledDate");

-- CreateIndex
CREATE INDEX "tiktok_content_plans_tikTokAccountId_idx" ON "tiktok_content_plans"("tikTokAccountId");

-- AddForeignKey
ALTER TABLE "tiktok_opportunities" ADD CONSTRAINT "tiktok_opportunities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_opportunities" ADD CONSTRAINT "tiktok_opportunities_tikTokAccountId_fkey" FOREIGN KEY ("tikTokAccountId") REFERENCES "tiktok_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_experiments" ADD CONSTRAINT "tiktok_experiments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_experiments" ADD CONSTRAINT "tiktok_experiments_tikTokAccountId_fkey" FOREIGN KEY ("tikTokAccountId") REFERENCES "tiktok_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_content_plans" ADD CONSTRAINT "tiktok_content_plans_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_content_plans" ADD CONSTRAINT "tiktok_content_plans_tikTokAccountId_fkey" FOREIGN KEY ("tikTokAccountId") REFERENCES "tiktok_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_content_plans" ADD CONSTRAINT "tiktok_content_plans_contentIdeaId_fkey" FOREIGN KEY ("contentIdeaId") REFERENCES "content_ideas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

