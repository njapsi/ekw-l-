import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '../errors.js';
import { analyzeProject } from './analyze.js';
import {
  approveAsset,
  editAsset,
  markAssetPublished,
  revertAsset,
  scheduleAsset,
} from './assets.js';
import { generateAssets } from './generate.js';
import { createRepurposeProject } from './ingest.js';
import { getProject, listAssetVersions } from './read.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
let reachable = false;

beforeAll(async () => {
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    reachable = false;
  }
});
afterAll(async () => {
  await prisma?.$disconnect();
});
const maybe = () => (reachable ? it : it.skip);

async function makeOrg(tag: string) {
  const org = await prisma!.organization.create({ data: { name: tag, slug: tag } });
  return org.id;
}

describe('content repurposing pipeline (integration)', () => {
  maybe()(
    'source → analyze → generate → edit → approve → schedule → mark published, with versions + audit',
    async () => {
      const orgId = await makeOrg(`content-${Date.now()}`);
      const project = await createRepurposeProject(
        {
          organizationId: orgId,
          userId: 'u1',
          source: {
            kind: 'manual',
            title: 'A year of consistent uploads',
            body:
              'Consistency beats intensity. A predictable schedule earns trust with the audience. ' +
              'Your thumbnail and title do most of the work before anyone watches. ' +
              'Batching production removes the friction that makes people quit. ' +
              'Reviewing your retention graph each week tells you where viewers drop off.',
          },
        },
        prisma!,
      );

      const analysis = await analyzeProject(
        { db: prisma! },
        { organizationId: orgId, projectId: project.id },
      );
      expect(analysis.analysis.keyIdeas.length).toBeGreaterThan(0);

      const gen = await generateAssets(
        { db: prisma! },
        {
          organizationId: orgId,
          userId: 'u1',
          projectId: project.id,
          types: ['YT_TITLE_ALTERNATIVES', 'YT_DESCRIPTION', 'SHORTS_IDEA', 'FAQ'],
        },
      );
      expect(gen.assetIds.length).toBeGreaterThanOrEqual(4);

      const detail = await getProject(orgId, project.id, prisma!);
      expect(detail!.assets.every((a) => a.status === 'DRAFT')).toBe(true);
      const asset = detail!.assets.find((a) => a.type === 'YT_DESCRIPTION')!;

      await editAsset(
        {
          organizationId: orgId,
          userId: 'u1',
          assetId: asset.id,
          body: 'My hand-edited description.',
        },
        prisma!,
      );
      const vs = await listAssetVersions(orgId, asset.id, prisma!);
      expect(vs.versions.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
      expect(vs.versions.find((v) => v.isCurrent)!.body).toBe('My hand-edited description.');

      await approveAsset({ organizationId: orgId, userId: 'u1', assetId: asset.id }, prisma!);
      const when = new Date(Date.now() + 86_400_000);
      await scheduleAsset(
        { organizationId: orgId, userId: 'u1', assetId: asset.id, scheduledFor: when },
        prisma!,
      );
      await markAssetPublished(
        { organizationId: orgId, userId: 'u1', assetId: asset.id, target: 'manual' },
        prisma!,
      );

      const after = await prisma!.contentAsset.findUnique({ where: { id: asset.id } });
      expect(after?.status).toBe('PUBLISHED');
      expect(after?.publishedAt).toBeTruthy();

      const v1Body = vs.versions.find((v) => v.versionNumber === 1)!.body;
      await revertAsset(
        { organizationId: orgId, userId: 'u1', assetId: asset.id, versionNumber: 1 },
        prisma!,
      );
      const reverted = await prisma!.contentAsset.findUnique({
        where: { id: asset.id },
        include: { currentVersion: true },
      });
      expect(reverted?.currentVersion?.versionNumber).toBe(3);
      expect(reverted?.currentVersion?.body).toBe(v1Body);
      expect(reverted?.status).toBe('DRAFT');

      const audits = await prisma!.auditLog.findMany({
        where: { organizationId: orgId, action: { startsWith: 'content.' } },
      });
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'content.project.created',
          'content.project.analyzed',
          'content.assets.generated',
          'content.asset.edited',
          'content.asset.approved',
          'content.asset.scheduled',
          'content.asset.published_marked',
          'content.asset.reverted',
        ]),
      );
    },
  );

  maybe()('refuses a project / asset from another org', async () => {
    const orgA = await makeOrg(`content-a-${Date.now()}`);
    const orgB = await makeOrg(`content-b-${Date.now()}`);
    const project = await createRepurposeProject(
      {
        organizationId: orgA,
        userId: 'u1',
        source: { kind: 'manual', body: 'A reasonably long body of source content to analyze.' },
      },
      prisma!,
    );
    await expect(
      analyzeProject({ db: prisma! }, { organizationId: orgB, projectId: project.id }),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });
});
