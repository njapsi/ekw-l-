import { edgeAuthConfig } from '@growth-agent/services/auth/edge';
import NextAuth, { type NextAuthResult } from 'next-auth';

/**
 * Edge middleware. Uses the adapter-free auth config so route protection runs
 * without a database round-trip (docs/DECISIONS.md ADR-0011). The authoritative
 * checks (session revocation, active org) run in the `/app` server layout.
 *
 * The explicit annotation avoids TS2742 (the inferred `auth` type is not
 * portably nameable across the monorepo).
 *
 * Correlation ids (Phase 13) are NOT set here: wrapping `auth()` with a handler
 * in this NextAuth beta drops the `?callbackUrl=` on the unauthenticated
 * redirect. Instead the id is resolved from the `x-correlation-id` request
 * header (accepted from a trusted proxy) or minted, in `getCorrelationId()` for
 * server components and in `withRouteObservability` for route handlers — and it
 * lands on every structured log line and every `ErrorEvent`.
 */
const auth: NextAuthResult['auth'] = NextAuth(edgeAuthConfig).auth;

export default auth;

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
