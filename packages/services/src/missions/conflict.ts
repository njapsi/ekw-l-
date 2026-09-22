/**
 * Mission conflict detection (Phase 10, §35) — deliberately narrow: it flags
 * the one conflict signal that can be established as a plain fact without
 * parsing free-text constraints (e.g. "5 articles/week" vs. "2/week" is not
 * mechanically comparable without guessing at intent). Two ACTIVE missions
 * in the same org that both target an overlapping platform is a real,
 * checkable overlap; the system flags it for a human to resolve rather than
 * silently picking an order or blocking activation outright.
 */
import { type Db, prisma } from '@growth-agent/db';
import type { MissionPlatformKey } from './schemas.js';

export interface MissionConflict {
  otherMissionId: string;
  otherMissionName: string;
  overlappingPlatforms: MissionPlatformKey[];
}

export async function detectPlatformOverlap(
  organizationId: string,
  mission: { id: string; allowedPlatforms: MissionPlatformKey[] },
  db: Db = prisma,
): Promise<MissionConflict[]> {
  const others = await db.growthMission.findMany({
    where: { organizationId, status: 'ACTIVE', id: { not: mission.id } },
    select: { id: true, name: true, allowedPlatforms: true },
  });
  const mine = new Set(mission.allowedPlatforms);
  const conflicts: MissionConflict[] = [];
  for (const other of others) {
    const theirs = other.allowedPlatforms as MissionPlatformKey[];
    const overlap = theirs.filter((p) => mine.has(p) || p === 'CROSS_PLATFORM' || mine.has('CROSS_PLATFORM'));
    if (overlap.length > 0) {
      conflicts.push({ otherMissionId: other.id, otherMissionName: other.name, overlappingPlatforms: overlap });
    }
  }
  return conflicts;
}
