import { prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { CredentialsSignin } from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import Nodemailer from 'next-auth/providers/nodemailer';
import { contextFromRequest } from './request-context.js';
import { recordFailedLogin } from './sessions.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { verifyAgainstDummy, verifyPassword } from './password.js';

const log = createLogger('auth');

const MAGIC_LINK_MAX_AGE = 15 * 60; // seconds

/** Password-login attempts per email address per hour — separate from, and
 * more generous than, the magic-link send limit (mistyped passwords are a
 * normal retry pattern the magic-link flow doesn't have). */
const PASSWORD_LOGIN_LIMIT = 10;

/**
 * Thrown by the `password` provider's `authorize()` when the credentials are
 * correct but the account's email hasn't been verified yet (see the signup
 * flow in apps/web/src/server/auth-actions.ts). NextAuth v5's supported way
 * to surface a *specific* Credentials error to the client without leaking it
 * as a generic "invalid credentials" — the `code` is safe to expose (it says
 * nothing about whether an email exists on its own, only reachable once the
 * password already matched).
 */
export class EmailNotVerifiedError extends CredentialsSignin {
  override code = 'email-not-verified';
}

type SendArgs = { identifier: string; url: string };

/** Resolve the effective magic-link transport from env. */
function emailTransport(): 'console' | 'smtp' | 'resend' {
  const explicit = process.env.EMAIL_TRANSPORT;
  if (explicit === 'smtp' || explicit === 'resend' || explicit === 'console') return explicit;
  // No explicit choice: a Resend key implies the Resend transport; otherwise dev console.
  return process.env.RESEND_API_KEY ? 'resend' : 'console';
}

function magicLinkEmail(url: string): { subject: string; text: string; html: string } {
  const subject = 'Your Growth Agent sign-in link';
  const text = `Sign in to Growth Agent:\n\n${url}\n\nThis link expires in 15 minutes. If you did not request it, ignore this email.`;
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6;color:#0f172a">
<p>Click the button to sign in to <strong>Growth Agent</strong>:</p>
<p><a href="${url}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none">Sign in</a></p>
<p style="color:#64748b;font-size:13px">Or paste this URL: <br><span style="word-break:break-all">${url}</span></p>
<p style="color:#64748b;font-size:13px">This link expires in 15 minutes. If you did not request it, you can ignore this email.</p>
</body></html>`;
  return { subject, text, html };
}

/**
 * Send the magic link via the Resend HTTP API (no SDK, no SMTP infrastructure —
 * one `RESEND_API_KEY` makes passwordless sign-in work). Throws on a non-2xx so
 * NextAuth surfaces the failure to the caller rather than silently "sending".
 */
async function sendViaResend({ identifier, url }: SendArgs): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const from = process.env.EMAIL_FROM ?? 'Growth Agent <onboarding@resend.dev>';
  const { subject, text, html } = magicLinkEmail(url);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [identifier], subject, text, html }),
  });
  if (!res.ok) {
    // Do not log the response body — a provider error can echo the payload.
    throw new Error(`Resend API returned ${res.status}`);
  }
}

/**
 * Providers are assembled from env so a deployment enables only what it has
 * credentials for. Magic-link is always present; its delivery is:
 *   - `resend`  — Resend HTTP API (`RESEND_API_KEY`); the zero-infra default.
 *   - `smtp`    — Nodemailer against `EMAIL_SERVER`.
 *   - `console` — dev only: the link is logged, never sent.
 * Google is added when configured. A real email+password provider (`id:
 * 'password'`) is always present alongside magic-link — signup/reset both
 * work by sending a magic link (see auth-actions.ts), so password accounts
 * share the same verification/reset infrastructure rather than a parallel
 * one. A dev-only credentials provider is available strictly for local +
 * e2e use (double-gated: `AUTH_DEV_LOGIN==='true'` AND
 * `NODE_ENV!=='production'`).
 */
export function buildProviders(): Provider[] {
  const providers: Provider[] = [];
  const emailFrom = process.env.EMAIL_FROM ?? 'Growth Agent <noreply@localhost>';
  const transport = emailTransport();

  const overrides =
    transport === 'resend'
      ? {
          async sendVerificationRequest({ identifier, url }: SendArgs) {
            await sendViaResend({ identifier, url });
          },
        }
      : transport === 'console'
        ? {
            sendVerificationRequest({ identifier, url }: SendArgs) {
              log.info(
                { to: identifier },
                'magic-link email (console transport — not actually sent)',
              );
              // eslint-disable-next-line no-console
              console.log(`\n  ✉  Sign-in link for ${identifier}:\n  ${url}\n`);
            },
          }
        : {}; // smtp: let Nodemailer send via EMAIL_SERVER

  providers.push(
    Nodemailer({
      from: emailFrom,
      server: process.env.EMAIL_SERVER ?? 'smtp://localhost:1025',
      maxAge: MAGIC_LINK_MAX_AGE,
      ...overrides,
    }),
  );

  providers.push(
    Credentials({
      id: 'password',
      name: 'Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw, request) {
        const email = typeof raw?.email === 'string' ? raw.email.toLowerCase().trim() : '';
        const password = typeof raw?.password === 'string' ? raw.password : '';
        if (!email || !password) return null;

        // Rate-limit every attempt (not just failures) so brute-forcing a
        // password is throttled the same way magic-link sends already are.
        const rl = await checkRateLimit({
          key: `password-login:${email}`,
          limit: PASSWORD_LOGIN_LIMIT,
          windowSec: 3600,
        });
        if (!rl.ok) {
          log.warn({ email }, 'password login rate-limited');
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || user.deletedAt || !user.passwordHash) {
          // Run a real scrypt computation even though there's nothing to
          // check against, so this path doesn't respond measurably faster
          // than a wrong-password one (which would leak account existence).
          verifyAgainstDummy(password);
          return null;
        }
        if (!verifyPassword(password, user.passwordHash)) {
          // Security event for the account owner's login history (Part 32).
          await recordFailedLogin(user.id, {
            ...contextFromRequest(request),
            reason: 'bad_password',
          });
          return null;
        }
        if (!user.emailVerified) throw new EmailNotVerifiedError();
        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  );

  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    providers.push(
      Google({
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        allowDangerousEmailAccountLinking: false,
      }),
    );
  }

  if (process.env.AUTH_DEV_LOGIN === 'true' && process.env.NODE_ENV !== 'production') {
    log.warn(
      'AUTH_DEV_LOGIN is enabled — credentials sign-in for seeded users is active (dev only)',
    );
    providers.push(
      Credentials({
        id: 'dev-credentials',
        name: 'Dev credentials',
        credentials: { email: { label: 'Email', type: 'email' } },
        async authorize(raw) {
          const email = typeof raw?.email === 'string' ? raw.email.toLowerCase() : '';
          if (!email) return null;
          const user = await prisma.user.findUnique({ where: { email } });
          if (!user || user.deletedAt) return null;
          return { id: user.id, email: user.email, name: user.name, image: user.image };
        },
      }),
    );
  }

  return providers;
}
