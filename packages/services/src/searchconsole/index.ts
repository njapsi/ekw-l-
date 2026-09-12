export * from './client.js';
export * from './schemas.js';
export * from './google-client.js';
export * from './fixtures-client.js';
export * from './resilient-client.js';
export * from './connect.js';
export * from './sites.js';
export * from './read.js';
export * from './correlate.js';
export * from './agent-tools.js';
export * from './jobs.js';

/** True when the Google OAuth client + encryption key needed for GSC are set. */
export function searchConsoleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.ENCRYPTION_KEY,
  );
}
