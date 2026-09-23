import NextAuth, { type NextAuthResult } from 'next-auth';
import { authConfig } from './config.js';

/**
 * The full (Node-runtime) Auth.js instance: route handlers, server-side
 * `auth()`, and programmatic `signIn` / `signOut`. Middleware must import
 * `@growth-agent/services/auth/edge` instead — it is adapter-free.
 *
 * Members are re-exported with explicit types: in a monorepo the inferred
 * `NextAuth()` return type is not portably nameable (TS2742).
 */
const result = NextAuth(authConfig);

export const handlers: NextAuthResult['handlers'] = result.handlers;
export const auth: NextAuthResult['auth'] = result.auth;
export const signIn: NextAuthResult['signIn'] = result.signIn;
export const signOut: NextAuthResult['signOut'] = result.signOut;
/** Re-issue the current session token (runs the `jwt` callback with trigger 'update'). */
export const updateSession: NextAuthResult['unstable_update'] = result.unstable_update;

export { edgeAuthConfig } from './config.edge.js';
export type { AppSessionUser, SessionOrg } from './session.js';
export { roleForOrg } from './callbacks.js';
export { hashPassword } from './password.js';
export { EmailNotVerifiedError } from './providers.js';
export { runWithRequestContext } from './request-context.js';
export {
  RECENT_AUTH_MS,
  isRecentAuth,
  listUserSessions,
  revokeOtherSessions,
  revokeSessionByHandle,
  validateSession,
} from './sessions.js';
export { registerWithPassword, type SignUpOutcome } from './signup.js';
export { authMethodFor, sessionHandle, SESSION_ABSOLUTE_MS } from './sessions.js';
export {
  startMfaEnrollment,
  confirmMfaEnrollment,
  verifyMfaCode,
  disableMfa,
  hasMfaEnabled,
  getMfaStatus,
  regenerateRecoveryCodes,
  totpUri,
  type StartMfaEnrollmentResult,
  type MfaStatus,
} from './mfa.js';
