import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createUserSession, validateSession } from '../auth/sessions.js';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { changePassword, deactivateAccount, passwordPolicyError } from './account.js';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.user.create({
    data: { id: 'u1', email: 'u1@example.com', passwordHash: hashPassword('current-password') },
  });
});

describe('password policy (NIST 800-63B-4)', () => {
  it('uses length, not composition rules', () => {
    expect(passwordPolicyError('short')).toMatch(/at least 8/);
    expect(passwordPolicyError('alllowercaseisfine')).toBeNull();
    expect(passwordPolicyError('x'.repeat(129))).toMatch(/at most 128/);
  });
});

describe('changePassword', () => {
  it('requires the current password without a recent sign-in', async () => {
    await expect(
      changePassword(
        {
          userId: 'u1',
          newPassword: 'brand-new-password',
          recentAuth: false,
          currentSessionId: null,
        },
        {},
        asDb,
      ),
    ).rejects.toThrow(/current password is incorrect/);
    expect(db.securityEvent.rows.some((e) => e.type === 'AUTH_LOGIN_FAILED')).toBe(true);
  });

  it('accepts the correct current password and signs out every other session', async () => {
    const keep = await createUserSession({ userId: 'u1', authMethod: 'password' }, asDb);
    const other = await createUserSession({ userId: 'u1', authMethod: 'password' }, asDb);
    const res = await changePassword(
      {
        userId: 'u1',
        currentPassword: 'current-password',
        newPassword: 'brand-new-password',
        recentAuth: false,
        currentSessionId: keep.sessionId,
      },
      {},
      asDb,
    );
    expect(res.otherSessionsRevoked).toBe(1);
    expect((await validateSession('u1', other.sessionId, new Date(), asDb)).ok).toBe(false);
    expect((await validateSession('u1', keep.sessionId, new Date(), asDb)).ok).toBe(true);
    const row = await db.user.findUnique({ where: { id: 'u1' } });
    expect(verifyPassword('brand-new-password', row?.passwordHash as string)).toBe(true);
    expect(db.securityEvent.rows.some((e) => e.type === 'PASSWORD_CHANGED')).toBe(true);
  });

  it('a fresh sign-in (reset link) can set a new password without the old one', async () => {
    await changePassword(
      { userId: 'u1', newPassword: 'reset-password-1', recentAuth: true, currentSessionId: null },
      {},
      asDb,
    );
    const row = await db.user.findUnique({ where: { id: 'u1' } });
    expect(verifyPassword('reset-password-1', row?.passwordHash as string)).toBe(true);
  });

  it('refuses reusing the same password', async () => {
    await expect(
      changePassword(
        {
          userId: 'u1',
          currentPassword: 'current-password',
          newPassword: 'current-password',
          recentAuth: false,
          currentSessionId: null,
        },
        {},
        asDb,
      ),
    ).rejects.toThrow(/different/);
  });
});

describe('deactivateAccount', () => {
  it('revokes all sessions and pauses the automations the user owns', async () => {
    const s = await createUserSession({ userId: 'u1', authMethod: 'password' }, asDb);
    await db.automationRule.create({
      data: { organizationId: 'o1', ownerId: 'u1', status: 'ACTIVE' },
    });
    await db.automationRule.create({
      data: { organizationId: 'o1', ownerId: 'someone', status: 'ACTIVE' },
    });
    const res = await deactivateAccount('u1', {}, asDb);
    expect(res.automationsPaused).toBe(1);
    expect((await validateSession('u1', s.sessionId, new Date(), asDb)).ok).toBe(false);
    expect(db.automationRule.rows.find((r) => r.ownerId === 'someone')?.status).toBe('ACTIVE');
    expect((await db.user.findUnique({ where: { id: 'u1' } }))?.deactivatedAt).toBeInstanceOf(Date);
  });
});
