/**
 * Mission metrics (Phase 10, §9/§10/§23) — every value stored here must come
 * from a real read (Search Console, YouTube/TikTok analytics, a crawl, or a
 * user-entered figure); this module never synthesizes one. `trend` is
 * derived only from the two most recent real points for the same key —
 * "not enough data yet" is a valid, honestly-reported answer.
 */
import { type Db, type MissionMetricKind, prisma } from '@growth-agent/db';
import { recordMissionEvent } from './events.js';
import type { MissionSuccessMetricDef } from './schemas.js';

export interface RecordMetricInput {
  organizationId: string;
  missionId: string;
  key: string;
  label: string;
  kind: MissionMetricKind;
  unit?: string;
  currentValue: number | null;
  targetValue?: number | null;
  source: string;
}

const FLAT_EPSILON = 0.02; // a <2% relative move reads as "flat", not noise-as-trend

export function computeTrend(previous: number | null, current: number | null): 'up' | 'down' | 'flat' | null {
  if (previous == null || current == null) return null;
  if (previous === 0) return current === 0 ? 'flat' : current > 0 ? 'up' : 'down';
  const relChange = (current - previous) / Math.abs(previous);
  if (Math.abs(relChange) < FLAT_EPSILON) return 'flat';
  return relChange > 0 ? 'up' : 'down';
}

export async function recordMissionMetric(input: RecordMetricInput, db: Db = prisma) {
  // Ordered by measuredAt, then createdAt as a tiebreaker: two measurements
  // recorded within the same millisecond (a real possibility — e.g. two
  // rapid mission-loop ticks) would otherwise have no defined "most recent"
  // row, in this harness or in real Postgres alike.
  const previous = await db.missionMetric.findFirst({
    where: { missionId: input.missionId, key: input.key },
    orderBy: [{ measuredAt: 'desc' }, { createdAt: 'desc' }],
  });
  const previousValue = previous ? (previous.currentValue) : null;
  const trend = computeTrend(previousValue, input.currentValue);

  const row = await db.missionMetric.create({
    data: {
      organizationId: input.organizationId,
      missionId: input.missionId,
      key: input.key,
      label: input.label,
      kind: input.kind,
      unit: input.unit ?? null,
      currentValue: input.currentValue,
      previousValue,
      targetValue: input.targetValue ?? null,
      trend,
      source: input.source,
    },
  });
  await recordMissionEvent(
    {
      missionId: input.missionId,
      organizationId: input.organizationId,
      type: 'METRIC_UPDATED',
      metadata: { key: input.key, currentValue: input.currentValue, trend },
    },
    db,
  );
  return row;
}

export interface MetricProgress {
  key: string;
  label: string;
  kind: MissionMetricKind;
  current: number | null;
  previous: number | null;
  target: number | null;
  trend: 'up' | 'down' | 'flat' | null;
  /** 0-1, only when a target is set and a current value exists; null
   *  otherwise — never fabricated as 0 or 100. */
  progressToTarget: number | null;
}

/** The latest real measurement per metric key for a mission — the "Current /
 *  Change / Progress / Trend" view the brief asks for (§9). */
export async function getMissionMetricProgress(
  organizationId: string,
  missionId: string,
  db: Db = prisma,
): Promise<MetricProgress[]> {
  const rows = await db.missionMetric.findMany({
    where: { organizationId, missionId },
    orderBy: [{ measuredAt: 'desc' }, { createdAt: 'desc' }],
  });
  const latestByKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latestByKey.has(r.key)) latestByKey.set(r.key, r);

  return [...latestByKey.values()].map((r) => {
    const current = r.currentValue;
    const target = r.targetValue;
    return {
      key: r.key,
      label: r.label,
      kind: r.kind,
      current,
      previous: r.previousValue,
      target,
      trend: r.trend as MetricProgress['trend'],
      progressToTarget:
        target != null && target !== 0 && current != null
          ? Math.max(0, Math.min(1, current / target))
          : null,
    };
  });
}

/** True only when every mission-defined success metric with a target has a
 *  latest real measurement that meets or exceeds it — never declared true
 *  from a lagging metric that simply hasn't moved yet (§10). */
export async function allSuccessMetricsMet(
  organizationId: string,
  missionId: string,
  definitions: MissionSuccessMetricDef[],
  db: Db = prisma,
): Promise<boolean> {
  const withTargets = definitions.filter((d) => d.targetValue != null);
  if (withTargets.length === 0) return false;
  const progress = await getMissionMetricProgress(organizationId, missionId, db);
  return withTargets.every((def) => {
    const p = progress.find((x) => x.key === def.key);
    return p?.current != null && def.targetValue != null && p.current >= def.targetValue;
  });
}
