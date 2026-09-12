/**
 * The user-provided business profile. Every field is entered by the user;
 * nothing is inferred from a third party.
 */
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';

export interface BusinessProfileInput {
  niche?: string | null;
  audienceDescription?: string | null;
  offerings?: string[];
  goals?: string[];
  audienceSizeNote?: string | null;
  emailListSize?: number | null;
  hasWebsite?: boolean;
  sellsProducts?: boolean;
  doesSponsorships?: boolean;
  doesAffiliates?: boolean;
  doesConsulting?: boolean;
  hasMembership?: boolean;
  hasCourse?: boolean;
  attestations?: Partial<
    Record<'twoStep' | 'noStrikes' | 'adsenseLinked' | 'regionEligible', boolean>
  > | null;
  notes?: string | null;
}

const trim = (s: string | null | undefined, max = 2000) =>
  s ? s.trim().slice(0, max) || null : null;

export async function getBusinessProfile(organizationId: string, db: Db = prisma) {
  return db.businessProfile.findUnique({ where: { organizationId } });
}

export async function upsertBusinessProfile(
  input: { organizationId: string; userId: string } & BusinessProfileInput,
  db: Db = prisma,
) {
  const data = {
    updatedById: input.userId,
    niche: trim(input.niche, 160),
    audienceDescription: trim(input.audienceDescription, 4000),
    offerings: (input.offerings ?? [])
      .map((o) => o.trim().slice(0, 160))
      .filter(Boolean)
      .slice(0, 30),
    goals: (input.goals ?? [])
      .map((g) => g.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 20),
    audienceSizeNote: trim(input.audienceSizeNote, 200),
    emailListSize:
      input.emailListSize != null && Number.isFinite(input.emailListSize)
        ? Math.max(0, Math.round(input.emailListSize))
        : null,
    hasWebsite: Boolean(input.hasWebsite),
    sellsProducts: Boolean(input.sellsProducts),
    doesSponsorships: Boolean(input.doesSponsorships),
    doesAffiliates: Boolean(input.doesAffiliates),
    doesConsulting: Boolean(input.doesConsulting),
    hasMembership: Boolean(input.hasMembership),
    hasCourse: Boolean(input.hasCourse),
    attestations: (input.attestations ?? undefined) as never,
    notes: trim(input.notes, 8000),
  };
  const profile = await db.businessProfile.upsert({
    where: { organizationId: input.organizationId },
    create: { organizationId: input.organizationId, ...data },
    update: data,
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'monetization.profile.saved',
      targetType: 'business_profile',
      targetId: profile.id,
    },
    db,
  );
  return profile;
}
