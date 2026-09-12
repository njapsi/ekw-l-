import 'server-only';

/** GSC shares the Google OAuth client + `ENCRYPTION_KEY` with YouTube. */
export function searchConsoleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
    process.env.ENCRYPTION_KEY,
  );
}

export { googleRedirectUri } from './youtube';
