'use server';

import { prisma } from '@growth-agent/db';
import { recordAudit } from '@growth-agent/services';
import { hashPassword, signIn } from '@growth-agent/services/auth';
import { requireUser } from '@/lib/auth';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

function passwordError(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `Must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return 'That password is too long.';
  return undefined;
}

export interface SignUpResult {
  ok: boolean;
  fieldErrors?: Partial<Record<'name' | 'email' | 'password' | 'confirmPassword', string>>;
}

/**
 * Creates (or adds a password to) an account and sends the same
 * verification/sign-in email the existing magic-link flow already sends —
 * clicking it both verifies the email and signs the user in (Auth.js's
 * built-in email-provider callback). Every outcome that isn't a validation
 * error returns the identical `{ ok: true }` regardless of whether the
 * email was already registered, so this can't be used to enumerate
 * accounts.
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
  const pwError = passwordError(password);
  if (pwError) fieldErrors.password = pwError;
  else if (password !== confirmPassword) fieldErrors.confirmPassword = 'Passwords do not match.';
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const created = await prisma.user.create({
      data: { email, name, passwordHash: hashPassword(password) },
    });
    await recordAudit({
      actorId: created.id,
      action: 'auth.sign_up',
      targetType: 'user',
      targetId: created.id,
    });
    await signIn('nodemailer', { email, redirect: false, callbackUrl: '/app' });
  } else if (!existing.passwordHash) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash: hashPassword(password), name: existing.name ?? name },
    });
    await recordAudit({
      actorId: existing.id,
      action: 'auth.password_set',
      targetType: 'user',
      targetId: existing.id,
    });
    await signIn('nodemailer', { email, redirect: false, callbackUrl: '/app' });
  }
  // else: an account with a password already exists for this email — do
  // nothing (no overwrite, no duplicate email) but still report success.

  return { ok: true };
}

/**
 * Always returns the same response whether or not the email is registered.
 * The "reset" link is the existing magic-link mechanism pointed at
 * /app/set-password instead of /app — clicking it signs the user in (proving
 * they own the inbox), landing them on a session-protected page to choose a
 * new password.
 */
export async function requestPasswordResetAction(email: string): Promise<{ ok: boolean }> {
  const normalized = email.toLowerCase().trim();
  if (EMAIL_RE.test(normalized)) {
    const user = await prisma.user.findUnique({ where: { email: normalized } });
    if (user && !user.deletedAt) {
      await signIn('nodemailer', {
        email: normalized,
        redirect: false,
        callbackUrl: '/app/set-password',
      });
    }
  }
  return { ok: true };
}

/**
 * Re-sends the verification email for an existing, still-unverified
 * password account (the "please verify your email" case surfaced by a
 * `password` sign-in attempt). Same generic response regardless of whether
 * the email exists or is already verified — no enumeration signal.
 */
export async function resendVerificationEmailAction(email: string): Promise<{ ok: boolean }> {
  const normalized = email.toLowerCase().trim();
  if (EMAIL_RE.test(normalized)) {
    const user = await prisma.user.findUnique({ where: { email: normalized } });
    if (user && !user.deletedAt && user.passwordHash && !user.emailVerified) {
      await signIn('nodemailer', { email: normalized, redirect: false, callbackUrl: '/app' });
    }
  }
  return { ok: true };
}

export interface SetPasswordResult {
  ok: boolean;
  fieldErrors?: Partial<Record<'password' | 'confirmPassword', string>>;
}

/** Sets/changes the current session user's password. Requires an active session. */
export async function setPasswordAction(input: {
  password: string;
  confirmPassword: string;
}): Promise<SetPasswordResult> {
  const user = await requireUser();
  const { password, confirmPassword } = input;

  const fieldErrors: SetPasswordResult['fieldErrors'] = {};
  const pwError = passwordError(password);
  if (pwError) fieldErrors.password = pwError;
  else if (password !== confirmPassword) fieldErrors.confirmPassword = 'Passwords do not match.';
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(password) } });
  await recordAudit({
    actorId: user.id,
    action: 'auth.password_set',
    targetType: 'user',
    targetId: user.id,
  });
  return { ok: true };
}
