-- Phase 20 — Google Search Console integration.
-- Additive: three enums, two tables. GSC reuses the existing `oauth_connections`
-- table (provider 'GOOGLE_SEARCH_CONSOLE'). No DROP.

-- CreateEnum
CREATE TYPE "SearchConsolePermission" AS ENUM ('SITE_OWNER', 'SITE_FULL_USER', 'SITE_RESTRICTED_USER', 'SITE_UNVERIFIED_USER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SearchConsolePropertyType" AS ENUM ('DOMAIN', 'URL_PREFIX');

-- CreateEnum
CREATE TYPE "SearchConsoleSnapshotKind" AS ENUM ('PERFORMANCE', 'SITEMAPS', 'URL_INSPECTION');

-- CreateTable
CREATE TABLE "search_console_sites" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "oauthConnectionId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "propertyType" "SearchConsolePropertyType" NOT NULL,
    "hostname" TEXT NOT NULL,
    "permissionLevel" "SearchConsolePermission" NOT NULL DEFAULT 'UNKNOWN',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "lastPerformanceAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_console_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_console_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "searchConsoleSiteId" TEXT NOT NULL,
    "kind" "SearchConsoleSnapshotKind" NOT NULL,
    "subjectUrl" TEXT,
    "rangeStart" DATE,
    "rangeEnd" DATE,
    "data" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_console_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "search_console_sites_organizationId_idx" ON "search_console_sites"("organizationId");

-- CreateIndex
CREATE INDEX "search_console_sites_oauthConnectionId_idx" ON "search_console_sites"("oauthConnectionId");

-- CreateIndex
CREATE INDEX "search_console_sites_organizationId_hostname_idx" ON "search_console_sites"("organizationId", "hostname");

-- CreateIndex
CREATE UNIQUE INDEX "search_console_sites_organizationId_siteUrl_key" ON "search_console_sites"("organizationId", "siteUrl");

-- CreateIndex
CREATE INDEX "search_console_snapshots_searchConsoleSiteId_kind_capturedAt_idx" ON "search_console_snapshots"("searchConsoleSiteId", "kind", "capturedAt");

-- CreateIndex
CREATE INDEX "search_console_snapshots_organizationId_idx" ON "search_console_snapshots"("organizationId");

-- AddForeignKey
ALTER TABLE "search_console_sites" ADD CONSTRAINT "search_console_sites_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_console_sites" ADD CONSTRAINT "search_console_sites_oauthConnectionId_fkey" FOREIGN KEY ("oauthConnectionId") REFERENCES "oauth_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_console_snapshots" ADD CONSTRAINT "search_console_snapshots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_console_snapshots" ADD CONSTRAINT "search_console_snapshots_searchConsoleSiteId_fkey" FOREIGN KEY ("searchConsoleSiteId") REFERENCES "search_console_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
