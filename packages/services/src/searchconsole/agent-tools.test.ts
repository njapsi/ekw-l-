import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { bindGscAgentTools } from './agent-tools.js';

const perfSnapshot = {
  id: 'snap_1',
  capturedAt: new Date('2026-09-10'),
  rangeEnd: new Date('2026-09-08'),
  data: {
    rangeDays: 28,
    totals: { clicks: 100, impressions: 5000, ctr: 0.02, position: 9 },
    byDate: [],
    byQuery: [{ keys: ['a'], clicks: 50, impressions: 3000, ctr: 0.016, position: 8 }],
    byPage: [{ keys: ['https://x.com/a'], clicks: 50, impressions: 3000, ctr: 0.016, position: 8 }],
    byCountry: [],
    byDevice: [],
    bySearchAppearance: [],
  },
};

function db(withProperty: boolean, withSnapshot = true): Db {
  return {
    searchConsoleSite: {
      findFirst: vi.fn(async () =>
        withProperty
          ? {
              id: 'site_1',
              organizationId: 'org_1',
              siteUrl: 'sc-domain:x.com',
              permissionLevel: 'SITE_OWNER',
              propertyType: 'DOMAIN',
            }
          : null,
      ),
    },
    searchConsoleSnapshot: {
      findFirst: vi.fn(async () => (withSnapshot ? perfSnapshot : null)),
      findMany: vi.fn(async () => []),
    },
  } as unknown as Db;
}

describe('GSC agent tools', () => {
  it('return { available: false } when no property is connected/selected — never throw, never invent', async () => {
    const tools = bindGscAgentTools({ organizationId: 'org_1', db: db(false) });
    for (const r of await Promise.all([
      tools.get_property({ hostname: 'x.com' }),
      tools.get_performance({ hostname: 'x.com' }),
      tools.get_top_queries({ hostname: 'x.com', limit: 10 }),
      tools.get_top_pages({ hostname: 'x.com', limit: 10 }),
      tools.get_sitemaps({ hostname: 'x.com' }),
    ])) {
      expect(r).toMatchObject({ available: false });
      expect(r).toHaveProperty('reason');
    }
  });

  it('return { available: false } when the property exists but has no performance snapshot', async () => {
    const tools = bindGscAgentTools({ organizationId: 'org_1', db: db(true, false) });
    expect(await tools.get_performance({ hostname: 'x.com' })).toMatchObject({ available: false });
  });

  it('surface Google’s own figures from the snapshot when available', async () => {
    const tools = bindGscAgentTools({ organizationId: 'org_1', db: db(true) });
    const perf = (await tools.get_performance({ hostname: 'x.com' })) as {
      available: true;
      totals: { impressions: number };
      dataThrough: string | null;
    };
    expect(perf.available).toBe(true);
    expect(perf.totals.impressions).toBe(5000);
    expect(perf.dataThrough).toBe('2026-09-08');

    const top = (await tools.get_top_pages({ hostname: 'x.com', limit: 5 })) as {
      pages: Array<{ url: string; impressions: number }>;
    };
    expect(top.pages[0]).toEqual(
      expect.objectContaining({ url: 'https://x.com/a', impressions: 3000 }),
    );
  });
});
