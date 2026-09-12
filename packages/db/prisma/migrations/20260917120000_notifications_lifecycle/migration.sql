-- Phase 19 — Notifications + account/organization lifecycle.
-- Additive: one new enum, one new table, three new nullable columns. The two
-- FK redefinitions change ON DELETE RESTRICT -> CASCADE for crawl_pages /
-- crawl_links so an organization purge cascades cleanly (no data is dropped by
-- this migration).

-- CreateEnum
CREATE TYPE "NotificationLevel" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deletionScheduledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "deletionScheduledAt" TIMESTAMP(3),
ADD COLUMN     "deletionRequestedById" TEXT;

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "level" "NotificationLevel" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "linkPath" TEXT,
    "dedupeKey" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "readAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_organizationId_userId_createdAt_idx" ON "notifications"("organizationId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RedefineForeignKey: crawl_pages.organizationId  RESTRICT -> CASCADE
ALTER TABLE "crawl_pages" DROP CONSTRAINT "crawl_pages_organizationId_fkey";
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RedefineForeignKey: crawl_links.organizationId  RESTRICT -> CASCADE
ALTER TABLE "crawl_links" DROP CONSTRAINT "crawl_links_organizationId_fkey";
ALTER TABLE "crawl_links" ADD CONSTRAINT "crawl_links_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
