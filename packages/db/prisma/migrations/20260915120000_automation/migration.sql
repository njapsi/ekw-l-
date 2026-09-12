-- CreateEnum
CREATE TYPE "AutomationTaskType" AS ENUM ('YOUTUBE_ANALYSIS', 'TIKTOK_ANALYSIS', 'WEBSITE_CRAWL', 'SEO_ISSUE_ALERT', 'MONETIZATION_SCAN', 'GROWTH_REPORT', 'CONTENT_OPPORTUNITY');

-- CreateEnum
CREATE TYPE "AutomationCadence" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AutomationStatus" AS ENUM ('ACTIVE', 'PAUSED', 'FAILING', 'DISABLED');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'RETRY_SCHEDULED', 'CANCELLED');

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "taskType" "AutomationTaskType" NOT NULL,
    "name" TEXT NOT NULL,
    "cadence" "AutomationCadence" NOT NULL,
    "cronExpression" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" "AutomationStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" "AutomationRunStatus",
    "nextRunAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "totalRuns" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "automationRuleId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "triggeredBy" TEXT NOT NULL DEFAULT 'schedule',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "output" JSONB,
    "error" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_rules_organizationId_status_idx" ON "automation_rules"("organizationId", "status");

-- CreateIndex
CREATE INDEX "automation_rules_status_nextRunAt_idx" ON "automation_rules"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "automation_runs_automationRuleId_createdAt_idx" ON "automation_runs"("automationRuleId", "createdAt");

-- CreateIndex
CREATE INDEX "automation_runs_organizationId_createdAt_idx" ON "automation_runs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "automation_runs_status_nextAttemptAt_idx" ON "automation_runs"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_automationRuleId_scheduledFor_key" ON "automation_runs"("automationRuleId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automationRuleId_fkey" FOREIGN KEY ("automationRuleId") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

