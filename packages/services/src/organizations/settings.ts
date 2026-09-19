import { type Db, prisma, requireMembership } from '@growth-agent/db';
import { z } from 'zod';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac/authorize.js';
import { slugify } from './slug.js';

/** IANA time-zone check via the runtime's own zone database. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    // RangeError: not a zone this runtime knows.
    return false;
  }
}

export const updateOrganizationInput = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(80).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/,
      'Slug: 3–40 lowercase letters, digits or dashes.',
    )
    .optional(),
  timezone: z
    .string()
    .trim()
    .refine(isValidTimeZone, 'Unknown time zone (use an IANA name such as Europe/Paris).')
    .optional(),
  defaultLocale: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Language: a code such as en or en-US.')
    .optional(),
});

export async function getOrganizationSettings(
  actorUserId: string,
  organizationId: string,
  db: Db = prisma,
) {
  const m = await requireMembership(actorUserId, organizationId, db);
  authorize({ userId: actorUserId, role: m.role, membershipStatus: m.status }, 'organization.view');
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      type: true,
      timezone: true,
      defaultLocale: true,
      createdAt: true,
      deletionScheduledAt: true,
    },
  });
  if (!org) throw AppError.notFound('Organization');
  return org;
}

export async function updateOrganizationSettings(
  actorUserId: string,
  organizationId: string,
  raw: z.input<typeof updateOrganizationInput>,
  db: Db = prisma,
) {
  const input = updateOrganizationInput.parse(raw);
  const m = await requireMembership(actorUserId, organizationId, db);
  authorize(
    { userId: actorUserId, role: m.role, membershipStatus: m.status },
    'organization.update',
  );

  const current = await db.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, slug: true, timezone: true, defaultLocale: true },
  });
  if (!current) throw AppError.notFound('Organization');

  if (input.slug && input.slug !== current.slug) {
    if (slugify(input.slug) !== input.slug) throw AppError.validation('That slug is not allowed.');
    const taken = await db.organization.findUnique({
      where: { slug: input.slug },
      select: { id: true },
    });
    if (taken) throw AppError.conflict('That slug is already taken.');
  }

  const changes: Record<string, { from: string; to: string }> = {};
  for (const key of ['name', 'slug', 'timezone', 'defaultLocale'] as const) {
    const next = input[key];
    if (next !== undefined && next !== current[key])
      changes[key] = { from: current[key], to: next };
  }
  if (Object.keys(changes).length === 0) return current;

  const updated = await db.organization.update({
    where: { id: organizationId },
    data: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])),
    select: { name: true, slug: true, timezone: true, defaultLocale: true },
  });
  await recordAudit(
    {
      organizationId,
      actorId: actorUserId,
      action: 'organization.updated',
      targetType: 'organization',
      targetId: organizationId,
      metadata: { changes },
    },
    db,
  );
  return updated;
}
