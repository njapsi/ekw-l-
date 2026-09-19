import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import {
  DEFAULT_POLICY,
  GovernancePolicySchema,
  assertAutomationAllowed,
  decide,
  getGovernancePolicy,
  updateGovernancePolicy,
} from './index.js';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.membership.create({
    data: { userId: 'admin', organizationId: 'o1', role: 'ADMIN', status: 'ACTIVE' },
  });
  await db.membership.create({
    data: { userId: 'mgr', organizationId: 'o1', role: 'MANAGER', status: 'ACTIVE' },
  });
});

function clone() {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY)) as typeof DEFAULT_POLICY;
}

describe('policy schema', () => {
  it('can never express automatic publishing, modification or deletion', () => {
    for (const cls of ['modify', 'publish', 'delete'] as const) {
      const p = clone() as unknown as Record<string, Record<string, Record<string, string>>>;
      (p.integrations as Record<string, Record<string, string>>).WORDPRESS![cls] = 'automatic';
      expect(GovernancePolicySchema.safeParse(p).success).toBe(false);
    }
  });

  it('accepts the defaults', () => {
    expect(GovernancePolicySchema.safeParse(DEFAULT_POLICY).success).toBe(true);
  });
});

describe('decide', () => {
  it('always requires approval for publish, even if the policy allows it', () => {
    expect(decide(DEFAULT_POLICY, 'WORDPRESS', 'publish', { viaAgent: false })).toEqual({
      allowed: true,
      requiresApproval: true,
    });
  });

  it('disabled blocks every source', () => {
    const p = clone();
    p.integrations.WORDPRESS.draft = 'disabled';
    expect(decide(p, 'WORDPRESS', 'draft', { viaAgent: false }).allowed).toBe(false);
  });

  it('agentAllowed=false blocks the agent but not people', () => {
    const p = clone();
    p.integrations.YOUTUBE.agentAllowed = false;
    expect(decide(p, 'YOUTUBE', 'analyze', { viaAgent: true }).allowed).toBe(false);
    expect(decide(p, 'YOUTUBE', 'analyze', { viaAgent: false }).allowed).toBe(true);
  });

  it('approval_required on drafts routes them through approval', () => {
    const p = clone();
    p.integrations.WORDPRESS.draft = 'approval_required';
    expect(decide(p, 'WORDPRESS', 'draft', { viaAgent: true })).toEqual({
      allowed: true,
      requiresApproval: true,
    });
  });
});

describe('storage', () => {
  it('falls back to defaults when nothing is stored', async () => {
    expect(await getGovernancePolicy('o1', asDb)).toEqual(DEFAULT_POLICY);
  });

  it('falls back to defaults (never looser) when a stored policy is invalid', async () => {
    await db.aiGovernancePolicy.create({ data: { organizationId: 'o1', policy: { version: 99 } } });
    expect(await getGovernancePolicy('o1', asDb)).toEqual(DEFAULT_POLICY);
  });

  it('only agent.configure holders may change it, and changes are validated', async () => {
    const p = clone();
    p.integrations.TIKTOK.agentAllowed = false;
    await expect(updateGovernancePolicy('mgr', 'o1', p, asDb)).rejects.toThrow();
    await updateGovernancePolicy('admin', 'o1', p, asDb);
    expect((await getGovernancePolicy('o1', asDb)).integrations.TIKTOK.agentAllowed).toBe(false);
    const bad = clone() as unknown as { integrations: { WORDPRESS: { publish: string } } };
    bad.integrations.WORDPRESS.publish = 'automatic';
    await expect(updateGovernancePolicy('admin', 'o1', bad, asDb)).rejects.toThrow();
  });
});

describe('automation guardrails', () => {
  it('enforces allowed task types and the minimum interval', async () => {
    const p = clone();
    p.automation.allowedTaskTypes = ['GROWTH_REPORT'];
    p.automation.minIntervalMinutes = 120;
    await updateGovernancePolicy('admin', 'o1', p, asDb);
    await expect(assertAutomationAllowed('o1', 'WEBSITE_CRAWL', 1440, asDb)).rejects.toThrow(
      /not allowed/,
    );
    await expect(assertAutomationAllowed('o1', 'GROWTH_REPORT', 60, asDb)).rejects.toThrow(
      /every 120 minutes/,
    );
    await expect(
      assertAutomationAllowed('o1', 'GROWTH_REPORT', 1440, asDb),
    ).resolves.toBeUndefined();
  });
});
