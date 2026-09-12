-- AlterTable
ALTER TABLE "recommendations" ADD COLUMN     "actionPlan" TEXT,
ADD COLUMN     "affectedUrlCount" INTEGER,
ADD COLUMN     "businessImportance" TEXT,
ADD COLUMN     "priorityScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "crawl_pages" ADD COLUMN     "hasMainLandmark" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "jsonLdEntities" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "landmarkCount" INTEGER NOT NULL DEFAULT 0;

