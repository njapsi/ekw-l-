import { describe, expect, it, vi } from 'vitest';
import {
  ScAuthExpiredError,
  ScMalformedDataError,
  ScPermissionError,
  ScPropertyNotFoundError,
  ScQuotaExceededError,
  SearchConsoleApiError,
} from './client.js';
import { GoogleSearchConsoleClient } from './google-client.js';

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response;
}
const gErr = (reason: string, message = 'nope') => ({
  error: { code: 403, message, errors: [{ reason }] },
});

describe('GoogleSearchConsoleClient error mapping', () => {
  it('401 → ScAuthExpiredError', async () => {
    const c = new GoogleSearchConsoleClient(
      't',
      vi.fn(async () => res(401, gErr('authError'))),
    );
    await expect(c.listSites()).rejects.toBeInstanceOf(ScAuthExpiredError);
  });

  it('403 quota reason → ScQuotaExceededError; other 403 → ScPermissionError', async () => {
    const quota = new GoogleSearchConsoleClient(
      't',
      vi.fn(async () => res(403, gErr('quotaExceeded'))),
    );
    await expect(quota.listSites()).rejects.toBeInstanceOf(ScQuotaExceededError);

    const perm = new GoogleSearchConsoleClient(
      't',
      vi.fn(async () => res(403, gErr('forbidden'))),
    );
    await expect(perm.getSite('sc-domain:x.com')).rejects.toBeInstanceOf(ScPermissionError);
  });

  it('404 → ScPropertyNotFoundError', async () => {
    const c = new GoogleSearchConsoleClient(
      't',
      vi.fn(async () => res(404, gErr('notFound'))),
    );
    await expect(c.listSitemaps('https://x.com/')).rejects.toBeInstanceOf(ScPropertyNotFoundError);
  });

  it('non-JSON 200 / schema miss → ScMalformedDataError', async () => {
    const nonJson = new GoogleSearchConsoleClient(
      't',
      vi.fn(async () => res(200, '<html>')),
    );
    await expect(nonJson.listSites()).rejects.toBeInstanceOf(ScMalformedDataError);

    const badShape = new GoogleSearchConsoleClient(
      't',
      vi.fn(async () => res(200, { siteEntry: [{ nope: 1 }] })),
    );
    await expect(badShape.listSites()).rejects.toBeInstanceOf(ScMalformedDataError);
  });

  it('retries a 503 then succeeds', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      return n < 2 ? res(503, gErr('backendError')) : res(200, { siteEntry: [] });
    });
    const c = new GoogleSearchConsoleClient('t', fetchImpl);
    await expect(c.listSites()).resolves.toEqual({ siteEntry: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('percent-encodes siteUrl and posts the analytics body', async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      res(200, { rows: [] }),
    );
    const c = new GoogleSearchConsoleClient('tok', fetchImpl);
    await c.querySearchAnalytics({
      siteUrl: 'sc-domain:example.com',
      startDate: '2026-01-01',
      endDate: '2026-01-28',
      dimensions: ['query'],
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/sites/sc-domain%3Aexample.com/searchAnalytics/query');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.dimensions).toEqual(['query']);
    expect(body.startDate).toBe('2026-01-01');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('unknown non-JSON error status → SearchConsoleApiError', async () => {
    const c = new GoogleSearchConsoleClient(
      't',
      vi.fn(async () => res(400, gErr('badRequest'))),
    );
    await expect(c.listSites()).rejects.toBeInstanceOf(SearchConsoleApiError);
  });
});
