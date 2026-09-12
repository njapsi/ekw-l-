import type { NextAuthConfig } from 'next-auth';
import './session.js';

const PROTECTED_PREFIXES = ['/app', '/admin', '/onboarding'];
const ADMIN_PREFIX = '/admin';

/**
 * Edge-safe Auth.js config. Contains NO adapter and NO providers that pull in
 * Node built-ins, so it can run in middleware. Route protection lives in the
 * `authorized` callback (docs/DECISIONS.md ADR-0011).
 */
export const edgeAuthConfig: NextAuthConfig = {
  // Self-hosted behind a reverse proxy (docs/DEPLOYMENT.md). The proxy is
  // responsible for setting a correct Host/X-Forwarded-Host.
  trustHost: true,
  session: { strategy: 'jwt', maxAge: 60 * 60 * 8 },
  pages: { signIn: '/login', error: '/login' },
  providers: [],
  callbacks: {
    authorized({ request, auth }) {
      const { pathname } = request.nextUrl;
      const isProtected = PROTECTED_PREFIXES.some(
        (p) => pathname === p || pathname.startsWith(`${p}/`),
      );
      if (!isProtected) return true;

      if (!auth?.user) return false; // → redirect to /login?callbackUrl=…

      const isAdminPath = pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
      if (isAdminPath && !auth.user.isPlatformStaff) {
        return Response.redirect(new URL('/app', request.nextUrl));
      }
      return true;
    },
  },
};
