-- CreateEnum
CREATE TYPE "WebsiteVerificationMethod" AS ENUM ('DNS_TXT', 'HTML_FILE', 'SEARCH_CONSOLE');

-- CreateEnum
CREATE TYPE "CrawlRenderMode" AS ENUM ('STATIC', 'AUTO', 'HEADLESS');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CrawlIssueSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "CrawlIssueStatus" AS ENUM ('OPEN', 'FIXED', 'REGRESSED', 'IGNORED');

-- CreateTable
CREATE TABLE "websites" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verificationMethod" "WebsiteVerificationMethod",
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "robotsTxtCache" TEXT,
    "robotsFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawls" (
    "id" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "CrawlStatus" NOT NULL DEFAULT 'QUEUED',
    "renderMode" "CrawlRenderMode" NOT NULL DEFAULT 'STATIC',
    "requestedById" TEXT,
    "config" JSONB NOT NULL,
    "summary" JSONB,
    "scores" JSONB,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "pagesQueued" INTEGER NOT NULL DEFAULT 0,
    "issuesFound" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "blockedReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crawls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_pages" (
    "id" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "discoveredVia" TEXT NOT NULL DEFAULT 'link',
    "httpStatus" INTEGER,
    "finalUrl" TEXT,
    "redirectChain" JSONB NOT NULL DEFAULT '[]',
    "fetchError" TEXT,
    "contentType" TEXT,
    "htmlBytes" INTEGER,
    "responseTimeMs" INTEGER,
    "renderedWithJs" BOOLEAN NOT NULL DEFAULT false,
    "fromCache" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "titleLength" INTEGER,
    "metaDescription" TEXT,
    "metaDescriptionLength" INTEGER,
    "metaRobots" TEXT,
    "xRobotsTag" TEXT,
    "canonicalUrl" TEXT,
    "canonicalIsSelf" BOOLEAN,
    "noindex" BOOLEAN NOT NULL DEFAULT false,
    "robotsBlocked" BOOLEAN NOT NULL DEFAULT false,
    "indexable" BOOLEAN NOT NULL DEFAULT false,
    "indexabilityReason" TEXT,
    "crawlable" BOOLEAN NOT NULL DEFAULT true,
    "lang" TEXT,
    "hreflang" JSONB NOT NULL DEFAULT '[]',
    "h1Count" INTEGER NOT NULL DEFAULT 0,
    "headingOutline" JSONB NOT NULL DEFAULT '[]',
    "wordCount" INTEGER,
    "contentHash" TEXT,
    "simhash" TEXT,
    "ogTags" JSONB NOT NULL DEFAULT '{}',
    "twitterTags" JSONB NOT NULL DEFAULT '{}',
    "jsonLdTypes" TEXT[],
    "jsonLdErrors" JSONB NOT NULL DEFAULT '[]',
    "viewportMeta" BOOLEAN NOT NULL DEFAULT false,
    "imagesTotal" INTEGER NOT NULL DEFAULT 0,
    "imagesMissingAlt" INTEGER NOT NULL DEFAULT 0,
    "imagesMissingDim" INTEGER NOT NULL DEFAULT 0,
    "internalLinkCount" INTEGER NOT NULL DEFAULT 0,
    "externalLinkCount" INTEGER NOT NULL DEFAULT 0,
    "inboundInternalCount" INTEGER NOT NULL DEFAULT 0,
    "isHttps" BOOLEAN NOT NULL DEFAULT false,
    "securityHeaders" JSONB NOT NULL DEFAULT '{}',
    "mixedContent" BOOLEAN NOT NULL DEFAULT false,
    "csrLikely" BOOLEAN NOT NULL DEFAULT false,
    "staticWordCount" INTEGER,
    "renderedWordCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_links" (
    "id" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromPageId" TEXT NOT NULL,
    "toNormalizedUrl" TEXT NOT NULL,
    "toPageId" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "isNofollow" BOOLEAN NOT NULL DEFAULT false,
    "rel" TEXT,
    "anchorText" TEXT,
    "statusAtCheck" INTEGER,

    CONSTRAINT "crawl_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_issues" (
    "id" TEXT NOT NULL,
    "crawlId" TEXT NOT NULL,
    "websiteId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" "CrawlIssueSeverity" NOT NULL,
    "pageId" TEXT,
    "normalizedUrl" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "recommendedFix" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "status" "CrawlIssueStatus" NOT NULL DEFAULT 'OPEN',
    "affectedUrlCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "websites_organizationId_idx" ON "websites"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "websites_organizationId_hostname_key" ON "websites"("organizationId", "hostname");

-- CreateIndex
CREATE INDEX "crawls_organizationId_createdAt_idx" ON "crawls"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "crawls_websiteId_createdAt_idx" ON "crawls"("websiteId", "createdAt");

-- CreateIndex
CREATE INDEX "crawl_pages_crawlId_depth_idx" ON "crawl_pages"("crawlId", "depth");

-- CreateIndex
CREATE INDEX "crawl_pages_crawlId_httpStatus_idx" ON "crawl_pages"("crawlId", "httpStatus");

-- CreateIndex
CREATE INDEX "crawl_pages_organizationId_idx" ON "crawl_pages"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "crawl_pages_crawlId_normalizedUrl_key" ON "crawl_pages"("crawlId", "normalizedUrl");

-- CreateIndex
CREATE INDEX "crawl_links_crawlId_toNormalizedUrl_idx" ON "crawl_links"("crawlId", "toNormalizedUrl");

-- CreateIndex
CREATE INDEX "crawl_links_crawlId_fromPageId_idx" ON "crawl_links"("crawlId", "fromPageId");

-- CreateIndex
CREATE INDEX "crawl_links_organizationId_idx" ON "crawl_links"("organizationId");

-- CreateIndex
CREATE INDEX "crawl_issues_crawlId_category_severity_idx" ON "crawl_issues"("crawlId", "category", "severity");

-- CreateIndex
CREATE INDEX "crawl_issues_websiteId_code_idx" ON "crawl_issues"("websiteId", "code");

-- CreateIndex
CREATE INDEX "crawl_issues_organizationId_idx" ON "crawl_issues"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "crawl_issues_crawlId_code_normalizedUrl_key" ON "crawl_issues"("crawlId", "code", "normalizedUrl");

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "crawls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_links" ADD CONSTRAINT "crawl_links_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "crawls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_links" ADD CONSTRAINT "crawl_links_fromPageId_fkey" FOREIGN KEY ("fromPageId") REFERENCES "crawl_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_links" ADD CONSTRAINT "crawl_links_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_issues" ADD CONSTRAINT "crawl_issues_crawlId_fkey" FOREIGN KEY ("crawlId") REFERENCES "crawls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_issues" ADD CONSTRAINT "crawl_issues_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_issues" ADD CONSTRAINT "crawl_issues_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "crawl_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_issues" ADD CONSTRAINT "crawl_issues_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

