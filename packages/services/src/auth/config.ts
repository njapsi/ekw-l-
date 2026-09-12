import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import type { NextAuthConfig } from 'next-auth';
import { recordAudit } from '../audit/index.js';
import { ensurePersonalOrganization } from '../organizations/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { applyIdentityToToken, tokenToSessionUser } from './callbacks.js';
import { edgeAuthConfig } from './config.edge.js';
import { buildProviders } from './providers.js';
import type { IdentitySnapshot, TokenLike } from './callbacks.js';

const log = createLogger('auth');

/** Magic-link sends per email address per hour (docs/SECURITY.md §8). */
const MAGIC_LINK_LIMIT = 5;

/** Load the full identity snapshot for a user (memberships, staff, version). */
async function loadIdentity(userId: string): Promise<IdentitySnapshot | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      platformStaff: true,
      memberships: {
        where: { status: 'ACTIVE', organization: { deletedAt: null } },
        include: { organization: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!user || user.deletedAt) return null;
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    isPlatformStaff: user.platformStaff !== null,
    sessionVersion: user.sessionVersion,
    orgs: user.memberships.map((m) => ({
      id: m.organization.id,
      slug: m.organization.slug,
      name: m.organization.name,
      role: m.role,
    })),
  };
}

export const authConfig: NextAuthConfig = {
  ...edgeAuthConfig,
  adapter: PrismaAdapter(prisma),
  providers: buildProviders(),
  trustHost: true,
  callbacks: {
    ...edgeAuthConfig.callbacks,
    /**
     * Throttle magic-link *sends* per email address (SECURITY-AUDIT.md H-2):
     * without this an unauthenticated caller can have this app email arbitrary
     * addresses without limit (bombing + sender-reputation abuse). Returning
     * `false` aborts before the link is generated or sent. OAuth / credentials
     * sign-ins are unaffected. The limiter fails open if Redis is down.
     */
    async signIn({ user, email }) {
      if (!email?.verificationRequest) return true;
      const address = (user?.email ?? '').toLowerCase().trim();
      if (!address) return true;
      const rl = await checkRateLimit({
        key: `magic-link:${address}`,
        limit: MAGIC_LINK_LIMIT,
        windowSec: 3600,
      });
      if (!rl.ok) {
        log.warn({ email: address }, 'magic-link send rate-limited');
        return false;
      }
      return true;
    },
    async jwt({ token, user, trigger }) {
      if (user?.id) {
        // Fresh sign-in: make sure the user has at least a personal org.
        await ensurePersonalOrganization({
          id: user.id,
          name: user.name ?? null,
          email: user.email ?? '',
        });
      }
      if (user?.id || trigger === 'update') {
        const uid = user?.id ?? (token as TokenLike).uid;
        if (uid) {
          const snap = await loadIdentity(uid);
          if (snap) return applyIdentityToToken(token, snap);
        }
      }
      return token;
    },
    session({ session, token }) {
      session.user = { ...session.user, ...tokenToSessionUser(token) };
      return session;
    },
  },
  events: {
    async signIn({ user, account }) {
      if (!user.id) return;
      await recordAudit({
        actorId: user.id,
        action: 'auth.sign_in',
        targetType: 'user',
        targetId: user.id,
        metadata: { provider: account?.provider ?? 'unknown' },
      });
      log.info({ userId: user.id, provider: account?.provider }, 'user signed in');
    },
    async signOut(message) {
      const raw = 'token' in message ? message.token?.uid : undefined;
      const userId = typeof raw === 'string' ? raw : undefined;
      if (userId) {
        await recordAudit({
          actorId: userId,
          action: 'auth.sign_out',
          targetType: 'user',
          targetId: userId,
        });
      }
    },
  },
};
