#!/usr/bin/env node
/**
 * Tenant-scope lint (Phase 19 — FORENSIC-AUDIT M-9 / S-1, the app-layer half).
 *
 * Postgres RLS is deferred to its own phase (it needs a per-transaction GUC
 * threaded through ~320 call sites + a second DB role — see ADR-0035). Until
 * then this is the backstop: every list/bulk/aggregate query on a tenant table
 * in `packages/services/src` must reference `organizationId` (or carry an
 * explicit `// tenant-scope-ok: <reason>` opt-out).
 *
 *   node scripts/check-tenant-scope.mjs          # fails CI on a violation
 *
 * Heuristic (deliberately conservative): only flags `findMany | findFirst |
 * updateMany | deleteMany | aggregate | groupBy | count` — not `findUnique` /
 * `create` / `upsert`, which are addressed by a primary/unique key.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages', 'services', 'src');

// Prisma model accessors that carry an organizationId column.
const TENANT_MODELS = new Set([
  'oAuthConnection',
  'youTubeChannel',
  'youTubeVideo',
  'youTubeMetric',
  'youTubeSyncRun',
  'agentRun',
  'recommendation',
  'contentIdea',
  'tikTokAccount',
  'tikTokVideo',
  'tikTokMetric',
  'tikTokSyncRun',
  'tikTokPublish',
  'website',
  'crawl',
  'crawlPage',
  'crawlLink',
  'crawlIssue',
  'aIConversation',
  'aIMessage',
  'orgMemory',
  'task',
  'repurposeProject',
  'contentAsset',
  'contentAssetVersion',
  'monetizationOpportunity',
  'revenueEntry',
  'businessProfile',
  'subscription',
  'entitlement',
  'usageRecord',
  'usageCounter',
  'invoice',
  'report',
  'automationRule',
  'automationRun',
  'notification',
  'searchConsoleSite',
  'searchConsoleSnapshot',
  'knowledgeSource',
  'knowledgeItem',
  'knowledgeEvidence',
  'knowledgeEmbedding',
  'knowledgeRelation',
  'knowledgeConflict',
  'memoryCandidate',
  'researchProject',
  'researchQuery',
  'researchFinding',
  'researchCitation',
  // Phase 12 — closed a real gap: these tenant-scoped models (Phases 1, 2, 5,
  // 6-10) were never added to this allowlist, so every query against them
  // was silently unchecked by this lint the whole time. `securityEvent` and
  // `errorEvent` are deliberately NOT added — both are documented as
  // person-/platform-centric and legitimately queried across organizations
  // (see their own schema doc comments).
  'agentRunEvent',
  'aiGovernancePolicy',
  'apiKey',
  'auditLog',
  'growthMission',
  'integrationActionRequest',
  'integrationSyncRun',
  'invitation',
  'mcpServer',
  'mcpServerTool',
  'membership',
  'missionEvent',
  'missionLearning',
  'missionMetric',
  'missionMilestone',
  'missionTask',
  'tikTokContentPlan',
  'tikTokExperiment',
  'tikTokOpportunity',
  'wordPressContent',
  'wordPressSite',
  'youTubeCalendarEntry',
  'youTubeExperiment',
  'youTubeOpportunity',
  // Phase 13 — new tenant-scoped billing models, added at the same time
  // they were introduced (learning from Phase 12's own gap: don't let a
  // new model go unchecked from the start).
  'creditTransaction',
  'enterpriseContract',
]);

const RISKY = 'findMany|findFirst|updateMany|deleteMany|aggregate|groupBy|count';
const WINDOW = 900;

// `packages/services/src/observability` is the platform-staff admin surface —
// its reads are cross-organization BY DESIGN (behind `requirePlatformStaff()`).
const EXEMPT_DIRS = [join('services', 'src', 'observability')];

// A query is considered scoped if any of these appear nearby: a direct
// organizationId filter, OR a FK column that is itself resolved from an
// org-scoped parent earlier in the same function (crawlId ← resolveCrawl,
// channelId ← org-scoped channel load, …), OR an explicit opt-out.
const SCOPE_HINT =
  /organizationId|orgId|tenant-scope-ok|crawlId|websiteId|youTubeChannelId|tikTokAccountId|conversationId|repurposeProjectId|contentAssetId|automationRuleId|oauthConnectionId/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const modelAlt = [...TENANT_MODELS].join('|');
const callRe = new RegExp(`\\b(?:prisma|db|tx|client)\\.(${modelAlt})\\.(${RISKY})\\b`, 'g');

const violations = [];
for (const file of walk(SRC)) {
  if (EXEMPT_DIRS.some((d) => file.includes(d))) continue;
  const text = readFileSync(file, 'utf8');
  let m;
  while ((m = callRe.exec(text))) {
    const start = Math.max(0, m.index - WINDOW);
    const end = Math.min(text.length, m.index + WINDOW);
    const ctx = text.slice(start, end);
    if (SCOPE_HINT.test(ctx)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    violations.push({
      file: relative(ROOT, file),
      line,
      call: `${m[1]}.${m[2]}`,
    });
  }
}

if (violations.length) {
  console.error(`\n  ✗ ${violations.length} tenant query without a nearby organizationId:\n`);
  for (const v of violations) {
    console.error(`   ${v.file}:${v.line}  ${v.call}`);
  }
  console.error(
    `\n  Scope the query by organizationId, or add "// tenant-scope-ok: <reason>" next to it.\n`,
  );
  process.exit(1);
}

console.log('  ✓ every tenant list/bulk/aggregate query in packages/services is org-scoped');
process.exit(0);
