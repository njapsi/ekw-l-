-- Phase 6 — YouTube Growth Agent.
-- Additive: four new enums, three new tables. No DROP, no change to any existing table.

-- CreateEnum
CREATE TYPE "YouTubeOpportunityType" AS ENUM ('CONTENT_EXPANSION', 'CONTENT_GAP', 'HIGH_PERFORMER_FOLLOWUP', 'UNDEREXPLOITED_TOPIC', 'FORMAT_OPPORTUNITY', 'AUDIENCE_OPPORTUNITY', 'TRAFFIC_SOURCE_OPPORTUNITY', 'SERIES_OPPORTUNITY', 'SHORTS_OPPORTUNITY', 'LONG_FORM_OPPORTUNITY');

-- CreateEnum
CREATE TYPE "YouTubeExperimentStatus" AS ENUM ('PLANNED', 'RUNNING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "YouTubeExperimentDirection" AS ENUM ('INCREASE', 'DECREASE');

-- CreateEnum
CREATE TYPE "YouTubeExperimentConclusion" AS ENUM ('SUPPORTED', 'NOT_SUPPORTED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "YouTubeCalendarStatus" AS ENUM ('IDEA', 'PLANNED', 'BRIEFED', 'SCRIPTED', 'DRAFT', 'READY', 'APPROVAL_REQUIRED', 'SCHEDULED', 'PUBLISHED', 'ANALYZING', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "youtube_opportunities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "youTubeChannelId" TEXT NOT NULL,
    "type" "YouTubeOpportunityType" NOT NULL,
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

    CONSTRAINT "youtube_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_experiments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "youTubeChannelId" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "variable" TEXT NOT NULL,
    "baseline" JSONB NOT NULL,
    "experimentNote" TEXT NOT NULL,
    "successMetric" TEXT NOT NULL,
    "expectedDirection" "YouTubeExperimentDirection" NOT NULL,
    "status" "YouTubeExperimentStatus" NOT NULL DEFAULT 'PLANNED',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "result" JSONB,
    "conclusion" "YouTubeExperimentConclusion",
    "confidence" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "youtube_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_calendar_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "youTubeChannelId" TEXT NOT NULL,
    "contentIdeaId" TEXT,
    "scheduledDate" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "status" "YouTubeCalendarStatus" NOT NULL DEFAULT 'IDEA',
    "rationale" TEXT NOT NULL,
    "sourceOpportunityId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "youtube_calendar_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "youtube_opportunities_organizationId_status_priorityScore_idx" ON "youtube_opportunities"("organizationId", "status", "priorityScore");

-- CreateIndex
CREATE INDEX "youtube_opportunities_youTubeChannelId_idx" ON "youtube_opportunities"("youTubeChannelId");

-- CreateIndex
CREATE INDEX "youtube_experiments_organizationId_status_idx" ON "youtube_experiments"("organizationId", "status");

-- CreateIndex
CREATE INDEX "youtube_experiments_youTubeChannelId_idx" ON "youtube_experiments"("youTubeChannelId");

-- CreateIndex
CREATE INDEX "youtube_calendar_entries_organizationId_scheduledDate_idx" ON "youtube_calendar_entries"("organizationId", "scheduledDate");

-- CreateIndex
CREATE INDEX "youtube_calendar_entries_youTubeChannelId_idx" ON "youtube_calendar_entries"("youTubeChannelId");

-- AddForeignKey
ALTER TABLE "youtube_opportunities" ADD CONSTRAINT "youtube_opportunities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_opportunities" ADD CONSTRAINT "youtube_opportunities_youTubeChannelId_fkey" FOREIGN KEY ("youTubeChannelId") REFERENCES "youtube_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_experiments" ADD CONSTRAINT "youtube_experiments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_experiments" ADD CONSTRAINT "youtube_experiments_youTubeChannelId_fkey" FOREIGN KEY ("youTubeChannelId") REFERENCES "youtube_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_calendar_entries" ADD CONSTRAINT "youtube_calendar_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_calendar_entries" ADD CONSTRAINT "youtube_calendar_entries_youTubeChannelId_fkey" FOREIGN KEY ("youTubeChannelId") REFERENCES "youtube_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_calendar_entries" ADD CONSTRAINT "youtube_calendar_entries_contentIdeaId_fkey" FOREIGN KEY ("contentIdeaId") REFERENCES "content_ideas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
