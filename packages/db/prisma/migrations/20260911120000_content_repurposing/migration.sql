-- CreateEnum
CREATE TYPE "RepurposeSourceType" AS ENUM ('YOUTUBE_VIDEO', 'VIDEO_URL', 'TRANSCRIPT', 'MANUAL');

-- CreateEnum
CREATE TYPE "RepurposeProjectStatus" AS ENUM ('DRAFT', 'ANALYZING', 'ANALYZED', 'GENERATING', 'READY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentAssetType" AS ENUM ('YT_TITLE_ALTERNATIVES', 'YT_DESCRIPTION', 'YT_CHAPTERS', 'SHORTS_IDEA', 'TIKTOK_IDEA', 'TIKTOK_CAPTION', 'HOOK', 'SCRIPT', 'SOCIAL_POST', 'BLOG_IDEA', 'SEO_ARTICLE_OUTLINE', 'FAQ', 'NEWSLETTER_IDEA');

-- CreateEnum
CREATE TYPE "ContentAssetStatus" AS ENUM ('DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "repurpose_projects" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" "RepurposeSourceType" NOT NULL,
    "status" "RepurposeProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceYouTubeVideoId" TEXT,
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "sourceDescription" TEXT,
    "sourceTranscript" TEXT,
    "sourceBody" TEXT,
    "sourceTags" TEXT[],
    "sourceDurationSec" INTEGER,
    "analysis" JSONB,
    "analysisAgentRunId" TEXT,
    "analysisGrounded" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "repurpose_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_assets" (
    "id" TEXT NOT NULL,
    "repurposeProjectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "ContentAssetType" NOT NULL,
    "platform" TEXT NOT NULL,
    "title" TEXT,
    "status" "ContentAssetStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "sourceAngle" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishTarget" TEXT,
    "failureReason" TEXT,
    "createdByAgentRunId" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_asset_versions" (
    "id" TEXT NOT NULL,
    "contentAssetId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "structured" JSONB,
    "editedById" TEXT,
    "editSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_asset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repurpose_projects_organizationId_status_idx" ON "repurpose_projects"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "content_assets_currentVersionId_key" ON "content_assets"("currentVersionId");

-- CreateIndex
CREATE INDEX "content_assets_repurposeProjectId_type_idx" ON "content_assets"("repurposeProjectId", "type");

-- CreateIndex
CREATE INDEX "content_assets_organizationId_status_idx" ON "content_assets"("organizationId", "status");

-- CreateIndex
CREATE INDEX "content_asset_versions_contentAssetId_idx" ON "content_asset_versions"("contentAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "content_asset_versions_contentAssetId_versionNumber_key" ON "content_asset_versions"("contentAssetId", "versionNumber");

-- AddForeignKey
ALTER TABLE "repurpose_projects" ADD CONSTRAINT "repurpose_projects_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_repurposeProjectId_fkey" FOREIGN KEY ("repurposeProjectId") REFERENCES "repurpose_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "content_asset_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_asset_versions" ADD CONSTRAINT "content_asset_versions_contentAssetId_fkey" FOREIGN KEY ("contentAssetId") REFERENCES "content_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_asset_versions" ADD CONSTRAINT "content_asset_versions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

