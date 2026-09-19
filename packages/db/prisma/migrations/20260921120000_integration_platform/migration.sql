-- Phase 1 — unified integration platform (ADR-0051).
-- Additive: four enums, four tables. No DROP, no change to existing tables.

-- CreateEnum
CREATE TYPE "WordPressContentType" AS ENUM ('POST', 'PAGE');

-- CreateEnum
CREATE TYPE "IntegrationSyncTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'AUTOMATION');

-- CreateEnum
CREATE TYPE "IntegrationActionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "IntegrationActionSource" AS ENUM ('USER', 'AGENT', 'AUTOMATION');

-- CreateTable
CREATE TABLE "wordpress_sites" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "siteName" TEXT,
    "username" TEXT NOT NULL,
    "credentialCipher" TEXT NOT NULL,
    "credentialIv" TEXT NOT NULL,
    "credentialAuthTag" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "detectedCapabilities" TEXT[],
    "wpUserId" INTEGER,
    "lastError" TEXT,
    "lastCheckAt" TIMESTAMP(3),
    "lastCheckOk" BOOLEAN,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wordpress_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wordpress_content" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "wordPressSiteId" TEXT NOT NULL,
    "wpId" INTEGER NOT NULL,
    "type" "WordPressContentType" NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "link" TEXT,
    "slug" TEXT,
    "excerpt" TEXT,
    "modifiedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wordpress_content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integration" TEXT NOT NULL,
    "connectionRef" TEXT NOT NULL,
    "trigger" "IntegrationSyncTrigger" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "integration_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_action_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integration" TEXT NOT NULL,
    "connectionRef" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IntegrationActionStatus" NOT NULL DEFAULT 'PENDING',
    "source" "IntegrationActionSource" NOT NULL DEFAULT 'USER',
    "requestedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_action_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wordpress_sites_organizationId_idx" ON "wordpress_sites"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "wordpress_sites_organizationId_siteUrl_key" ON "wordpress_sites"("organizationId", "siteUrl");

-- CreateIndex
CREATE INDEX "wordpress_content_organizationId_idx" ON "wordpress_content"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "wordpress_content_wordPressSiteId_type_wpId_key" ON "wordpress_content"("wordPressSiteId", "type", "wpId");

-- CreateIndex
CREATE INDEX "integration_sync_runs_organizationId_integration_startedAt_idx" ON "integration_sync_runs"("organizationId", "integration", "startedAt");

-- CreateIndex
CREATE INDEX "integration_sync_runs_connectionRef_status_idx" ON "integration_sync_runs"("connectionRef", "status");

-- CreateIndex
CREATE INDEX "integration_action_requests_organizationId_status_createdAt_idx" ON "integration_action_requests"("organizationId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "wordpress_sites" ADD CONSTRAINT "wordpress_sites_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wordpress_content" ADD CONSTRAINT "wordpress_content_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wordpress_content" ADD CONSTRAINT "wordpress_content_wordPressSiteId_fkey" FOREIGN KEY ("wordPressSiteId") REFERENCES "wordpress_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_action_requests" ADD CONSTRAINT "integration_action_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
