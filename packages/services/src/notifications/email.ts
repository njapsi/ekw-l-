/**
 * Transactional email for notification fan-out (Phase 19). Reuses the same
 * transport selection as the magic-link sender: Resend HTTP API, SMTP via
 * Nodemailer, or "console" (dev — logged, not sent). Never throws; returns
 * whether the message was actually handed to a real transport.
 */
import { createLogger } from '@growth-agent/observability';

const log = createLogger('notifications.email');

export type EmailTransport = 'console' | 'smtp' | 'resend' | 'none';

export function resolveEmailTransport(env: NodeJS.ProcessEnv = process.env): EmailTransport {
  const explicit = env.EMAIL_TRANSPORT;
  if (explicit === 'smtp') return env.EMAIL_SERVER ? 'smtp' : 'none';
  if (explicit === 'resend') return env.RESEND_API_KEY ? 'resend' : 'none';
  if (explicit === 'console') return 'console';
  if (env.RESEND_API_KEY) return 'resend';
  return 'console';
}

/** True when a message would actually be delivered to a mailbox (not dev console). */
export function emailDeliveryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const t = resolveEmailTransport(env);
  return t === 'smtp' || t === 'resend';
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendTransactionalEmail(msg: OutboundEmail): Promise<boolean> {
  const transport = resolveEmailTransport();
  const from = process.env.EMAIL_FROM ?? 'Growth Agent <onboarding@resend.dev>';

  try {
    if (transport === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          html: msg.html ?? msg.text,
        }),
      });
      if (!res.ok) {
        log.warn({ status: res.status }, 'resend send failed');
        return false;
      }
      return true;
    }

    if (transport === 'smtp') {
      const { createTransport } = await import('nodemailer');
      const t = createTransport(process.env.EMAIL_SERVER as string);
      await t.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      return true;
    }

    // console / none: dev — log, do not send.
    log.info({ to: msg.to, subject: msg.subject }, 'notification email (console transport)');
    return false;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'notification email error');
    return false;
  }
}
