/**
 * Multi-factor authentication (Phase 12, §12). `UserMfaFactor` (Phase 2) has
 * sat unused since it was created — this is the first real implementation.
 * TOTP (RFC 6238) is hand-rolled on `node:crypto`'s HMAC, matching this
 * codebase's established convention for exactly this kind of thing
 * (`auth/password.ts`'s scrypt, `crypto/tokens.ts`'s AES-256-GCM envelope,
 * `billing/stripe-signature.ts`'s webhook HMAC) rather than adding a new
 * dependency (CLAUDE.md hard rule 9). WebAuthn is NOT implemented — the
 * `WEBAUTHN` enum value stays reserved, exactly like `AgentRunStatus.TIMED_OUT`
 * elsewhere in this codebase: a real gap, not a placeholder pretending to work.
 *
 * The TOTP *secret* is encrypted at rest with the existing `seal`/`open`
 * AES-256-GCM envelope (the same one OAuth tokens use) — reversible, because
 * generating the next 30-second code requires the raw secret. Recovery codes
 * are the opposite: one-way SHA-256 hashed, exactly like a password or an API
 * key, because they are only ever compared, never displayed again after
 * generation.
 *
 * This module deliberately does NOT wire a TOTP challenge into the sign-in
 * flow itself (`auth/providers.ts`'s `password`/`nodemailer`/`google`
 * providers are untouched) — restructuring Auth.js's Credentials flow into a
 * two-step "password, then TOTP" exchange is a materially larger, riskier
 * change to an already-audited, already-verified-live authentication path,
 * and the brief's own instruction is "do not replace the existing
 * authentication architecture without first proving it is necessary."
 * Instead, `requireRecentMfa` gates the specific *high-risk actions* §12's
 * own text calls out ("high-risk organization actions should be able to
 * require stronger authentication") — ownership transfer, org/account
 * deletion, granting OWNER — the same set `sessions.ts::isRecentAuth`
 * already gates, now additionally requiring a fresh TOTP/recovery-code
 * challenge when the user has MFA enabled.
 */
import { createHmac, randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';
import { seal, open } from '../crypto/tokens.js';
import { recordSecurityEvent } from '../security/events.js';

const TOTP_DIGITS = 6;
const TOTP_STEP_SEC = 30;
/** Tolerate ±1 step (30s) of clock drift between the server and the
 *  authenticator app — wide enough to be usable, narrow enough that a code
 *  is only ever valid for at most ~90 seconds total. */
const TOTP_WINDOW_STEPS = 1;
const RECOVERY_CODE_COUNT = 10;
/** How long an MFA challenge stays "fresh" for a sensitive action —
 *  intentionally the same window as `sessions.ts::RECENT_AUTH_MS`. */
export const MFA_CHALLENGE_FRESH_MS = 15 * 60 * 1000;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
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

/** RFC 6238 TOTP over HMAC-SHA1 (the universally-supported algorithm every
 *  mainstream authenticator app — Google Authenticator, Authy, 1Password —
 *  defaults to; SHA-256/512 TOTP exists but is far less broadly supported). */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(code % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function totpCounterFor(time: number): number {
  return Math.floor(time / 1000 / TOTP_STEP_SEC);
}

/** Constant-time check across a small window of adjacent time steps, so a
 *  code generated a few seconds before/after the server's clock still works. */
function verifyTotpCode(secretBase32: string, code: string, time: number = Date.now()): boolean {
  const submitted = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(submitted)) return false;
  const secret = base32Decode(secretBase32);
  const counter = totpCounterFor(time);
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta++) {
    const expected = hotp(secret, counter + delta);
    if (
      timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(submitted.padStart(TOTP_DIGITS, '0'), 'utf8'))
    ) {
      return true;
    }
  }
  return false;
}

