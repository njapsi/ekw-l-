import { describe, expect, it, vi } from 'vitest';

const orgContext = { openTasks: 2, recentRecommendations: 3 } as any;
const connections = [{ state: 'CONNECTED' }] as any;
const connectionSummary = { connected: 1, needsAttention: 0, available: 4 };

vi.mock('../agent/context.js', () => ({
  loadOrgContext: vi.fn(async () => orgContext),
}));
vi.mock('../integrations/center.js', () => ({
  getConnectionCenter: vi.fn(async () => connections),
  summarizeCenter: vi.fn(() => connectionSummary),
}));
vi.mock('../automation/rules.js', () => ({
  listAutomations: vi.fn(async () => [
    { id: 'a1', status: 'ACTIVE' },
    { id: 'a2', status: 'PAUSED' },
    { id: 'a3', status: 'ACTIVE' },
  ]),
}));
vi.mock('../notifications/index.js', () => ({
  unreadCount: vi.fn(async () => 4),
}));

const agentRunRows = [
  {
    id: 'r1',
    agent: 'seo-auditor',
    status: 'COMPLETED',
    createdAt: new Date(),
    finishedAt: new Date(),
  },
];

function fakeDb() {
  return { agentRun: { findMany: vi.fn(async () => agentRunRows) } } as any;
}

describe('dashboard.getDashboardSummary', () => {
  it('composes existing tenant-scoped reads without inventing data', async () => {
    const { getDashboardSummary } = await import('./read.js');
    const db = fakeDb();
    const summary = await getDashboardSummary('org_1', 'user_1', db);

    expect(summary.context).toBe(orgContext);
    expect(summary.connections).toBe(connections);
    expect(summary.connectionSummary).toBe(connectionSummary);
    expect(summary.unreadNotifications).toBe(4);
    expect(summary.recentAgentRuns).toBe(agentRunRows);
    // Two of three seeded automation rules are ACTIVE.
    expect(summary.activeAutomations).toBe(2);
    expect(summary.totalAutomations).toBe(3);
  });
});
