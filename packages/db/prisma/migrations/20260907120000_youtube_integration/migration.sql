-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('YOUTUBE', 'GOOGLE_SEARCH_CONSOLE', 'TIKTOK');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "YouTubeSubjectType" AS ENUM ('CHANNEL', 'VIDEO');

-- CreateEnum
CREATE TYPE "YouTubeSyncKind" AS ENUM ('CHANNEL', 'VIDEOS', 'ANALYTICS');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'NEEDS_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecommendationDomain" AS ENUM ('SEO', 'YOUTUBE', 'TIKTOK', 'CONTENT', 'GROWTH');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'APPLIED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ContentIdeaStatus" AS ENUM ('NEW', 'SAVED', 'IN_PROGRESS', 'PUBLISHED', 'DISCARDED');

-- CreateTable
CREATE TABLE "oauth_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "displayName" TEXT,
    "scopes" TEXT[],
    "accessTokenCipher" TEXT NOT NULL,
    "refreshTokenCipher" TEXT,
    "tokenIv" TEXT NOT NULL,
    "tokenAuthTag" TEXT NOT NULL,
    "refreshIv" TEXT,
    "refreshAuthTag" TEXT,
    "keyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastRefreshedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_health" (
    "id" TEXT NOT NULL,
    "oauthConnectionId" TEXT NOT NULL,
    "lastCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "detail" TEXT,
    "quotaUnitsUsedToday" INTEGER NOT NULL DEFAULT 0,
    "quotaResetAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_channels" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "oauthConnectionId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "description" TEXT,
    "thumbnailUrl" TEXT,
    "country" TEXT,
    "publishedAt" TIMESTAMP(3),
    "uploadsPlaylistId" TEXT,
    "subscriberCount" BIGINT,
    "hiddenSubscriberCount" BOOLEAN NOT NULL DEFAULT false,
    "videoCount" INTEGER,
    "viewCount" BIGINT,
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVideoSyncAt" TIMESTAMP(3),
    "lastAnalyticsSyncAt" TIMESTAMP(3),
    "lastVideoPublishedAt" TIMESTAMP(3),

    CONSTRAINT "youtube_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_videos" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "youTubeChannelId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "durationSeconds" INTEGER,
    "tags" TEXT[],
    "categoryId" TEXT,
    "thumbnailUrl" TEXT,
    "madeForKids" BOOLEAN,
    "privacyStatus" TEXT,
    "liveBroadcastContent" TEXT,
    "defaultLanguage" TEXT,
    "viewCount" BIGINT,
    "likeCount" BIGINT,
    "commentCount" BIGINT,
    "favoriteCount" BIGINT,
    "statsUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "youtube_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_metrics" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subjectType" "YouTubeSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "views" BIGINT NOT NULL DEFAULT 0,
    "estimatedMinutesWatched" BIGINT NOT NULL DEFAULT 0,
    "averageViewDurationSec" INTEGER,
    "likes" BIGINT NOT NULL DEFAULT 0,
    "comments" BIGINT NOT NULL DEFAULT 0,
    "shares" BIGINT NOT NULL DEFAULT 0,
    "subscribersGained" BIGINT NOT NULL DEFAULT 0,
    "subscribersLost" BIGINT NOT NULL DEFAULT 0,
    "impressions" BIGINT,
    "impressionsCtr" DOUBLE PRECISION,
    "estimatedRevenue" DECIMAL(14,4),
    "source" TEXT NOT NULL DEFAULT 'youtube.analytics.v2',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "youtube_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_sync_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "youTubeChannelId" TEXT NOT NULL,
    "kind" "YouTubeSyncKind" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "quotaUnitsSpent" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "cursor" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "youtube_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "tokensPrompt" INTEGER NOT NULL DEFAULT 0,
    "tokensCompletion" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "model" TEXT,
    "provider" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" "RecommendationDomain" NOT NULL,
    "sourceAgentRunId" TEXT,
    "subjectRef" TEXT,
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "effort" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "expectedImpact" TEXT NOT NULL,
    "recommendedActions" TEXT[],
    "implementationInstructions" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PROPOSED',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "dismissedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_ideas" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "supportingClaims" JSONB NOT NULL,
    "keywords" TEXT[],
    "relatedRefs" TEXT[],
    "status" "ContentIdeaStatus" NOT NULL DEFAULT 'NEW',
    "createdByAgentRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_ideas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oauth_connections_organizationId_provider_idx" ON "oauth_connections"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_connections_organizationId_provider_externalAccountId_key" ON "oauth_connections"("organizationId", "provider", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_health_oauthConnectionId_key" ON "integration_health"("oauthConnectionId");

-- CreateIndex
CREATE INDEX "youtube_channels_oauthConnectionId_idx" ON "youtube_channels"("oauthConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_channels_organizationId_channelId_key" ON "youtube_channels"("organizationId", "channelId");

-- CreateIndex
CREATE INDEX "youtube_videos_youTubeChannelId_publishedAt_idx" ON "youtube_videos"("youTubeChannelId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_videos_organizationId_videoId_key" ON "youtube_videos"("organizationId", "videoId");

-- CreateIndex
CREATE INDEX "youtube_metrics_organizationId_date_idx" ON "youtube_metrics"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_metrics_subjectType_subjectId_date_key" ON "youtube_metrics"("subjectType", "subjectId", "date");

-- CreateIndex
CREATE INDEX "youtube_sync_runs_youTubeChannelId_kind_startedAt_idx" ON "youtube_sync_runs"("youTubeChannelId", "kind", "startedAt");

-- CreateIndex
CREATE INDEX "agent_runs_organizationId_agent_createdAt_idx" ON "agent_runs"("organizationId", "agent", "createdAt");

-- CreateIndex
CREATE INDEX "recommendations_organizationId_domain_status_idx" ON "recommendations"("organizationId", "domain", "status");

-- CreateIndex
CREATE INDEX "content_ideas_organizationId_platform_status_idx" ON "content_ideas"("organizationId", "platform", "status");

-- AddForeignKey
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_health" ADD CONSTRAINT "integration_health_oauthConnectionId_fkey" FOREIGN KEY ("oauthConnectionId") REFERENCES "oauth_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_channels" ADD CONSTRAINT "youtube_channels_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_channels" ADD CONSTRAINT "youtube_channels_oauthConnectionId_fkey" FOREIGN KEY ("oauthConnectionId") REFERENCES "oauth_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_videos" ADD CONSTRAINT "youtube_videos_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_videos" ADD CONSTRAINT "youtube_videos_youTubeChannelId_fkey" FOREIGN KEY ("youTubeChannelId") REFERENCES "youtube_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_metrics" ADD CONSTRAINT "youtube_metrics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_sync_runs" ADD CONSTRAINT "youtube_sync_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_sync_runs" ADD CONSTRAINT "youtube_sync_runs_youTubeChannelId_fkey" FOREIGN KEY ("youTubeChannelId") REFERENCES "youtube_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_sourceAgentRunId_fkey" FOREIGN KEY ("sourceAgentRunId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_ideas" ADD CONSTRAINT "content_ideas_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_ideas" ADD CONSTRAINT "content_ideas_createdByAgentRunId_fkey" FOREIGN KEY ("createdByAgentRunId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