export function totpUri(secretBase32: string, accountLabel: string, issuer = 'Growth Agent'): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SEC}`;
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    // xxxx-xxxx, from a restricted alphabet that avoids visually-ambiguous
    // characters (0/O, 1/I/l) — codes are read off a screen and typed once.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const raw = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().trim()).digest('hex');
}

export interface StartMfaEnrollmentResult {
  factorId: string;
  secret: string;
  otpauthUri: string;
}

/** Step 1: generate a new TOTP secret and store it PENDING (sealed at rest,
 *  same envelope as OAuth tokens). Nothing is active yet — a real code must
 *  be confirmed via `confirmMfaEnrollment` before this factor can be used
 *  for anything (Part 12: "do not create insecure placeholder MFA"). Any
 *  prior PENDING TOTP enrollment for this user is discarded first, so a user
 *  who abandons setup and restarts doesn't accumulate dead rows. */
export async function startMfaEnrollment(
  userId: string,
  accountLabel: string,
  db: Db = prisma,
): Promise<StartMfaEnrollmentResult> {
  await db.userMfaFactor.deleteMany({ where: { userId, type: 'TOTP', status: 'PENDING' } });
  const secretBytes = randomBytes(20); // 160 bits, RFC 6238's recommended minimum
  const secret = base32Encode(secretBytes);
  const sealed = seal(secret);
  const factor = await db.userMfaFactor.create({
    data: {
      userId,
      type: 'TOTP',
      status: 'PENDING',
      secretCipher: sealed.cipher,
      secretIv: sealed.iv,
      secretAuthTag: sealed.authTag,
      keyId: sealed.keyId,
    },
  });
  return { factorId: factor.id, secret, otpauthUri: totpUri(secret, accountLabel) };
}

/** Step 2: the user proves they actually set the secret up correctly by
 *  submitting one real, current code. Only on success does the factor
 *  become ACTIVE and a fresh set of recovery codes get issued (replacing
 *  any prior set) — recovery codes are shown to the user exactly once,
 *  here, and never retrievable again. */
export async function confirmMfaEnrollment(
  userId: string,
  factorId: string,
  code: string,
  db: Db = prisma,
): Promise<{ recoveryCodes: string[] }> {
  const factor = await db.userMfaFactor.findFirst({
    where: { id: factorId, userId, type: 'TOTP', status: 'PENDING' },
  });
  if (!factor || !factor.secretCipher || !factor.secretIv || !factor.secretAuthTag || !factor.keyId) {
    throw AppError.notFound('Pending MFA enrollment');
  }
  const secret = open({
    cipher: factor.secretCipher,
    iv: factor.secretIv,
    authTag: factor.secretAuthTag,
    keyId: factor.keyId,
  });
  if (!verifyTotpCode(secret, code)) {
    throw AppError.validation('That code is incorrect or expired. Check your authenticator app and try again.');
  }
  await db.userMfaFactor.update({
    where: { id: factor.id },
    data: { status: 'ACTIVE', lastUsedAt: new Date() },
  });
  const recoveryCodes = await issueRecoveryCodes(userId, db);
  await recordSecurityEvent({ userId, type: 'MFA_CHANGED', severity: 'WARNING', metadata: { action: 'enabled' } }, db);
  return { recoveryCodes };
}

async function issueRecoveryCodes(userId: string, db: Db): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const hashes = codes.map(hashRecoveryCode);
  await db.userMfaFactor.deleteMany({ where: { userId, type: 'RECOVERY_CODES' } });
  await db.userMfaFactor.create({
    data: {
      userId,
      type: 'RECOVERY_CODES',
      status: 'ACTIVE',
      // Hash-only storage (never sealed/reversible — these are only ever
      // compared, exactly like a password or an API key secret).
      secretCipher: JSON.stringify(hashes),
    },
  });
  return codes;
}

export async function regenerateRecoveryCodes(userId: string, db: Db = prisma): Promise<string[]> {
  const active = await hasMfaEnabled(userId, db);
  if (!active) throw AppError.validation('Enable an authenticator app before generating recovery codes.');
  const codes = await issueRecoveryCodes(userId, db);
  await recordSecurityEvent(
    { userId, type: 'MFA_CHANGED', severity: 'WARNING', metadata: { action: 'recovery_codes_regenerated' } },
    db,
  );
  return codes;
}

export async function hasMfaEnabled(userId: string, db: Db = prisma): Promise<boolean> {
  const factor = await db.userMfaFactor.findFirst({ where: { userId, type: 'TOTP', status: 'ACTIVE' } });
  return Boolean(factor);
}

export interface MfaStatus {
  enabled: boolean;
  enrolledAt: Date | null;
  lastUsedAt: Date | null;
  recoveryCodesRemaining: number;
}

export async function getMfaStatus(userId: string, db: Db = prisma): Promise<MfaStatus> {
  const [totp, recovery] = await Promise.all([
    db.userMfaFactor.findFirst({ where: { userId, type: 'TOTP', status: 'ACTIVE' } }),
    db.userMfaFactor.findFirst({ where: { userId, type: 'RECOVERY_CODES', status: 'ACTIVE' } }),
  ]);
  const remaining = recovery?.secretCipher ? (JSON.parse(recovery.secretCipher) as string[]).length : 0;
  return {
    enabled: Boolean(totp),
    enrolledAt: totp?.createdAt ?? null,
    lastUsedAt: totp?.lastUsedAt ?? null,
    recoveryCodesRemaining: remaining,
  };
}

/** Verifies either a live TOTP code or an unused recovery code (consuming
 *  it on success — one-time use). Used both for the sensitive-action
 *  challenge (`requireRecentMfa`'s companion Server Action) and could back a
 *  future login-time challenge without changing this module. */
export async function verifyMfaCode(
  userId: string,
  code: string,
  db: Db = prisma,
): Promise<{ ok: boolean; usedRecoveryCode: boolean }> {
  const totp = await db.userMfaFactor.findFirst({ where: { userId, type: 'TOTP', status: 'ACTIVE' } });
  if (totp?.secretCipher && totp.secretIv && totp.secretAuthTag && totp.keyId) {
    const secret = open({
      cipher: totp.secretCipher,
      iv: totp.secretIv,
      authTag: totp.secretAuthTag,
      keyId: totp.keyId,
    });
    if (verifyTotpCode(secret, code)) {
      await db.userMfaFactor.update({ where: { id: totp.id }, data: { lastUsedAt: new Date() } });
      return { ok: true, usedRecoveryCode: false };
    }
  }
  const recovery = await db.userMfaFactor.findFirst({ where: { userId, type: 'RECOVERY_CODES', status: 'ACTIVE' } });
  if (recovery?.secretCipher) {
    const hashes = JSON.parse(recovery.secretCipher) as string[];
    const submittedHash = hashRecoveryCode(code);
    const idx = hashes.findIndex((h) => {
      const a = Buffer.from(h, 'hex');
      const b = Buffer.from(submittedHash, 'hex');
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (idx !== -1) {
      const remaining = hashes.filter((_, i) => i !== idx);
      await db.userMfaFactor.update({
        where: { id: recovery.id },
        data: { secretCipher: JSON.stringify(remaining), lastUsedAt: new Date() },
      });
      await recordSecurityEvent(
        { userId, type: 'MFA_CHANGED', severity: 'WARNING', metadata: { action: 'recovery_code_used', remaining: remaining.length } },
        db,
      );
      return { ok: true, usedRecoveryCode: true };
    }
  }
  return { ok: false, usedRecoveryCode: false };
}

/** Turns MFA off entirely — removes both the TOTP factor and any recovery
 *  codes. Callers must have already required a recent, real authentication
 *  before calling this (mirrors `sessions.ts::isRecentAuth`'s existing use
 *  for other high-risk account changes). */
export async function disableMfa(userId: string, db: Db = prisma): Promise<void> {
  await db.userMfaFactor.deleteMany({ where: { userId, type: { in: ['TOTP', 'RECOVERY_CODES'] } } });
  await recordSecurityEvent({ userId, type: 'MFA_CHANGED', severity: 'WARNING', metadata: { action: 'disabled' } }, db);
}
