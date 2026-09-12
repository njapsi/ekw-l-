import type { Role } from '@growth-agent/db';

/** One organization the signed-in user belongs to, as carried in the session. */
export interface SessionOrg {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

/** Shape we attach to `session.user` and to the JWT. */
export interface AppSessionUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  orgs: SessionOrg[];
  isPlatformStaff: boolean;
  /** Matches `User.sessionVersion` at issue time; used for revocation. */
  sessionVersion: number;
}

declare module 'next-auth' {
  interface Session {
    user: AppSessionUser & { email: string };
  }
}

/** Extra claims we stash on the JWT (augmentation of `next-auth/jwt` is avoided
 *  because its module types are not always resolvable under bundler
 *  resolution — callbacks cast to this shape instead). */
export interface AppJwtClaims {
  uid?: string;
  orgs?: SessionOrg[];
  isPlatformStaff?: boolean;
  sv?: number;
}
