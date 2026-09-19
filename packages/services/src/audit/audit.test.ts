import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { auditCategory, auditEventType, auditLabel } from './catalog.js';
import { exportAuditCsv, listAuditEvents } from './query.js';

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.membership.create({
    data: { userId: 'admin', organizationId: 'o1', role: 'ADMIN', status: 'ACTIVE' },
  });
  await db.membership.create({
    data: { userId: 'viewer', organizationId: 'o1', role: 'VIEWER', status: 'ACTIVE' },
  });
  await db.membership.create({
    data: { userId: 'mgr', organizationId: 'o1', role: 'MANAGER', status: 'ACTIVE' },
  });
  await db.auditLog.create({
    data: {
      organizationId: 'o1',
      action: 'integration.connected',
      actorType: 'USER',
      createdAt: new Date(),
      metadata: {},
      actor: null,
    },
  });
  await db.auditLog.create({
    data: {
      organizationId: 'o2',
      action: 'integration.connected',
      actorType: 'USER',
      createdAt: new Date(),
      metadata: {},
      actor: null,
    },
  });
});

describe('catalog', () => {
  it('maps stored actions onto the canonical enterprise event names', () => {
    expect(auditEventType('integration.connected')).toBe('INTEGRATION_CONNECTED');
    expect(auditEventType('integration.reconnected')).toBe('INTEGRATION_REAUTHORIZED');
    expect(auditEventType('member.role_changed')).toBe('ROLE_CHANGED');
    expect(auditEventType('seo.crawl.started')).toBe('SEO_CRAWL_STARTED');
    expect(auditEventType('something.new')).toBe('SOMETHING_NEW');
    expect(auditCategory('integration.action_approved')).toBe('ai');
    expect(auditLabel('api_key.created')).toBe('API key created');
  });
});

describe('listAuditEvents', () => {
  it('returns only the current organization’s events', async () => {
    const { events } = await listAuditEvents('admin', 'o1', {}, asDb);
    expect(events).toHaveLength(1);
  });

  it('requires audit.view (a viewer and a manager are refused)', async () => {
    await expect(listAuditEvents('viewer', 'o1', {}, asDb)).rejects.toThrow();
    await expect(listAuditEvents('mgr', 'o1', {}, asDb)).rejects.toThrow();
  });

  it('refuses a non-member', async () => {
    await expect(listAuditEvents('admin', 'o2', {}, asDb)).rejects.toThrow();
  });
});

describe('exportAuditCsv', () => {
  it('neutralises spreadsheet formula injection', async () => {
    await db.auditLog.create({
      data: {
        organizationId: 'o1',
        action: 'member.invited',
        actorType: 'USER',
        targetType: '=HYPERLINK("http://evil")',
        createdAt: new Date(),
        metadata: {},
        actor: null,
      },
    });
    const { csv } = await exportAuditCsv('admin', 'o1', {}, asDb);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).not.toMatch(/,"=HYPERLINK/);
  });
});
