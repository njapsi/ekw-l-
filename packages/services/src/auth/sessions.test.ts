import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { describeUserAgent, toIpPrefix } from '../security/events.js';
import { hashPassword } from './password.js';
import {
  FAILED_LOGIN_ALERT_AT,
  SESSION_ABSOLUTE_MS,
  authMethodFor,
  createUserSession,
  endSession,
  isRecentAuth,
  listUserSessions,
  recordFailedLogin,
  revokeOtherSessions,
  revokeSessionByHandle,
  sessionHandle,
  validateSession,
} from './sessions.js';
import { registerWithPassword } from './signup.js';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

let db: MemoryDb;
let asDb: Db;
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.user.create({ data: { id: 'u1', email: 'u1@example.com' } });
});

describe('helpers', () => {
  it('keeps only a coarse network prefix, never the full address', () => {
    expect(toIpPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(toIpPrefix('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(toIpPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(toIpPrefix('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(toIpPrefix('unknown')).toBeNull();
  });

  it('labels devices without storing fingerprints', () => {
    expect(describeUserAgent(CHROME_WIN)).toBe('Chrome on Windows');
    expect(describeUserAgent(SAFARI_MAC)).toBe('Safari on macOS');
    expect(describeUserAgent(null)).toBe('Unknown device');
  });

  it('maps providers to auth methods', () => {
    expect(authMethodFor('nodemailer')).toBe('magic-link');
    expect(authMethodFor('password')).toBe('password');
    expect(authMethodFor('google')).toBe('google');
  });

  it('treats only the last 15 minutes as recent authentication', () => {
    const now = Date.now();
    expect(isRecentAuth(now - 60_000, now)).toBe(true);
    expect(isRecentAuth(now - 16 * 60_000, now)).toBe(false);
    expect(isRecentAuth(null, now)).toBe(false);
  });
});

describe('session lifecycle', () => {
  it('records the session, the login, and last-login time', async () => {
    const { sessionId } = await createUserSession(
      { userId: 'u1', authMethod: 'password', userAgent: CHROME_WIN, ip: '203.0.113.7' },
      asDb,
    );
    const row = db.userSession.rows.find((r) => r.id === sessionId);
    expect(row?.ipPrefix).toBe('203.0.113.0/24');
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');
    expect(db.securityEvent.rows.some((e) => e.type === 'AUTH_LOGIN')).toBe(true);
    expect((await db.user.findUnique({ where: { id: 'u1' } }))?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('flags a login from a new network and device (suspicious-session hook)', async () => {
    await createUserSession(
      { userId: 'u1', authMethod: 'password', userAgent: CHROME_WIN, ip: '203.0.113.7' },
      asDb,
    );
    await createUserSession(
      { userId: 'u1', authMethod: 'password', userAgent: SAFARI_MAC, ip: '198.51.100.1' },
      asDb,
    );
    const last = db.securityEvent.rows.filter((e) => e.type === 'AUTH_LOGIN').at(-1);
    expect(last?.severity).toBe('WARNING');
    expect(last?.metadata).toMatchObject({ newNetwork: true, newDevice: true });
  });

  it('validates a live session and rejects revoked, expired and foreign ones', async () => {
    const { sessionId } = await createUserSession({ userId: 'u1', authMethod: 'password' }, asDb);
    expect(await validateSession('u1', sessionId, new Date(), asDb)).toEqual({ ok: true });
    expect(await validateSession('u2', sessionId, new Date(), asDb)).toEqual({
      ok: false,
      reason: 'wrong_user',
    });
    expect(
      await validateSession('u1', sessionId, new Date(Date.now() + SESSION_ABSOLUTE_MS + 1), asDb),
    ).toEqual({ ok: false, reason: 'expired' });
    await endSession('u1', sessionId, asDb);
    expect(await validateSession('u1', sessionId, new Date(), asDb)).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect(await validateSession('u1', 'nope', new Date(), asDb)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('lists sessions by opaque handle, never by id', async () => {
    const { sessionId } = await createUserSession(
      { userId: 'u1', authMethod: 'password', userAgent: CHROME_WIN },
      asDb,
    );
    const list = await listUserSessions('u1', sessionId, asDb);
    expect(list).toHaveLength(1);
    expect(list[0]?.current).toBe(true);
    expect(JSON.stringify(list)).not.toContain(sessionId);
    expect(list[0]?.handle).toBe(sessionHandle(sessionId));
  });

  it('signs out another device but refuses the current one', async () => {
    const a = await createUserSession({ userId: 'u1', authMethod: 'password' }, asDb);
    const b = await createUserSession({ userId: 'u1', authMethod: 'magic-link' }, asDb);
    await expect(
      revokeSessionByHandle('u1', sessionHandle(a.sessionId), a.sessionId, {}, asDb),
    ).rejects.toThrow();
    await revokeSessionByHandle('u1', sessionHandle(b.sessionId), a.sessionId, {}, asDb);
    expect((await validateSession('u1', b.sessionId, new Date(), asDb)).ok).toBe(false);
    expect((await validateSession('u1', a.sessionId, new Date(), asDb)).ok).toBe(true);
  });

  it('cannot sign out another user’s session', async () => {
    await db.user.create({ data: { id: 'u2', email: 'u2@example.com' } });
    const other = await createUserSession({ userId: 'u2', authMethod: 'password' }, asDb);
    await expect(
      revokeSessionByHandle('u1', sessionHandle(other.sessionId), null, {}, asDb),
    ).rejects.toThrow(/not found/);
  });

  it('"sign out all other sessions" keeps the current one and bumps sessionVersion', async () => {
    const keep = await createUserSession({ userId: 'u1', authMethod: 'password' }, asDb);
    const other = await createUserSession({ userId: 'u1', authMethod: 'password' }, asDb);
    const n = await revokeOtherSessions('u1', keep.sessionId, 'user_requested', {}, asDb);
    expect(n).toBe(1);
    expect((await validateSession('u1', other.sessionId, new Date(), asDb)).ok).toBe(false);
    expect((await validateSession('u1', keep.sessionId, new Date(), asDb)).ok).toBe(true);
    expect((await db.user.findUnique({ where: { id: 'u1' } }))?.sessionVersion).toBe(1);
  });

  it('signing in reactivates a deactivated account', async () => {
    await db.user.update({ where: { id: 'u1' }, data: { deactivatedAt: new Date() } });
    await createUserSession({ userId: 'u1', authMethod: 'magic-link' }, asDb);
    expect((await db.user.findUnique({ where: { id: 'u1' } }))?.deactivatedAt).toBeNull();
    expect(db.securityEvent.rows.some((e) => e.type === 'ACCOUNT_REACTIVATED')).toBe(true);
  });

  it('raises one critical event at the repeated-failure threshold', async () => {
    const results = [];
    for (let i = 0; i < FAILED_LOGIN_ALERT_AT + 2; i++) {
      results.push(await recordFailedLogin('u1', { reason: 'bad_password' }, asDb));
    }
    expect(results.filter((r) => r.repeated)).toHaveLength(1);
    expect(db.securityEvent.rows.filter((e) => e.type === 'REPEATED_LOGIN_FAILURE')).toHaveLength(
      1,
    );
  });
});

describe('registerWithPassword (account-takeover fix)', () => {
  it('never sets a password on an existing magic-link account', async () => {
    const sendMagicLink = vi.fn(async () => {});
    await db.user.update({ where: { id: 'u1' }, data: { emailVerified: new Date() } });
    const outcome = await registerWithPassword(
      { name: 'Attacker', email: 'U1@example.com', password: 'attacker-chosen-pw' },
      { sendMagicLink, db: asDb },
    );
    expect(outcome).toBe('existing_account_set_password_link_sent');
    expect((await db.user.findUnique({ where: { id: 'u1' } }))?.passwordHash).toBeNull();
    // The *inbox owner* gets a link to choose a password.
    expect(sendMagicLink).toHaveBeenCalledWith('u1@example.com', '/app/set-password');
  });

  it('does not touch an account that already has a password', async () => {
    const sendMagicLink = vi.fn(async () => {});
    const hash = hashPassword('original-password');
    await db.user.update({ where: { id: 'u1' }, data: { passwordHash: hash } });
    expect(
      await registerWithPassword(
        { name: 'x', email: 'u1@example.com', password: 'something-else' },
        { sendMagicLink, db: asDb },
      ),
    ).toBe('existing_password_account_noop');
    expect((await db.user.findUnique({ where: { id: 'u1' } }))?.passwordHash).toBe(hash);
    expect(sendMagicLink).not.toHaveBeenCalled();
  });

  it('creates a new, unverified account and sends the verification link', async () => {
    const sendMagicLink = vi.fn(async () => {});
    expect(
      await registerWithPassword(
        { name: 'New', email: 'new@example.com', password: 'a-good-password' },
        { sendMagicLink, db: asDb },
      ),
    ).toBe('created');
    const created = await db.user.findFirst({ where: { email: 'new@example.com' } });
    expect(created?.passwordHash).toBeTruthy();
    expect(created?.emailVerified).toBeUndefined();
    expect(sendMagicLink).toHaveBeenCalledWith('new@example.com', '/app');
  });
});
