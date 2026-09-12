import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import {
  approveAsset,
  editAsset,
  markAssetFailed,
  markAssetPublished,
  regenerateAsset,
  resetAssetToDraft,
  revertAsset,
  scheduleAsset,
} from './assets.js';

function fakeDb(over: { status?: string } = {}) {
  const asset: any = {
    id: 'a1',
    organizationId: 'org_1',
    type: 'YT_DESCRIPTION',
    platform: 'youtube',
    title: 'YouTube description',
    status: over.status ?? 'DRAFT',
    currentVersionId: 'v1',
    approvedById: null,
    approvedAt: null,
    scheduledFor: null,
    publishedAt: null,
    failureReason: null,
    currentVersion: {
      id: 'v1',
      versionNumber: 1,
      body: 'original body',
      structured: { body: 'original body', keyIdeaIds: ['k1'] },
    },
    project: {
      id: 'p1',
      name: 'Proj',
      analysis: {
        summary: 's',
        keyIdeas: [{ id: 'k1', idea: 'idea one' }],
        contentAngles: [{ id: 'x', angle: 'a', rationale: 'r', keyIdeaIds: ['k1'] }],
        topics: ['t'],
        keywords: ['kw'],
        audienceTakeaways: [],
        contentType: 'x',
        tone: 'y',
        disclaimers: [],
      },
    },
  };
  const versions: any[] = [asset.currentVersion];
  const audit: any[] = [];
  return {
    asset,
    versions,
    audit,
    contentAsset: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === asset.id && where.organizationId === asset.organizationId ? asset : null,
      ),
      findUnique: vi.fn(async () => asset),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(asset, data);
        return asset;
      }),
    },
    contentAssetVersion: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        if (orderBy?.versionNumber === 'desc') {
          return [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;
        }
        return versions.find((v) => v.versionNumber === where.versionNumber) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `v${versions.length + 1}`, ...data };
        versions.push(row);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audit.push(data);
        return {};
      }),
    },
  };
}

const base = { organizationId: 'org_1', userId: 'u1', assetId: 'a1' };

describe('content asset lifecycle + status machine', () => {
  it('an edit appends v2, points currentVersion at it, and (from APPROVED) resets to DRAFT', async () => {
    const db = fakeDb({ status: 'APPROVED' });
    db.asset.approvedById = 'u1';
    await editAsset({ ...base, body: 'my edited body', editSummary: 'tweak' }, db as never);
    const v2 = db.versions.find((v) => v.versionNumber === 2);
    expect(v2).toMatchObject({ body: 'my edited body', editedById: 'u1' });
    expect(db.asset.currentVersionId).toBe(v2.id);
    expect(db.asset.status).toBe('DRAFT');
    expect(db.asset.approvedById).toBeNull();
    expect(db.audit.some((a) => a.action === 'content.asset.edited')).toBe(true);
  });

  it('approve only works from DRAFT', async () => {
    const draft = fakeDb();
    const r = await approveAsset(base, draft as never);
    expect(r.status).toBe('APPROVED');
    expect(r.approvedById).toBe('u1');

    const published = fakeDb({ status: 'PUBLISHED' });
    await expect(approveAsset(base, published as never)).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'validation_failed',
    );
  });

  it('schedule requires APPROVED and a future time', async () => {
    const draft = fakeDb();
    await expect(
      scheduleAsset({ ...base, scheduledFor: new Date(Date.now() + 3600_000) }, draft as never),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');

    const approved = fakeDb({ status: 'APPROVED' });
    await expect(
      scheduleAsset({ ...base, scheduledFor: new Date(Date.now() - 1000) }, approved as never),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');

    const ok = fakeDb({ status: 'APPROVED' });
    const when = new Date(Date.now() + 86_400_000);
    const r = await scheduleAsset({ ...base, scheduledFor: when }, ok as never);
    expect(r.status).toBe('SCHEDULED');
    expect(r.scheduledFor).toEqual(when);
  });

  it('markPublished is a status marker only (the engine never publishes) and needs APPROVED/SCHEDULED', async () => {
    const draft = fakeDb();
    await expect(markAssetPublished(base, draft as never)).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'validation_failed',
    );

    const approved = fakeDb({ status: 'APPROVED' });
    const r = await markAssetPublished({ ...base, target: 'manual' }, approved as never);
    expect(r.status).toBe('PUBLISHED');
    expect(r.publishedAt).toBeInstanceOf(Date);
    expect(r.publishTarget).toBe('manual');
    expect(approved.audit.some((a) => a.action === 'content.asset.published_marked')).toBe(true);
  });

  it('markFailed and resetToDraft', async () => {
    const db = fakeDb({ status: 'SCHEDULED' });
    const failed = await markAssetFailed({ ...base, reason: 'link broke' }, db as never);
    expect(failed.status).toBe('FAILED');
    expect(failed.failureReason).toBe('link broke');
    const reset = await resetAssetToDraft(base, db as never);
    expect(reset.status).toBe('DRAFT');
    expect(reset.failureReason).toBeNull();
  });

  it('revert appends a copy of an earlier version', async () => {
    const db = fakeDb({ status: 'APPROVED' });
    await editAsset({ ...base, body: 'v2 body' }, db as never); // creates v2, resets to DRAFT
    await revertAsset({ ...base, versionNumber: 1 }, db as never); // appends v3 = copy of v1
    const v3 = db.versions.find((v) => v.versionNumber === 3);
    expect(v3.body).toBe('original body');
    expect(v3.editSummary).toMatch(/Reverted to v1/);
  });

  it('regenerate without a model keeps the body and appends a version', async () => {
    const db = fakeDb();
    await regenerateAsset({ db: db as never }, { ...base, instructions: 'punchier' });
    const v2 = db.versions.find((v) => v.versionNumber === 2);
    expect(v2.editedById).toBeNull();
    expect(v2.body).toMatch(/original body/);
    expect(v2.body).toMatch(/no AI provider/i);
  });

  it('every op is tenant-scoped', async () => {
    const db = fakeDb();
    await expect(approveAsset({ ...base, organizationId: 'org_2' }, db as never)).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === 'resource_not_found',
    );
  });
});
