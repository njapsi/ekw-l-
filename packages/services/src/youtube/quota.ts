import { type Db, prisma } from '@growth-agent/db';
import { getHealth } from '../integrations/health.js';
import { QuotaExceededError } from './client.js';

/**
 * Google's YouTube Data API project quota is a single shared daily pool
 * (default 10,000 units). We reserve a per-connection slice so one noisy
 * organization cannot starve the rest, and refuse a sync step that would blow
 * the slice — `respect API quotas`, `do not make unnecessary API requests`.
 */
export function perConnectionDailyBudget(): number {
  const n = Number(process.env.YOUTUBE_ORG_DAILY_QUOTA ?? '2000');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

export interface QuotaCheck {
  usedToday: number;
  budget: number;
  remaining: number;
}

export async function quotaStatus(oauthConnectionId: string, db: Db = prisma): Promise<QuotaCheck> {
  const health = await getHealth(oauthConnectionId, db);
  const now = Date.now();
  const rolledOver = !health?.quotaResetAt || health.quotaResetAt.getTime() <= now;
  const usedToday = rolledOver ? 0 : (health?.quotaUnitsUsedToday ?? 0);
  const budget = perConnectionDailyBudget();
  return { usedToday, budget, remaining: Math.max(0, budget - usedToday) };
}

/** Throw `QuotaExceededError` if spending `units` more would exceed the slice. */
export async function assertQuota(
  oauthConnectionId: string,
  units: number,
  db: Db = prisma,
): Promise<void> {
  const { remaining } = await quotaStatus(oauthConnectionId, db);
  if (units > remaining) {
    throw new QuotaExceededError(
      `perConnectionDailyBudget (${remaining} units left today, need ${units})`,
    );
  }
}
