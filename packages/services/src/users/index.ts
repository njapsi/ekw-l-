import { prisma } from '@growth-agent/db';
import { z } from 'zod';
import { recordAudit } from '../audit/index.js';

/** The current user's profile, creating a default row if none exists. */
export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true },
  });
  if (!user) return null;
  const profile = user.profile ?? (await prisma.userProfile.create({ data: { userId } }));
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    emailVerified: user.emailVerified,
    timezone: profile.timezone,
    locale: profile.locale,
    marketingOptIn: profile.marketingOptIn,
  };
}

export const updateProfileInput = z.object({
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().min(1).max(64).optional(),
  locale: z.string().min(2).max(10).optional(),
  marketingOptIn: z.boolean().optional(),
});

export async function updateProfile(userId: string, raw: z.infer<typeof updateProfileInput>) {
  const input = updateProfileInput.parse(raw);
  const { name, ...profileFields } = input;

  await prisma.$transaction(async (tx) => {
    if (name !== undefined) {
      await tx.user.update({ where: { id: userId }, data: { name } });
    }
    if (Object.keys(profileFields).length > 0) {
      await tx.userProfile.upsert({
        where: { userId },
        update: profileFields,
        create: { userId, ...profileFields },
      });
    }
  });

  await recordAudit({
    actorId: userId,
    action: 'user.profile_updated',
    targetType: 'user',
    targetId: userId,
    metadata: { fields: Object.keys(input) },
  });

  return getProfile(userId);
}

// --- Preferences (small per-user key/value, e.g. UI + notification settings) --

export async function getPreference<T = unknown>(userId: string, key: string): Promise<T | null> {
  const row = await prisma.userPreference.findUnique({
    where: { userId_key: { userId, key } },
  });
  return (row?.value as T) ?? null;
}

export async function setPreference(userId: string, key: string, value: unknown): Promise<void> {
  await prisma.userPreference.upsert({
    where: { userId_key: { userId, key } },
    update: { value: value as never },
    create: { userId, key, value: value as never },
  });
}
