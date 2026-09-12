import type { Role } from '@growth-agent/db';
import type { SessionOrg } from './session.js';

export type TokenLike = {
  uid?: string;
  email?: string | null;
  name?: string | null;
  picture?: string | null;
  orgs?: SessionOrg[];
  isPlatformStaff?: boolean;
  sv?: number;
} & Record<string, unknown>;

export interface IdentitySnapshot {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  orgs: SessionOrg[];
  isPlatformStaff: boolean;
  sessionVersion: number;
}

/**
 * Fold a freshly-loaded identity snapshot into the JWT. Pure so it can be
 * unit-tested without Auth.js. Called on sign-in and on session refresh.
 */
export function applyIdentityToToken(token: TokenLike, snap: IdentitySnapshot): TokenLike {
  return {
    ...token,
    uid: snap.userId,
    email: snap.email,
    name: snap.name,
    picture: snap.image,
    orgs: snap.orgs,
    isPlatformStaff: snap.isPlatformStaff,
    sv: snap.sessionVersion,
  };
}

/** Project the JWT onto the client-facing session object. Pure. */
export function tokenToSessionUser(token: TokenLike) {
  return {
    id: token.uid ?? '',
    email: token.email ?? '',
    name: token.name ?? null,
    image: token.picture ?? null,
    orgs: token.orgs ?? [],
    isPlatformStaff: token.isPlatformStaff ?? false,
    sessionVersion: token.sv ?? 0,
  };
}

export function roleForOrg(orgs: SessionOrg[] | undefined, organizationId: string): Role | null {
  return orgs?.find((o) => o.id === organizationId)?.role ?? null;
}
