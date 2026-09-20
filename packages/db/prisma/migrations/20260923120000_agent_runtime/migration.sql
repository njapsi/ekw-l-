-- Phase 4: AI agent core / real agentic execution engine (ADR-0054).
-- Additive only: one new enum, two new AgentRunStatus values, nullable/
-- defaulted columns on agent_runs, one new table. No DROP, no data rewrite.
--
-- Deviation from `prisma migrate diff`'s raw output: the generated script
-- added `updatedAt` as NOT NULL with no default, which fails against a
-- table that already has rows (this environment's staging `agent_runs`
-- table is not empty). Given `@updatedAt` in the schema, the column is
-- backfilled with CURRENT_TIMESTAMP for existing rows via a DEFAULT, same
-- convention as every other `@updatedAt` column added post-launch in this
-- migration history.

-- AlterEnum
ALTER TYPE "AgentRunStatus" ADD VALUE 'PAUSED';
ALTER TYPE "AgentRunStatus" ADD VALUE 'TIMED_OUT';

-- CreateEnum
CREATE TYPE "AgentRunEventType" AS ENUM ('RUN_CREATED', 'RUN_STARTED', 'CONTEXT_LOADED', 'PLAN_CREATED', 'MODEL_CALLED', 'MODEL_RESPONSE', 'TOOL_SELECTED', 'TOOL_AUTHORIZATION_CHECK', 'TOOL_STARTED', 'TOOL_COMPLETED', 'TOOL_FAILED', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'USER_INPUT_REQUESTED', 'USER_INPUT_RECEIVED', 'MEMORY_UPDATED', 'RETRY_STARTED', 'RUN_PAUSED', 'RUN_RESUMED', 'RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED');

-- AlterTable
ALTER TABLE "agent_runs"
  ADD COLUMN "userId" TEXT,
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "currentStep" TEXT,
  ADD COLUMN "iterationCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "toolCallCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "agent_runs_organizationId_conversationId_idx" ON "agent_runs"("organizationId", "conversationId");

-- CreateTable
CREATE TABLE "agent_run_events" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "AgentRunEventType" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_run_events_agentRunId_createdAt_idx" ON "agent_run_events"("agentRunId", "createdAt");

-- AddForeignKey
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
