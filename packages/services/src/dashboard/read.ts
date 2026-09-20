/**
 * Dashboard read model (Phase 3, Part 8). A pure aggregation over existing
 * tenant-scoped reads — no new schema, no new business logic. Every number
 * here is a real query result; there is no synthetic/demo data path.
 */
import { type Db, prisma } from '@growth-agent/db';
import { loadOrgContext, type OrgContext } from '../agent/context.js';
import {
  getConnectionCenter,
  summarizeCenter,
  type ConnectionCenterEntry,
} from '../integrations/center.js';
import { listAutomations } from '../automation/rules.js';
import { unreadCount } from '../notifications/index.js';

export interface RecentAgentRun {
  id: string;
  agent: string;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface DashboardSummary {
  context: OrgContext;
  connections: ConnectionCenterEntry[];
  connectionSummary: ReturnType<typeof summarizeCenter>;
  activeAutomations: number;
  totalAutomations: number;
  unreadNotifications: number;
  recentAgentRuns: RecentAgentRun[];
}

export async function getDashboardSummary(
  organizationId: string,
  userId: string,
  db: Db = prisma,
): Promise<DashboardSummary> {
  const [context, connections, automations, unread, recentAgentRuns] = await Promise.all([
    loadOrgContext(organizationId, db),
    getConnectionCenter(organizationId, new Date(), db),
    listAutomations(organizationId, db),
    unreadCount(organizationId, userId, db),
    db.agentRun.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, agent: true, status: true, createdAt: true, finishedAt: true },
    }),
  ]);

  return {
    context,
    connections,
    connectionSummary: summarizeCenter(connections),
    activeAutomations: automations.filter((a) => a.status === 'ACTIVE').length,
    totalAutomations: automations.length,
    unreadNotifications: unread,
    recentAgentRuns,
  };
}
