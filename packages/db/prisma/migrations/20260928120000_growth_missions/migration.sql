-- CreateEnum
CREATE TYPE "MissionStatus" AS ENUM ('DRAFT', 'PLANNING', 'AWAITING_APPROVAL', 'ACTIVE', 'PAUSED', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MissionAutonomyLevel" AS ENUM ('ADVISORY', 'ASSISTED', 'SUPERVISED', 'CONTROLLED');

-- CreateEnum
CREATE TYPE "MissionPlatform" AS ENUM ('YOUTUBE', 'TIKTOK', 'SEO', 'WORDPRESS', 'WEBSITE', 'CROSS_PLATFORM');

-- CreateEnum
CREATE TYPE "MissionMilestoneStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "MissionTaskStatus" AS ENUM ('PENDING', 'READY', 'RUNNING', 'WAITING_APPROVAL', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "MissionTaskRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MissionMetricKind" AS ENUM ('LEADING', 'LAGGING');

-- CreateEnum
CREATE TYPE "MissionLearningType" AS ENUM ('OBSERVATION', 'HYPOTHESIS', 'LEARNING', 'DECISION');

-- CreateEnum
CREATE TYPE "MissionEventType" AS ENUM ('MISSION_CREATED', 'PLAN_GENERATED', 'MISSION_ACTIVATED', 'MILESTONE_STARTED', 'MILESTONE_COMPLETED', 'TASK_CREATED', 'TASK_READY', 'TASK_STARTED', 'TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_BLOCKED', 'TASK_SKIPPED', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'METRIC_UPDATED', 'LEARNING_RECORDED', 'REPLAN_TRIGGERED', 'MISSION_PAUSED', 'MISSION_RESUMED', 'MISSION_BLOCKED', 'MISSION_COMPLETED', 'MISSION_FAILED', 'MISSION_CANCELLED', 'LIMIT_REACHED', 'CONFLICT_DETECTED', 'NOTIFICATION_SENT');

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "missionId" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "sourceMissionTaskId" TEXT;

-- AlterTable
ALTER TABLE "integration_action_requests" ADD COLUMN     "sourceMissionTaskId" TEXT;

-- CreateTable
CREATE TABLE "growth_missions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "MissionStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "autonomyLevel" "MissionAutonomyLevel" NOT NULL DEFAULT 'ASSISTED',
    "startDate" TIMESTAMP(3),
    "targetDate" TIMESTAMP(3),
    "allowedPlatforms" "MissionPlatform"[],
    "allowedActions" TEXT[],
    "successMetrics" JSONB NOT NULL,
    "budget" JSONB,
    "constraints" JSONB,
    "limits" JSONB NOT NULL,
    "approvalPolicy" JSONB,
    "currentStrategy" JSONB,
    "currentProgress" JSONB,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "taskCount" INTEGER NOT NULL DEFAULT 0,
    "loopFailureCount" INTEGER NOT NULL DEFAULT 0,
    "lastLoopAt" TIMESTAMP(3),
    "nextLoopAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "growth_missions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_milestones" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "status" "MissionMilestoneStatus" NOT NULL DEFAULT 'PENDING',
    "targetDate" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mission_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_tasks" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "platform" "MissionPlatform" NOT NULL,
    "toolName" TEXT,
    "toolInput" JSONB,
    "dependsOnTaskIds" TEXT[],
    "risk" "MissionTaskRisk" NOT NULL DEFAULT 'LOW',
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "status" "MissionTaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "expectedResult" TEXT,
    "actualResult" JSONB,
    "resourceKey" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "mission_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_metrics" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "MissionMetricKind" NOT NULL,
    "unit" TEXT,
    "currentValue" DOUBLE PRECISION,
    "previousValue" DOUBLE PRECISION,
    "targetValue" DOUBLE PRECISION,
    "trend" TEXT,
    "source" TEXT NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_learnings" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "MissionLearningType" NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "relatedTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_learnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_events" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "MissionEventType" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "growth_missions_organizationId_status_idx" ON "growth_missions"("organizationId", "status");

-- CreateIndex
CREATE INDEX "growth_missions_organizationId_createdAt_idx" ON "growth_missions"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "growth_missions_status_nextLoopAt_idx" ON "growth_missions"("status", "nextLoopAt");

-- CreateIndex
CREATE INDEX "mission_milestones_missionId_order_idx" ON "mission_milestones"("missionId", "order");

-- CreateIndex
CREATE INDEX "mission_tasks_missionId_status_idx" ON "mission_tasks"("missionId", "status");

-- CreateIndex
CREATE INDEX "mission_tasks_organizationId_idx" ON "mission_tasks"("organizationId");

-- CreateIndex
CREATE INDEX "mission_tasks_resourceKey_idx" ON "mission_tasks"("resourceKey");

-- CreateIndex
CREATE INDEX "mission_metrics_missionId_key_measuredAt_idx" ON "mission_metrics"("missionId", "key", "measuredAt");

-- CreateIndex
CREATE INDEX "mission_learnings_missionId_type_createdAt_idx" ON "mission_learnings"("missionId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "mission_events_missionId_createdAt_idx" ON "mission_events"("missionId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_runs_missionId_idx" ON "agent_runs"("missionId");

-- CreateIndex
CREATE INDEX "tasks_sourceMissionTaskId_idx" ON "tasks"("sourceMissionTaskId");

-- CreateIndex
CREATE INDEX "integration_action_requests_sourceMissionTaskId_idx" ON "integration_action_requests"("sourceMissionTaskId");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "growth_missions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sourceMissionTaskId_fkey" FOREIGN KEY ("sourceMissionTaskId") REFERENCES "mission_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_action_requests" ADD CONSTRAINT "integration_action_requests_sourceMissionTaskId_fkey" FOREIGN KEY ("sourceMissionTaskId") REFERENCES "mission_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "growth_missions" ADD CONSTRAINT "growth_missions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_milestones" ADD CONSTRAINT "mission_milestones_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "growth_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_milestones" ADD CONSTRAINT "mission_milestones_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "growth_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "mission_milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_metrics" ADD CONSTRAINT "mission_metrics_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "growth_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_metrics" ADD CONSTRAINT "mission_metrics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_learnings" ADD CONSTRAINT "mission_learnings_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "growth_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_learnings" ADD CONSTRAINT "mission_learnings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "growth_missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_events" ADD CONSTRAINT "mission_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

