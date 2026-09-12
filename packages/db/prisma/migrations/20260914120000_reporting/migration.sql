-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('YOUTUBE', 'TIKTOK', 'SEO', 'WEBSITE_HEALTH', 'AI_RECOMMENDATIONS', 'GROWTH', 'MONETIZATION');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'BUILDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "ReportType" NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "snapshot" JSONB,
    "params" JSONB NOT NULL DEFAULT '{}',
    "subjectRef" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "dataThrough" TIMESTAMP(3),
    "previousReportId" TEXT,
    "generatedByAgentRunId" TEXT,
    "requestedById" TEXT NOT NULL,
    "error" TEXT,
    "shareToken" TEXT,
    "shareExpiresAt" TIMESTAMP(3),
    "shareRevokedAt" TIMESTAMP(3),
    "shareCreatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reports_shareToken_key" ON "reports"("shareToken");

-- CreateIndex
CREATE INDEX "reports_organizationId_type_createdAt_idx" ON "reports"("organizationId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "reports_organizationId_createdAt_idx" ON "reports"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

