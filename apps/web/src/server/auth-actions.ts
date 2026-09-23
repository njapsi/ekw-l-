'use server';

import { headers } from 'next/headers';
import { prisma } from '@growth-agent/db';
import { security, users } from '@growth-agent/services';
import {
  isRecentAuth,
  registerWithPassword,
  signIn,
  updateSession,
} from '@growth-agent/services/auth';
import { requireUser } from '@/lib/auth';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requestCtx() {
  const h = await headers();
  return { ip: security.clientIpFrom(h), userAgent: h.get('user-agent') };
}

/**
 * Per-IP throttle for unauthenticated auth forms (Part 31). Fails open with
 * Redis down, except for `failClosed` credential-guessing surfaces
 * (password-reset request — Phase 12 §34), which fail closed instead: an
 * attacker able to knock out Redis must not be handed unlimited guesses as
 * the reward.
 */
async function ipLimited(
  bucket: string,
  limit: number,
  windowSec: number,
  failClosed = false,
): Promise<boolean> {
  const { ip } = await requestCtx();
  const rl = await security.checkRateLimit({ key: `${bucket}:ip:${ip}`, limit, windowSec, failClosed });
  return !rl.ok;
}

function sendMagicLink(email: string, callbackUrl: string) {
  return signIn('nodemailer', { email, redirect: false, callbackUrl }).then(() => undefined);
}

export interface SignUpResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<'name' | 'email' | 'password' | 'confirmPassword', string>>;
}

/**
 * Sign up with a password. Every non-validation outcome returns the same
 * `{ ok: true }` — whether the address was new, belonged to a magic-link
 * account (which now only receives a "set a password" link, never a direct
 * password change: see `registerWithPassword`), or already had a password —
 * so the form cannot be used to enumerate accounts.
 */
export async function signUpAction(input: {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}): Promise<SignUpResult> {
  const name = input.name.trim();
  const email = input.email.toLowerCase().trim();
  const { password, confirmPassword } = input;

  const fieldErrors: SignUpResult['fieldErrors'] = {};
  if (name.length < 1) fieldErrors.name = 'Enter your name.';
  else if (name.length > 100) fieldErrors.name = 'That name is too long.';
  if (!EMAIL_RE.test(email)) fieldErrors.email = 'Enter a valid email address.';
  const pwError = users.passwordPolicyError(password);
  if (pwError) fieldErrors.password = pwError;
  else if (password !== confirmPassword) fieldErrors.confirmPassword = 'Passwords do not match.';
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  if (await ipLimited('signup', 10, 3600)) {
    return { ok: false, error: 'Too many sign-up attempts from this network. Try again later.' };
  }
  await registerWithPassword({ name, email, password }, { sendMagicLink });
  return { ok: true };
}

/**
 * Always the same response whether or not the email is registered. The reset
 * link is the existing single-use magic link pointed at /app/set-password:
 * clicking it proves control of the inbox and signs the user in, and the
 * fresh sign-in is what lets them set a password without the old one.
 */
export async function requestPasswordResetAction(email: string): Promise<{ ok: boolean }> {
  const normalized = email.toLowerCase().trim();
  if (!EMAIL_RE.test(normalized) || (await ipLimited('pw-reset', 10, 3600, true))) return { ok: true };
  const user = await prisma.user.findUnique({
    where: { email: normalized },
    select: { id: true, deletedAt: true },
  });
  if (user && !user.deletedAt) {
    await sendMagicLink(normalized, '/app/set-password');
    const ctx = await requestCtx();
    await security.recordSecurityEvent({
      userId: user.id,
      type: 'PASSWORD_RESET_REQUESTED',
      severity: 'WARNING',
      ...ctx,
    });
  }
  return { ok: true };
}

/** Re-send verification for an unverified password account. Generic response. */
export async function resendVerificationEmailAction(email: string): Promise<{ ok: boolean }> {
  const normalized = email.toLowerCase().trim();
  if (!EMAIL_RE.test(normalized) || (await ipLimited('verify-resend', 10, 3600))) {
    return { ok: true };
  }
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  if (user && !user.deletedAt && user.passwordHash && !user.emailVerified) {
    await sendMagicLink(normalized, '/app');
  }
  return { ok: true };
}

export interface SetPasswordResult {
  ok: boolean;
  error?: string;
  otherSessionsRevoked?: number;
  fieldErrors?: Partial<Record<'currentPassword' | 'password' | 'confirmPassword', string>>;
}

/**
 * Set or change the signed-in user's password. The current password is
 * required unless the user authenticated in the last 15 minutes (the reset
 * link path). Every other session is signed out afterwards, and this
 * browser's token is re-issued so it survives the revocation.
 */
export async function setPasswordAction(input: {
  currentPassword?: string;
  password: string;
  confirmPassword: string;
}): Promise<SetPasswordResult> {
  const user = await requireUser();
  const fieldErrors: SetPasswordResult['fieldErrors'] = {};
  const pwError = users.passwordPolicyError(input.password);
  if (pwError) fieldErrors.password = pwError;
  else if (input.password !== input.confirmPassword) {
    fieldErrors.confirmPassword = 'Passwords do not match.';
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const rl = await security.checkRateLimit({
    key: `password-change:${user.id}`,
    limit: 10,
    windowSec: 3600,
  });
  if (!rl.ok) return { ok: false, error: 'Too many attempts. Try again later.' };

  try {
    const ctx = await requestCtx();
    const res = await users.changePassword(
      {
        userId: user.id,
        currentPassword: input.currentPassword,
        newPassword: input.password,
        recentAuth: isRecentAuth(user.authAt),
        currentSessionId: user.sessionId,
      },
      ctx,
    );
    // `sessionVersion` was bumped to kill other (and legacy) sessions; refresh
    // this browser's token so it carries the new version.
    await updateSession({});
    return { ok: true, otherSessionsRevoked: res.otherSessionsRevoked };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not change the password.';
    if (/current password/i.test(message)) {
      return { ok: false, fieldErrors: { currentPassword: message } };
    }
    return {
      ok: false,
      error: message.includes('different') ? message : 'Could not change the password.',
    };
  }
}
