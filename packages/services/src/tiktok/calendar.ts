/**
 * TikTok content-plan (calendar) generation (Phase 7, mirroring
 * `youtube/calendar.ts`). Pure and deterministic: spreads slots evenly
 * across the requested window, cycling through ranked opportunities rather
 * than repeating only the top one, and never fabricates a topic for an
 * empty slot.
 */
import { type Db, prisma } from '@growth-agent/db';
import type { TikTokContentPlanStatus } from '@growth-agent/db';
import { AppError } from '../errors.js';
import type { TikTokOpportunityDraft } from './opportunities.js';

export interface GenerateContentPlanInput {
  opportunities: TikTokOpportunityDraft[];
  cadencePerWeek: number;
  weeks: number;
  startDate: Date;
}

export interface ContentPlanEntryDraft {
  scheduledDate: Date;
  title: string;
  format: 'short' | 'extended';
  rationale: string;
  sourceOpportunityType: TikTokOpportunityDraft['type'] | null;
  relatedVideoIds: string[];
}

export function generateContentPlanDrafts(
  input: GenerateContentPlanInput,
): ContentPlanEntryDraft[] {
  const totalSlots = Math.max(0, Math.round(input.cadencePerWeek * input.weeks));
  if (totalSlots === 0) return [];

  const totalDays = input.weeks * 7;
  const dayStep = totalDays / totalSlots;
  const drafts: ContentPlanEntryDraft[] = [];

  for (let i = 0; i < totalSlots; i++) {
    const scheduledDate = new Date(input.startDate);
    scheduledDate.setUTCDate(scheduledDate.getUTCDate() + Math.round(i * dayStep));

    const opportunity =
      input.opportunities.length > 0 ? input.opportunities[i % input.opportunities.length]! : null;

    if (!opportunity) {
      drafts.push({
        scheduledDate,
        title: `Content slot ${i + 1} — idea not yet assigned`,
        format: 'short',
        rationale:
          'No content opportunities are available yet. Regenerate after syncing more videos.',
        sourceOpportunityType: null,
        relatedVideoIds: [],
      });
      continue;
    }

    const isShortFormat = opportunity.type !== 'EXTENDED_FORMAT_OPPORTUNITY';
    drafts.push({
      scheduledDate,
      title: opportunity.title,
      format: isShortFormat ? 'short' : 'extended',
      rationale: opportunity.description,
      sourceOpportunityType: opportunity.type,
      relatedVideoIds: opportunity.relatedVideoIds,
    });
  }

  return drafts;
}

export async function saveContentPlanEntries(
  input: {
    organizationId: string;
    tikTokAccountId: string;
    userId: string;
    drafts: ContentPlanEntryDraft[];
  },
  db: Db = prisma,
) {
  const created = [];
  for (const d of input.drafts) {
    created.push(
      await db.tikTokContentPlan.create({
        data: {
          organizationId: input.organizationId,
          tikTokAccountId: input.tikTokAccountId,
          scheduledDate: d.scheduledDate,
          title: d.title,
          format: d.format,
          rationale: d.rationale,
          status: 'IDEA',
          createdById: input.userId,
        },
      }),
    );
  }
  return created;
}

export async function listContentPlanEntries(
  organizationId: string,
  opts: { from?: Date; to?: Date } = {},
  db: Db = prisma,
) {
  return db.tikTokContentPlan.findMany({
    where: {
      organizationId,
      ...(opts.from || opts.to
        ? {
            scheduledDate: {
              ...(opts.from ? { gte: opts.from } : {}),
              ...(opts.to ? { lte: opts.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { scheduledDate: 'asc' },
  });
}

/**
 * `PUBLISHED` here is a status marker the user sets, not a signal that this
 * function calls the TikTok API — actual publishing goes through the
 * separate, already-audited `publish.ts` draft/approve/submit flow.
 */
export async function updateContentPlanStatus(
  input: { organizationId: string; entryId: string; status: TikTokContentPlanStatus },
  db: Db = prisma,
) {
  const entry = await db.tikTokContentPlan.findFirst({
    where: { id: input.entryId, organizationId: input.organizationId },
  });
  if (!entry) throw AppError.notFound('Content plan entry');
  return db.tikTokContentPlan.update({ where: { id: entry.id }, data: { status: input.status } });
}
