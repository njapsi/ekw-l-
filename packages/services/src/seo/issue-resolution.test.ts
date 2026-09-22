import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const fetchPage = vi.fn();
vi.mock('./fetch.js', () => ({ fetchPage: (...args: unknown[]) => fetchPage(...args) }));

const { verifyAndResolveIssue, tryVerifyAndResolveIssue } = await import('./issue-resolution.js');

function makeDb(issue: Record<string, unknown> | null, updateSpy = vi.fn(async () => ({}))) {
  return {
    crawlIssue: {
      findFirst: vi.fn(async () => issue),
      update: updateSpy,
    },
  } as unknown as Db;
}

function htmlWithMetaDescription(desc: string | null): string {
  return `<html><head><title>A title that is long enough</title>${desc ? `<meta name="description" content="${desc}">` : ''}</head><body>${'word '.repeat(50)}</body></html>`;
}

beforeEach(() => {
  fetchPage.mockReset();
});

describe('verifyAndResolveIssue', () => {
  it('throws not found for an issue that does not exist', async () => {
    const db = makeDb(null);
    await expect(
      verifyAndResolveIssue({ organizationId: 'org_1', issueId: 'missing' }, db),
    ).rejects.toThrow();
  });

  it('reports it cannot verify a code with no single-page check, without touching status', async () => {
    const update = vi.fn(async () => ({}));
    const db = makeDb(
      { id: 'i1', code: 'ORPHAN_PAGE', normalizedUrl: 'https://example.com/a', page: null, status: 'OPEN' },
      update,
    );
    const result = await verifyAndResolveIssue({ organizationId: 'org_1', issueId: 'i1' }, db);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/full site re-crawl/);
    expect(update).not.toHaveBeenCalled();
  });

  it('marks a resolved MISSING_META_DESCRIPTION issue as FIXED', async () => {
    fetchPage.mockResolvedValue({
      ok: true,
      finalUrl: 'https://example.com/a',
      isHtml: true,
      body: htmlWithMetaDescription('A real, present meta description that is a healthy length overall.'),
    });
    const update = vi.fn(async () => ({}));
    const db = makeDb(
      {
        id: 'i1',
        code: 'MISSING_META_DESCRIPTION',
        normalizedUrl: 'https://example.com/a',
        page: null,
        status: 'OPEN',
      },
      update,
    );
    const result = await verifyAndResolveIssue({ organizationId: 'org_1', issueId: 'i1' }, db);
    expect(result.verified).toBe(true);
    expect(result.resolved).toBe(true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'FIXED' } }));
  });

  it('leaves the issue open when it still reproduces', async () => {
    fetchPage.mockResolvedValue({
      ok: true,
      finalUrl: 'https://example.com/a',
      isHtml: true,
      body: htmlWithMetaDescription(null),
    });
    const update = vi.fn(async () => ({}));
    const db = makeDb(
      { id: 'i1', code: 'MISSING_META_DESCRIPTION', normalizedUrl: 'https://example.com/a', page: null, status: 'OPEN' },
      update,
    );
    const result = await verifyAndResolveIssue({ organizationId: 'org_1', issueId: 'i1' }, db);
    expect(result.verified).toBe(true);
    expect(result.resolved).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('marks a previously-FIXED issue REGRESSED if it reproduces again', async () => {
    fetchPage.mockResolvedValue({
      ok: true,
      finalUrl: 'https://example.com/a',
      isHtml: true,
      body: htmlWithMetaDescription(null),
    });
    const update = vi.fn(async () => ({}));
    const db = makeDb(
      { id: 'i1', code: 'MISSING_META_DESCRIPTION', normalizedUrl: 'https://example.com/a', page: null, status: 'FIXED' },
      update,
    );
    const result = await verifyAndResolveIssue({ organizationId: 'org_1', issueId: 'i1' }, db);
    expect(result.resolved).toBe(false);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REGRESSED' } }));
  });

  it('reports an honest failure when the page cannot be re-fetched', async () => {
    fetchPage.mockResolvedValue({ ok: false, reason: 'timeout', detail: 'took too long', redirects: [] });
    const db = makeDb({ id: 'i1', code: 'MISSING_TITLE', normalizedUrl: 'https://example.com/a', page: null, status: 'OPEN' });
    const result = await verifyAndResolveIssue({ organizationId: 'org_1', issueId: 'i1' }, db);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/timeout/);
  });
});

describe('tryVerifyAndResolveIssue', () => {
  it('never throws — returns null on failure', async () => {
    const db = makeDb(null);
    const result = await tryVerifyAndResolveIssue({ organizationId: 'org_1', issueId: 'missing' }, db);
    expect(result).toBeNull();
  });
});
