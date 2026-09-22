-- AlterEnum
ALTER TYPE "RecommendationDomain" ADD VALUE 'WORDPRESS';

-- AlterEnum
ALTER TYPE "AutomationTaskType" ADD VALUE 'WORDPRESS_CONTENT_REFRESH';

-- AlterTable
ALTER TABLE "integration_action_requests" ADD COLUMN     "sourceCrawlIssueId" TEXT;

-- CreateIndex
CREATE INDEX "integration_action_requests_sourceCrawlIssueId_idx" ON "integration_action_requests"("sourceCrawlIssueId");

-- AddForeignKey
ALTER TABLE "integration_action_requests" ADD CONSTRAINT "integration_action_requests_sourceCrawlIssueId_fkey" FOREIGN KEY ("sourceCrawlIssueId") REFERENCES "crawl_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

