import 'server-only';
import { headers } from 'next/headers';

/**
 * The OAuth redirect URI. Must exactly match one registered in the Google Cloud
 * console. Derived from the request origin (or `NEXT_PUBLIC_APP_URL`).
 */
export async function googleRedirectUri(): Promise<string> {
  const h = await headers();
  const origin =
    h.get('origin') ??
    (h.get('host') ? `https://${h.get('host')}` : undefined) ??
    process.env.NEXT_PUBLIC_APP_URL ??
    'http://localhost:3000';
  return `${origin.replace(/\/$/, '')}/api/integrations/google/callback`;
}

export function youtubeConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.ENCRYPTION_KEY,
  );
}

export function analystConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  );
}
