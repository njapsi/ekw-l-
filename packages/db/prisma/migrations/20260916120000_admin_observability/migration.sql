-- CreateEnum
CREATE TYPE "ErrorSource" AS ENUM ('WEB', 'WORKER');

-- CreateTable
CREATE TABLE "error_events" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" "ErrorSource" NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Error',
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "route" TEXT,
    "method" TEXT,
    "statusCode" INTEGER,
    "correlationId" TEXT,
    "organizationId" TEXT,
    "actorId" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "context" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "version" TEXT,
    "bootAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redisOk" BOOLEAN NOT NULL DEFAULT true,
    "queues" JSONB NOT NULL DEFAULT '{}',
    "jobsProcessed" BIGINT NOT NULL DEFAULT 0,
    "jobsFailed" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "error_events_fingerprint_key" ON "error_events"("fingerprint");

-- CreateIndex
CREATE INDEX "error_events_lastSeenAt_idx" ON "error_events"("lastSeenAt");

-- CreateIndex
CREATE INDEX "error_events_source_lastSeenAt_idx" ON "error_events"("source", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "worker_heartbeats_workerId_key" ON "worker_heartbeats"("workerId");

-- CreateIndex
CREATE INDEX "worker_heartbeats_lastBeatAt_idx" ON "worker_heartbeats"("lastBeatAt");

