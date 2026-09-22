import { describe, expect, it } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { detectPlatformOverlap } from './conflict.js';

describe('detectPlatformOverlap', () => {
  let db: MemoryDb;
  let asDb: Db;

  function setup() {
    db = createMemoryDb();
    asDb = db as unknown as Db;
  }

  it('reports no conflicts when no other mission is active', async () => {
    setup();
    const conflicts = await detectPlatformOverlap('org_1', { id: 'm1', allowedPlatforms: ['YOUTUBE'] }, asDb);
    expect(conflicts).toEqual([]);
  });

  it('flags an overlapping platform with another active mission, never silently resolving it', async () => {
    setup();
    await db.growthMission.create({
      data: { id: 'm2', organizationId: 'org_1', status: 'ACTIVE', name: 'Publish more', allowedPlatforms: ['WORDPRESS'] },
    });
    const conflicts = await detectPlatformOverlap(
      'org_1',
      { id: 'm1', allowedPlatforms: ['WORDPRESS', 'YOUTUBE'] },
      asDb,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ otherMissionId: 'm2', overlappingPlatforms: ['WORDPRESS'] });
  });

  it('does not flag a non-overlapping platform set', async () => {
    setup();
    await db.growthMission.create({
      data: { id: 'm2', organizationId: 'org_1', status: 'ACTIVE', name: 'TikTok mission', allowedPlatforms: ['TIKTOK'] },
    });
    const conflicts = await detectPlatformOverlap('org_1', { id: 'm1', allowedPlatforms: ['YOUTUBE'] }, asDb);
    expect(conflicts).toEqual([]);
  });

  it('ignores a mission from a different organization', async () => {
    setup();
    await db.growthMission.create({
      data: { id: 'm2', organizationId: 'org_evil', status: 'ACTIVE', name: 'Other org', allowedPlatforms: ['YOUTUBE'] },
    });
    const conflicts = await detectPlatformOverlap('org_1', { id: 'm1', allowedPlatforms: ['YOUTUBE'] }, asDb);
    expect(conflicts).toEqual([]);
  });

  it('ignores a PAUSED/COMPLETED mission — only ACTIVE ones can conflict', async () => {
    setup();
    await db.growthMission.create({
      data: { id: 'm2', organizationId: 'org_1', status: 'COMPLETED', name: 'Done', allowedPlatforms: ['YOUTUBE'] },
    });
    const conflicts = await detectPlatformOverlap('org_1', { id: 'm1', allowedPlatforms: ['YOUTUBE'] }, asDb);
    expect(conflicts).toEqual([]);
  });

  it('CROSS_PLATFORM on either side counts as an overlap with anything', async () => {
    setup();
    await db.growthMission.create({
      data: { id: 'm2', organizationId: 'org_1', status: 'ACTIVE', name: 'Broad mission', allowedPlatforms: ['CROSS_PLATFORM'] },
    });
    const conflicts = await detectPlatformOverlap('org_1', { id: 'm1', allowedPlatforms: ['SEO'] }, asDb);
    expect(conflicts).toHaveLength(1);
  });
});
