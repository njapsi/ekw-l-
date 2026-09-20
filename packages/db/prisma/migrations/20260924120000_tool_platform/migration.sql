-- Phase 5 — tool ecosystem, MCP & agent orchestration (ADR-0055).
-- Additive: one new UsageMeter value, five new enums, two new tables.
-- No DROP, no change to any existing table.

-- AlterEnum
ALTER TYPE "UsageMeter" ADD VALUE 'TOOL_CALLS';

-- CreateEnum
CREATE TYPE "McpTransportKind" AS ENUM ('SSE', 'STDIO');

-- CreateEnum
CREATE TYPE "McpAuthKind" AS ENUM ('NONE', 'API_KEY', 'BEARER_TOKEN');

-- CreateEnum
CREATE TYPE "McpTrustLevel" AS ENUM ('INTERNAL', 'TRUSTED', 'VERIFIED_EXTERNAL', 'UNVERIFIED_EXTERNAL');

-- CreateEnum
CREATE TYPE "McpServerStatus" AS ENUM ('PENDING', 'CONNECTED', 'DEGRADED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "McpToolRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "mcp_servers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "transport" "McpTransportKind" NOT NULL DEFAULT 'SSE',
    "authKind" "McpAuthKind" NOT NULL DEFAULT 'NONE',
    "credentialCipher" TEXT,
    "credentialIv" TEXT,
    "credentialAuthTag" TEXT,
    "keyId" TEXT,
    "trustLevel" "McpTrustLevel" NOT NULL DEFAULT 'UNVERIFIED_EXTERNAL',
    "status" "McpServerStatus" NOT NULL DEFAULT 'PENDING',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "protocolVersion" TEXT,
    "serverVersion" TEXT,
    "lastError" TEXT,
    "lastCheckAt" TIMESTAMP(3),
    "lastCheckOk" BOOLEAN,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_server_tools" (
    "id" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "namespacedName" TEXT NOT NULL,
    "description" TEXT,
    "inputSchema" JSONB NOT NULL,
    "riskLevel" "McpToolRiskLevel" NOT NULL DEFAULT 'HIGH',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_server_tools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_servers_organizationId_idx" ON "mcp_servers"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_servers_organizationId_name_key" ON "mcp_servers"("organizationId", "name");

-- CreateIndex
CREATE INDEX "mcp_server_tools_organizationId_idx" ON "mcp_server_tools"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_tools_mcpServerId_name_key" ON "mcp_server_tools"("mcpServerId", "name");

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_tools" ADD CONSTRAINT "mcp_server_tools_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_tools" ADD CONSTRAINT "mcp_server_tools_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
