import { type Db, prisma } from '@growth-agent/db';

export interface HealthUpdate {
  ok: boolean;
  detail?: string;
  quotaUnitsUsedToday?: number;
  quotaResetAt?: Date;
}

/** Record the outcome of a health probe or a sync for a connection. */
export async function recordHealth(
  oauthConnectionId: string,
  update: HealthUpdate,
  db: Db = prisma,
): Promise<void> {
  await db.integrationHealth.upsert({
    where: { oauthConnectionId },
    update: { ...update, lastCheckAt: new Date() },
    create: { oauthConnectionId, ...update },
  });
}

/** Add consumed API-quota units to today's counter, rolling over at reset. */
export async function addQuotaUsage(
  oauthConnectionId: string,
  units: number,
  db: Db = prisma,
): Promise<void> {
  const now = new Date();
  const health = await db.integrationHealth.findUnique({ where: { oauthConnectionId } });
  const rolledOver = !health?.quotaResetAt || health.quotaResetAt.getTime() <= now.getTime();
  const nextReset = new Date(now);
  nextReset.setUTCHours(24, 0, 0, 0); // Google quota resets at midnight Pacific; UTC-midnight is a safe conservative proxy.

  await db.integrationHealth.upsert({
    where: { oauthConnectionId },
    update: {
      quotaUnitsUsedToday: rolledOver ? units : (health?.quotaUnitsUsedToday ?? 0) + units,
      quotaResetAt: rolledOver ? nextReset : health?.quotaResetAt,
    },
    create: { oauthConnectionId, quotaUnitsUsedToday: units, quotaResetAt: nextReset },
  });
}

export async function getHealth(oauthConnectionId: string, db: Db = prisma) {
  return db.integrationHealth.findUnique({ where: { oauthConnectionId } });
}
