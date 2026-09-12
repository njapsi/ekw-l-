-- Phase 28 — performance: the existing composite index on `recommendations`
-- (organizationId, domain, status) doesn't serve the highest-volume real
-- read paths, which filter by organizationId alone and sort by
-- priorityScore desc, createdAt desc (packages/services/src/agent/
-- capabilities.ts, packages/services/src/reports/facts.ts). Additive, no
-- DROP.

-- CreateIndex
CREATE INDEX "recommendations_organizationId_priorityScore_createdAt_idx" ON "recommendations"("organizationId", "priorityScore", "createdAt");
