-- CreateEnum
CREATE TYPE "TikTokSyncKind" AS ENUM ('ACCOUNT', 'VIDEOS');

-- CreateEnum
CREATE TYPE "TikTokPublishStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'SUBMITTED', 'PROCESSING', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TikTokPrivacy" AS ENUM ('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY');

-- CreateTable
CREATE TABLE "tiktok_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "oauthConnectionId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "username" TEXT,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "bioDescription" TEXT,
    "isVerified" BOOLEAN,
    "followerCount" BIGINT,
    "followingCount" BIGINT,
    "likesCount" BIGINT,
    "videoCountStat" INTEGER,
    "profileDeepLink" TEXT,
    "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVideoSyncAt" TIMESTAMP(3),
    "lastVideoCreateTime" TIMESTAMP(3),

    CONSTRAINT "tiktok_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiktok_videos" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tikTokAccountId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "caption" TEXT,
    "createTime" TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER,
    "coverImageUrl" TEXT,
    "shareUrl" TEXT,
    "embedLink" TEXT,
    "hashtags" TEXT[],
    "viewCount" BIGINT,
    "likeCount" BIGINT,
    "commentCount" BIGINT,
    "shareCount" BIGINT,
    "statsUpdatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tiktok_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiktok_metrics" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tikTokAccountId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "followerCount" BIGINT,
    "likesCount" BIGINT,
    "videoCount" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'tiktok.display.v2:user.info',

    CONSTRAINT "tiktok_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiktok_sync_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tikTokAccountId" TEXT NOT NULL,
    "kind" "TikTokSyncKind" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "cursor" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "tiktok_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tiktok_publishes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tikTokAccountId" TEXT NOT NULL,
    "status" "TikTokPublishStatus" NOT NULL DEFAULT 'DRAFT',
    "privacy" "TikTokPrivacy" NOT NULL DEFAULT 'SELF_ONLY',
    "caption" TEXT NOT NULL,
    "hashtags" TEXT[],
    "sourceType" TEXT NOT NULL DEFAULT 'PULL_FROM_URL',
    "sourceUrl" TEXT,
    "disableComment" BOOLEAN NOT NULL DEFAULT false,
    "disableDuet" BOOLEAN NOT NULL DEFAULT false,
    "disableStitch" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT NOT NULL,
    "publishId" TEXT,
    "error" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastStatusCheck" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tiktok_publishes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tiktok_accounts_oauthConnectionId_idx" ON "tiktok_accounts"("oauthConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "tiktok_accounts_organizationId_openId_key" ON "tiktok_accounts"("organizationId", "openId");

-- CreateIndex
CREATE INDEX "tiktok_videos_tikTokAccountId_createTime_idx" ON "tiktok_videos"("tikTokAccountId", "createTime");

-- CreateIndex
CREATE UNIQUE INDEX "tiktok_videos_organizationId_videoId_key" ON "tiktok_videos"("organizationId", "videoId");

-- CreateIndex
CREATE INDEX "tiktok_metrics_organizationId_capturedAt_idx" ON "tiktok_metrics"("organizationId", "capturedAt");

-- CreateIndex
CREATE INDEX "tiktok_sync_runs_tikTokAccountId_kind_startedAt_idx" ON "tiktok_sync_runs"("tikTokAccountId", "kind", "startedAt");

-- CreateIndex
CREATE INDEX "tiktok_publishes_organizationId_status_idx" ON "tiktok_publishes"("organizationId", "status");

-- CreateIndex
CREATE INDEX "tiktok_publishes_tikTokAccountId_contentHash_idx" ON "tiktok_publishes"("tikTokAccountId", "contentHash");

-- AddForeignKey
ALTER TABLE "tiktok_accounts" ADD CONSTRAINT "tiktok_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_accounts" ADD CONSTRAINT "tiktok_accounts_oauthConnectionId_fkey" FOREIGN KEY ("oauthConnectionId") REFERENCES "oauth_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_videos" ADD CONSTRAINT "tiktok_videos_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_videos" ADD CONSTRAINT "tiktok_videos_tikTokAccountId_fkey" FOREIGN KEY ("tikTokAccountId") REFERENCES "tiktok_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_metrics" ADD CONSTRAINT "tiktok_metrics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_sync_runs" ADD CONSTRAINT "tiktok_sync_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_sync_runs" ADD CONSTRAINT "tiktok_sync_runs_tikTokAccountId_fkey" FOREIGN KEY ("tikTokAccountId") REFERENCES "tiktok_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_publishes" ADD CONSTRAINT "tiktok_publishes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tiktok_publishes" ADD CONSTRAINT "tiktok_publishes_tikTokAccountId_fkey" FOREIGN KEY ("tikTokAccountId") REFERENCES "tiktok_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

