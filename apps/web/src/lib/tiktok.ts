import 'server-only';
import { headers } from 'next/headers';

export async function tiktokRedirectUri(): Promise<string> {
  const h = await headers();
  const origin =
    h.get('origin') ??
    (h.get('host') ? `https://${h.get('host')}` : undefined) ??
    process.env.NEXT_PUBLIC_APP_URL ??
    'http://localhost:3000';
  return `${origin.replace(/\/$/, '')}/api/integrations/tiktok/callback`;
}

export function tiktokConfigured(): boolean {
  return Boolean(
    process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.ENCRYPTION_KEY,
  );
}

export function analystConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  );
}

export const TIKTOK_PKCE_COOKIE = 'tt_pkce';
