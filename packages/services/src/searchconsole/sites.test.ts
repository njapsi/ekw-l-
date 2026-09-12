import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, OAuthConnection } from '@growth-agent/db';
import { isAppError } from '../errors.js';

const listSites = vi.fn();
vi.mock('./resilient-client.js', () => ({
  ResilientSearchConsoleClient: class {
    listSites = listSites;
  },
}));
vi.mock('../integrations/health.js', () => ({ recordHealth: vi.fn(async () => {}) }));
vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const { syncProperties, selectProperty, requireProperty, describeProperty, mapPermission } =
  await import('./sites.js');

interface SiteRow {
  id: string;
  organizationId: string;
  oauthConnectionId: string;
  siteUrl: string;
  isSelected: boolean;
  verified: boolean;
  permissionLevel: string;
}

function fakeDb(seed: SiteRow[] = []) {
  const rows = [...seed];
  let seq = rows.length;
  const db = {
    searchConsoleSite: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const found = rows.find(
          (r) =>
            r.organizationId === where.organizationId_siteUrl.organizationId &&
            r.siteUrl === where.organizationId_siteUrl.siteUrl,
        );
        if (found) {
          Object.assign(found, update);
          return found;
        }
        const row = { id: `s${++seq}`, isSelected: false, ...create } as SiteRow;
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of rows) {
          const orgOk = r.organizationId === where.organizationId;
          const notInOk = where.siteUrl?.notIn ? !where.siteUrl.notIn.includes(r.siteUrl) : true;
          const selOk = where.isSelected === undefined ? true : r.isSelected === where.isSelected;
          if (orgOk && notInOk && selOk) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      }),
      findFirst: vi.fn(
        async ({ where }: any) =>
          rows.find(
            (r) =>
              (where.id ? r.id === where.id : true) &&
              (where.organizationId ? r.organizationId === where.organizationId : true) &&
              (where.isSelected === undefined ? true : r.isSelected === where.isSelected),
          ) ?? null,
      ),
    },
  };
  return { db: db as unknown as Db, rows };
}

const conn = { id: 'conn_1', organizationId: 'org_1' } as OAuthConnection;

beforeEach(() => vi.clearAllMocks());

describe('describeProperty / mapPermission', () => {
  it('derives type + hostname', () => {
    expect(describeProperty('sc-domain:example.com')).toEqual({
      propertyType: 'DOMAIN',
      hostname: 'example.com',
    });
    expect(describeProperty('https://blog.example.com/')).toEqual({
      propertyType: 'URL_PREFIX',
      hostname: 'blog.example.com',
    });
  });
  it('maps Google permission strings', () => {
    expect(mapPermission('siteOwner')).toBe('SITE_OWNER');
    expect(mapPermission('siteUnverifiedUser')).toBe('SITE_UNVERIFIED_USER');
    expect(mapPermission(undefined)).toBe('UNKNOWN');
  });
});

describe('syncProperties', () => {
  it('upserts + dedupes + sets verified from permission level', async () => {
    listSites.mockResolvedValueOnce({
      siteEntry: [
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://x.com/', permissionLevel: 'siteUnverifiedUser' },
      ],
    });
    const { db, rows } = fakeDb();
    const n = await syncProperties(conn, 'https://app/cb', db);
    expect(n).toBe(2);
    expect(rows.find((r) => r.siteUrl === 'sc-domain:example.com')!.verified).toBe(true);
    expect(rows.find((r) => r.siteUrl === 'https://x.com/')!.verified).toBe(false);
  });

  it('marks a vanished property unverified', async () => {
    const { db, rows } = fakeDb([
      {
        id: 's1',
        organizationId: 'org_1',
        oauthConnectionId: 'conn_1',
        siteUrl: 'sc-domain:gone.com',
        isSelected: false,
        verified: true,
        permissionLevel: 'SITE_OWNER',
      },
    ]);
    listSites.mockResolvedValueOnce({ siteEntry: [] });
    await syncProperties(conn, 'https://app/cb', db);
    expect(rows[0]!.verified).toBe(false);
  });
});

describe('selectProperty / requireProperty', () => {
  const seed: SiteRow[] = [
    {
      id: 's1',
      organizationId: 'org_1',
      oauthConnectionId: 'c',
      siteUrl: 'a',
      isSelected: true,
      verified: true,
      permissionLevel: 'SITE_OWNER',
    },
    {
      id: 's2',
      organizationId: 'org_1',
      oauthConnectionId: 'c',
      siteUrl: 'b',
      isSelected: false,
      verified: true,
      permissionLevel: 'SITE_OWNER',
    },
    {
      id: 's3',
      organizationId: 'org_2',
      oauthConnectionId: 'c',
      siteUrl: 'c',
      isSelected: false,
      verified: true,
      permissionLevel: 'SITE_OWNER',
    },
  ];

  it('selects exactly one property for the org', async () => {
    const { db, rows } = fakeDb(seed.map((s) => ({ ...s })));
    await selectProperty('org_1', 's2', 'user_1', db);
    expect(
      rows.filter((r) => r.organizationId === 'org_1' && r.isSelected).map((r) => r.id),
    ).toEqual(['s2']);
  });

  it('refuses a property that belongs to another org (tenant isolation)', async () => {
    const { db } = fakeDb(seed.map((s) => ({ ...s })));
    await expect(selectProperty('org_1', 's3', 'user_1', db)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'resource_not_found',
    );
  });

  it('requireProperty is org-scoped', async () => {
    const { db } = fakeDb(seed.map((s) => ({ ...s })));
    await expect(requireProperty('org_2', 's1', db)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'resource_not_found',
    );
    await expect(requireProperty('org_1', 's1', db)).resolves.toMatchObject({ id: 's1' });
  });
});
