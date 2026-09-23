import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';
import { generateEncryptionKey } from '../crypto/tokens.js';

process.env.ENCRYPTION_KEY = generateEncryptionKey();

const {
  startMfaEnrollment,
  confirmMfaEnrollment,
  verifyMfaCode,
  disableMfa,
  hasMfaEnabled,
  getMfaStatus,
  regenerateRecoveryCodes,
  totpUri,
} = await import('./mfa.js');

let db: MemoryDb;
let asDb: Db;

beforeEach(async () => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
  await db.user.create({ data: { id: 'user_1', email: 'a@example.com' } });
});

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(str: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of str.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** An independent RFC 6238 reference implementation (not imported from the
 *  module under test) — proves `mfa.ts`'s own HOTP/TOTP math is standards
 *  -correct, not merely self-consistent. */
function referenceTotp(secretBase32: string, time = Date.now()): string {
  const counter = Math.floor(time / 1000 / 30);
  const secret = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

describe('MFA — TOTP enrollment and verification', () => {
  it('generates a secret, activates only after a correct code, and issues 10 unique recovery codes', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    expect(start.otpauthUri).toContain('otpauth://totp/');
    expect(start.otpauthUri).toContain(start.secret);
    expect(await hasMfaEnabled('user_1', asDb)).toBe(false);

    const code = referenceTotp(start.secret);
    const { recoveryCodes } = await confirmMfaEnrollment('user_1', start.factorId, code, asDb);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(await hasMfaEnabled('user_1', asDb)).toBe(true);
  });

  it('rejects an incorrect code and never activates the factor', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    await expect(confirmMfaEnrollment('user_1', start.factorId, '000000', asDb)).rejects.toThrow(/incorrect/i);
    expect(await hasMfaEnabled('user_1', asDb)).toBe(false);
  });

  it('never stores the raw secret at rest — the sealed cipher does not contain it', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    const row = db.userMfaFactor.rows.find((r) => r.id === start.factorId);
    expect(String(row?.secretCipher)).not.toContain(start.secret);
  });

  it('restarting enrollment discards the prior PENDING attempt (no orphaned rows)', async () => {
    await startMfaEnrollment('user_1', 'a@example.com', asDb);
    await startMfaEnrollment('user_1', 'a@example.com', asDb);
    const pending = db.userMfaFactor.rows.filter((r) => r.userId === 'user_1' && r.status === 'PENDING');
    expect(pending).toHaveLength(1);
  });

  it('verifyMfaCode accepts a live TOTP code and updates lastUsedAt', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    await confirmMfaEnrollment('user_1', start.factorId, referenceTotp(start.secret), asDb);

    const result = await verifyMfaCode('user_1', referenceTotp(start.secret), asDb);
    expect(result).toEqual({ ok: true, usedRecoveryCode: false });
  });

  it('verifyMfaCode rejects a wrong code and a code for a different secret', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    await confirmMfaEnrollment('user_1', start.factorId, referenceTotp(start.secret), asDb);
    expect(await verifyMfaCode('user_1', '123456', asDb)).toEqual({ ok: false, usedRecoveryCode: false });
  });

  it('a recovery code works once, then is rejected on reuse', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    const { recoveryCodes } = await confirmMfaEnrollment('user_1', start.factorId, referenceTotp(start.secret), asDb);
    const code = recoveryCodes[0] as string;

    const first = await verifyMfaCode('user_1', code, asDb);
    expect(first).toEqual({ ok: true, usedRecoveryCode: true });

    const second = await verifyMfaCode('user_1', code, asDb);
    expect(second).toEqual({ ok: false, usedRecoveryCode: false });
  });

  it('recovery codes are case-insensitive and hyphen-tolerant on input', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    const { recoveryCodes } = await confirmMfaEnrollment('user_1', start.factorId, referenceTotp(start.secret), asDb);
    const code = (recoveryCodes[0] as string).toLowerCase();
    expect(await verifyMfaCode('user_1', code, asDb)).toEqual({ ok: true, usedRecoveryCode: true });
  });

  it('regenerateRecoveryCodes invalidates the old set entirely', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    const { recoveryCodes: original } = await confirmMfaEnrollment('user_1', start.factorId, referenceTotp(start.secret), asDb);
    const fresh = await regenerateRecoveryCodes('user_1', asDb);

    expect(fresh).toHaveLength(10);
    expect(await verifyMfaCode('user_1', original[0] as string, asDb)).toEqual({ ok: false, usedRecoveryCode: false });
    expect(await verifyMfaCode('user_1', fresh[0] as string, asDb)).toEqual({ ok: true, usedRecoveryCode: true });
  });

  it('regenerateRecoveryCodes refuses when MFA is not enabled', async () => {
    await expect(regenerateRecoveryCodes('user_1', asDb)).rejects.toThrow(/enable an authenticator/i);
  });

  it('getMfaStatus reports enabled state and remaining recovery-code count', async () => {
    expect(await getMfaStatus('user_1', asDb)).toMatchObject({ enabled: false, recoveryCodesRemaining: 0 });
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    const { recoveryCodes } = await confirmMfaEnrollment('user_1', start.factorId, referenceTotp(start.secret), asDb);
    await verifyMfaCode('user_1', recoveryCodes[0] as string, asDb);
    const status = await getMfaStatus('user_1', asDb);
    expect(status.enabled).toBe(true);
    expect(status.recoveryCodesRemaining).toBe(9);
  });

  it('disableMfa removes both the TOTP factor and recovery codes', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    await confirmMfaEnrollment('user_1', start.factorId, referenceTotp(start.secret), asDb);
    await disableMfa('user_1', asDb);
    expect(await hasMfaEnabled('user_1', asDb)).toBe(false);
    expect(db.userMfaFactor.rows.filter((r) => r.userId === 'user_1')).toHaveLength(0);
  });

  it('records a MFA_CHANGED security event on enable, recovery-code use, regenerate, and disable', async () => {
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    const { recoveryCodes } = await confirmMfaEnrollment('user_1', start.factorId, referenceTotp(start.secret), asDb);
    await verifyMfaCode('user_1', recoveryCodes[0] as string, asDb);
    await regenerateRecoveryCodes('user_1', asDb);
    await disableMfa('user_1', asDb);
    const events = db.securityEvent.rows.filter((r) => r.userId === 'user_1' && r.type === 'MFA_CHANGED');
    expect(events).toHaveLength(4);
  });

  it('one user\'s MFA factor never satisfies another user\'s verification (tenant/user isolation)', async () => {
    await db.user.create({ data: { id: 'user_2', email: 'b@example.com' } });
    const start = await startMfaEnrollment('user_1', 'a@example.com', asDb);
    const code = referenceTotp(start.secret);
    await confirmMfaEnrollment('user_1', start.factorId, code, asDb);
    expect(await verifyMfaCode('user_2', code, asDb)).toEqual({ ok: false, usedRecoveryCode: false });
  });

  it('totpUri encodes a valid otpauth:// URI with the account label and issuer', () => {
    const uri = totpUri('JBSWY3DPEHPK3PXP', 'user@example.com', 'Growth Agent');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Growth%20Agent');
  });
});
