-- Phase 11: Memory, Research & Knowledge Intelligence.
-- Purely additive: one new enum value on the existing UsageMeter enum, one
-- new Postgres extension, and 11 new tables. No DROP, no column rewrite on
-- any existing table.
--
-- `CREATE EXTENSION IF NOT EXISTS vector` requires the pgvector extension to
-- be installed on the Postgres server (bundled on Supabase and most managed
-- Postgres offerings; `CREATE EXTENSION` itself needs a superuser or a role
-- Supabase/RDS grants that privilege to). If the extension is unavailable,
-- this migration fails at this statement and every other statement is safe
-- to re-run after the extension is installed — nothing before it depends on
-- `vector` existing.

-- AlterEnum
-- ALTER TYPE ... ADD VALUE is safe on PostgreSQL 12+ inside a transaction, as
-- long as the new value isn't referenced later in the same transaction (it
-- isn't — see the enterprise_identity/tool_platform migrations for the same
-- pattern).
ALTER TYPE "UsageMeter" ADD VALUE 'RESEARCH_CALLS';

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "KnowledgeClassification" AS ENUM ('FACT', 'INFERENCE', 'HYPOTHESIS', 'OPINION', 'USER_PROVIDED', 'SYSTEM_OBSERVED', 'EXTERNAL_SOURCE');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('DRAFT', 'ACTIVE', 'VERIFIED', 'UNVERIFIED', 'STALE', 'CONFLICTED', 'ARCHIVED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KnowledgeScope" AS ENUM ('USER', 'ORGANIZATION', 'MISSION');

-- CreateEnum
CREATE TYPE "KnowledgeImportance" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "KnowledgeType" AS ENUM ('BUSINESS_PROFILE', 'BRAND_PROFILE', 'AUDIENCE_PROFILE', 'PRODUCT', 'SERVICE', 'OFFER', 'WEBSITE', 'SEO', 'CONTENT', 'YOUTUBE', 'TIKTOK', 'WORDPRESS', 'COMPETITOR', 'MARKET', 'KEYWORD', 'TOPIC', 'CAMPAIGN', 'MISSION', 'EXPERIMENT', 'PERFORMANCE', 'CUSTOMER_INSIGHT', 'GROWTH_INSIGHT', 'USER_PREFERENCE', 'ORGANIZATION_PREFERENCE', 'STRATEGY', 'DECISION', 'ASSUMPTION', 'CONSTRAINT', 'GOAL', 'RESOURCE', 'PROCESS', 'DOCUMENT', 'RESEARCH', 'EXTERNAL_FACT', 'INTERNAL_FACT', 'LEARNING');

-- CreateEnum
CREATE TYPE "KnowledgeSourceType" AS ENUM ('YOUTUBE', 'TIKTOK', 'GOOGLE_SEARCH_CONSOLE', 'WEBSITE_CRAWL', 'WORDPRESS', 'USER_INPUT', 'UPLOADED_DOCUMENT', 'INTERNAL_ANALYTICS', 'MISSION_RESULT', 'EXPERIMENT_RESULT', 'AI_GENERATED', 'WEB_RESEARCH');

-- CreateEnum
CREATE TYPE "SourceTrustLevel" AS ENUM ('VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "KnowledgeRelationType" AS ENUM ('RELATES_TO', 'SUPPORTS', 'CONTRADICTS', 'DERIVED_FROM', 'TARGETS', 'PUBLISHED_ON', 'GENERATED_BY', 'RESULTED_IN', 'INFLUENCES', 'DEPENDS_ON');

-- CreateEnum
CREATE TYPE "KnowledgeConflictStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "MemoryCandidateStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'AUTO_ACCEPTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('REQUESTED', 'PLANNING', 'SEARCHING', 'COLLECTING', 'ANALYZING', 'VERIFYING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "KnowledgeSourceType" NOT NULL,
    "url" TEXT,
    "title" TEXT,
    "publisher" TEXT,
    "author" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "contentHash" TEXT,
    "trustLevel" "SourceTrustLevel" NOT NULL DEFAULT 'UNKNOWN',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT,
    "missionId" TEXT,
    "type" "KnowledgeType" NOT NULL,
    "scope" "KnowledgeScope" NOT NULL DEFAULT 'ORGANIZATION',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "classification" "KnowledgeClassification" NOT NULL DEFAULT 'SYSTEM_OBSERVED',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "importance" "KnowledgeImportance" NOT NULL DEFAULT 'MEDIUM',
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'DRAFT',
    "primarySourceId" TEXT,
    "freshnessPolicy" TEXT NOT NULL DEFAULT 'medium',
    "expiresAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_evidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "knowledgeId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "location" TEXT,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_embeddings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "knowledgeId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "chunkText" TEXT NOT NULL,
    "chunkMetadata" JSONB,
    "embedding" vector(1536),
    "embeddingModel" TEXT,
    "embeddingVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_relations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "type" "KnowledgeRelationType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_conflicts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "knowledgeAId" TEXT NOT NULL,
    "knowledgeBId" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "KnowledgeConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "knowledge_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_candidates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "content" TEXT NOT NULL,
    "proposedType" "KnowledgeType" NOT NULL,
    "classification" "KnowledgeClassification" NOT NULL DEFAULT 'USER_PROVIDED',
    "scope" "KnowledgeScope" NOT NULL DEFAULT 'ORGANIZATION',
    "importance" "KnowledgeImportance" NOT NULL DEFAULT 'MEDIUM',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "reason" TEXT NOT NULL,
    "status" "MemoryCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedKnowledgeId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_projects" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "missionId" TEXT,
    "question" TEXT NOT NULL,
    "objective" TEXT,
    "scope" TEXT,
    "status" "ResearchStatus" NOT NULL DEFAULT 'REQUESTED',
    "config" JSONB,
    "conclusion" TEXT,
    "confidence" DOUBLE PRECISION,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_queries" (
    "id" TEXT NOT NULL,
    "researchProjectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3),
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_findings" (
    "id" TEXT NOT NULL,
    "researchProjectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "finding" TEXT NOT NULL,
    "sourceId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "conflictsWithFindingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_citations" (
    "id" TEXT NOT NULL,
    "researchProjectId" TEXT NOT NULL,
    "findingId" TEXT,
    "organizationId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "quote" TEXT,
    "url" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_citations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_sources_organizationId_type_idx" ON "knowledge_sources"("organizationId", "type");

-- CreateIndex
CREATE INDEX "knowledge_sources_organizationId_contentHash_idx" ON "knowledge_sources"("organizationId", "contentHash");

-- CreateIndex
CREATE INDEX "knowledge_items_organizationId_type_status_idx" ON "knowledge_items"("organizationId", "type", "status");

-- CreateIndex
CREATE INDEX "knowledge_items_organizationId_status_expiresAt_idx" ON "knowledge_items"("organizationId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "knowledge_items_organizationId_scope_missionId_idx" ON "knowledge_items"("organizationId", "scope", "missionId");

-- CreateIndex
CREATE INDEX "knowledge_items_organizationId_updatedAt_idx" ON "knowledge_items"("organizationId", "updatedAt");

-- CreateIndex
CREATE INDEX "knowledge_evidence_knowledgeId_idx" ON "knowledge_evidence"("knowledgeId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_embeddings_knowledgeId_chunkIndex_key" ON "knowledge_embeddings"("knowledgeId", "chunkIndex");

-- CreateIndex
CREATE INDEX "knowledge_embeddings_organizationId_idx" ON "knowledge_embeddings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_relations_fromId_toId_type_key" ON "knowledge_relations"("fromId", "toId", "type");

-- CreateIndex
CREATE INDEX "knowledge_relations_organizationId_idx" ON "knowledge_relations"("organizationId");

-- CreateIndex
CREATE INDEX "knowledge_conflicts_organizationId_status_idx" ON "knowledge_conflicts"("organizationId", "status");

-- CreateIndex
CREATE INDEX "memory_candidates_organizationId_status_idx" ON "memory_candidates"("organizationId", "status");

-- CreateIndex
CREATE INDEX "research_projects_organizationId_status_idx" ON "research_projects"("organizationId", "status");

-- CreateIndex
CREATE INDEX "research_projects_organizationId_createdAt_idx" ON "research_projects"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "research_queries_researchProjectId_idx" ON "research_queries"("researchProjectId");

-- CreateIndex
CREATE INDEX "research_findings_researchProjectId_idx" ON "research_findings"("researchProjectId");

-- CreateIndex
CREATE INDEX "research_citations_researchProjectId_idx" ON "research_citations"("researchProjectId");

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_primarySourceId_fkey" FOREIGN KEY ("primarySourceId") REFERENCES "knowledge_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_evidence" ADD CONSTRAINT "knowledge_evidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_evidence" ADD CONSTRAINT "knowledge_evidence_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_evidence" ADD CONSTRAINT "knowledge_evidence_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_embeddings" ADD CONSTRAINT "knowledge_embeddings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_embeddings" ADD CONSTRAINT "knowledge_embeddings_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_toId_fkey" FOREIGN KEY ("toId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_conflicts" ADD CONSTRAINT "knowledge_conflicts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_conflicts" ADD CONSTRAINT "knowledge_conflicts_knowledgeAId_fkey" FOREIGN KEY ("knowledgeAId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_conflicts" ADD CONSTRAINT "knowledge_conflicts_knowledgeBId_fkey" FOREIGN KEY ("knowledgeBId") REFERENCES "knowledge_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_resolvedKnowledgeId_fkey" FOREIGN KEY ("resolvedKnowledgeId") REFERENCES "knowledge_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_projects" ADD CONSTRAINT "research_projects_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_queries" ADD CONSTRAINT "research_queries_researchProjectId_fkey" FOREIGN KEY ("researchProjectId") REFERENCES "research_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_queries" ADD CONSTRAINT "research_queries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_researchProjectId_fkey" FOREIGN KEY ("researchProjectId") REFERENCES "research_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "knowledge_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_findings" ADD CONSTRAINT "research_findings_conflictsWithFindingId_fkey" FOREIGN KEY ("conflictsWithFindingId") REFERENCES "research_findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_citations" ADD CONSTRAINT "research_citations_researchProjectId_fkey" FOREIGN KEY ("researchProjectId") REFERENCES "research_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_citations" ADD CONSTRAINT "research_citations_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "research_findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_citations" ADD CONSTRAINT "research_citations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_citations" ADD CONSTRAINT "research_citations_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
