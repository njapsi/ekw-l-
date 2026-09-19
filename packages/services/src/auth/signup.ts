/**
 * Password sign-up (ADR-0049, hardened in Phase 2 / ADR-0052).
 *
 * SECURITY FIX (Phase 2 audit, CRITICAL): the original flow set a password
 * directly on any *existing* account that had none (a magic-link or Google
 * user). Such an account's email is already verified, so the attacker who
 * submitted the form could immediately sign in with the password they chose —
 * a full account takeover needing only the victim's email address.
 *
 * Now an existing account is never modified from this unauthenticated form.
 * Instead the owner of the inbox gets a link to /app/set-password: proving
 * control of the mailbox is the only way to attach a password to an account
 * that already exists. Every outcome still returns the same response to the
 * caller, so the form cannot be used to enumerate accounts.
 */
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { hashPassword } from './password.js';

export type SignUpOutcome =
  'created' | 'existing_account_set_password_link_sent' | 'existing_password_account_noop';

export interface SignUpDeps {
  /** Sends the single-use magic link (Auth.js email provider) to `email`. */
  sendMagicLink: (email: string, callbackUrl: string) => Promise<void>;
  db?: Db;
}

export async function registerWithPassword(
  input: { name: string; email: string; password: string },
  deps: SignUpDeps,
): Promise<SignUpOutcome> {
  const db = deps.db ?? prisma;
  const email = input.email.toLowerCase().trim();
  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, deletedAt: true },
  });

  if (!existing) {
    const created = await db.user.create({
      data: { email, name: input.name, passwordHash: hashPassword(input.password) },
      select: { id: true },
    });
    await recordAudit(
      { actorId: created.id, action: 'auth.sign_up', targetType: 'user', targetId: created.id },
      db,
    );
    // Verification: the account works only after this link is used.
    await deps.sendMagicLink(email, '/app');
    return 'created';
  }

  if (!existing.passwordHash && !existing.deletedAt) {
    // Do NOT touch the account. The inbox owner may choose a password.
    await deps.sendMagicLink(email, '/app/set-password');
    return 'existing_account_set_password_link_sent';
  }

  return 'existing_password_account_noop';
}
