import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

const researchFetchMock = vi.fn();
vi.mock('./fetch.js', () => ({
  researchFetch: (...args: unknown[]) => researchFetchMock(...args),
}));

const runSearchMock = vi.fn(async (..._args: unknown[]) => ({
  available: false as const,
  reason: 'No web search provider is configured for this deployment.',
}));
vi.mock('./search.js', () => ({
  runSearch: (...args: unknown[]) => runSearchMock(...args),
}));

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  vi.clearAllMocks();
  runSearchMock.mockResolvedValue({
    available: false,
    reason: 'No web search provider is configured for this deployment.',
  });
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.organization.create({ data: { id: 'org_1', name: 'Org', slug: 'org' } });
});

async function makeProject(config: Record<string, unknown> = {}): Promise<{ id: string }> {
  const row = await db.researchProject.create({
    data: {
      organizationId: 'org_1',
      createdById: 'user_1',
      question: 'What are best practices for X?',
      status: 'REQUESTED',
      config,
    },
  });
  return { id: row.id as string };
}

describe('runResearchProject', () => {
  it('FAILS honestly with no seed URLs and no search provider — never fabricates a result', async () => {
    const { runResearchProject } = await import('./engine.js');
    const project = await makeProject({ seedUrls: [] });
    await runResearchProject('org_1', project.id, { db: asDb });
    const updated = await db.researchProject.findFirst({ where: { id: project.id } });
    expect(updated?.status).toBe('FAILED');
    expect(updated?.failureReason).toMatch(/no seed urls/i);
    expect(updated?.conclusion).toBeFalsy();
  });

  it('COMPLETES when every seed URL fetches successfully, creating a finding + citation per source', async () => {
    researchFetchMock.mockResolvedValue({
      ok: true,
      citation: {
        sourceUrl: 'https://example.com/a',
        title: 'Example',
        retrievedAt: new Date().toISOString(),
        excerpt: 'Some real fetched text about best practices.',
        excerptTruncated: false,
        contentHash: 'abc123',
      },
    });
    const { runResearchProject } = await import('./engine.js');
    const project = await makeProject({ seedUrls: ['https://example.com/a'], maxSources: 1 });
    await runResearchProject('org_1', project.id, { db: asDb });
    const updated = await db.researchProject.findFirst({ where: { id: project.id } });
    expect(updated?.status).toBe('COMPLETED');
    expect(db.researchFinding.rows).toHaveLength(1);
    expect(db.researchCitation.rows).toHaveLength(1);
  });

  it('is PARTIALLY_COMPLETED when some sources fail and others succeed', async () => {
    researchFetchMock
      .mockResolvedValueOnce({
        ok: true,
        citation: {
          sourceUrl: 'https://example.com/a',
          title: 'A',
          retrievedAt: new Date().toISOString(),
          excerpt: 'Real content.',
          excerptTruncated: false,
          contentHash: 'x',
        },
      })
      .mockResolvedValueOnce({ ok: false, reason: 'The page could not be reached.' });
    const { runResearchProject } = await import('./engine.js');
    const project = await makeProject({ seedUrls: ['https://example.com/a', 'https://example.com/b'], maxSources: 2 });
    await runResearchProject('org_1', project.id, { db: asDb });
    const updated = await db.researchProject.findFirst({ where: { id: project.id } });
    expect(updated?.status).toBe('PARTIALLY_COMPLETED');
  });

  it('FAILS when every seed URL fails to fetch, without pretending any source was gathered', async () => {
    researchFetchMock.mockResolvedValue({ ok: false, reason: 'blocked' });
    const { runResearchProject } = await import('./engine.js');
    const project = await makeProject({ seedUrls: ['https://example.com/a'], maxSources: 1 });
    await runResearchProject('org_1', project.id, { db: asDb });
    const updated = await db.researchProject.findFirst({ where: { id: project.id } });
    expect(updated?.status).toBe('FAILED');
    expect(db.researchFinding.rows).toHaveLength(0);
  });

  it('is a no-op if the project is not in REQUESTED status (idempotency guard)', async () => {
    const project = await makeProject({ seedUrls: [] });
    await db.researchProject.update({ where: { id: project.id }, data: { status: 'COMPLETED' } });
    const { runResearchProject } = await import('./engine.js');
    await runResearchProject('org_1', project.id, { db: asDb });
    expect(researchFetchMock).not.toHaveBeenCalled();
  });

  it('never fabricates a conclusion when no model is configured — findings only', async () => {
    researchFetchMock.mockResolvedValue({
      ok: true,
      citation: {
        sourceUrl: 'https://example.com/a',
        title: 'A',
        retrievedAt: new Date().toISOString(),
        excerpt: 'Real content.',
        excerptTruncated: false,
        contentHash: 'x',
      },
    });
    const { runResearchProject } = await import('./engine.js');
    const project = await makeProject({ seedUrls: ['https://example.com/a'], maxSources: 1 });
    await runResearchProject('org_1', project.id, { db: asDb });
    const updated = await db.researchProject.findFirst({ where: { id: project.id } });
    expect(updated?.conclusion).toBeFalsy();
    expect(db.knowledgeItem.rows).toHaveLength(0); // no synthesis → nothing stored as knowledge
  });
});
