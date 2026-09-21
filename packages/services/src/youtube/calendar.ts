/**
 * YouTube content calendar (Phase 6, Parts 37-39). Generation is
 * deterministic composition: opportunities (already evidence-backed, see
 * `opportunities.ts`) become calendar slots at the requested cadence,
 * balanced across topics/formats so one opportunity doesn't fill the whole
 * calendar. Never schedules a real publish — a `YouTubeCalendarEntry` is a
 * plan, not an action (Part 39: "Do not schedule publication unless
 * explicitly requested and authorized" — this module has no publish path at
 * all, by construction).
 */
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';
import type { YouTubeOpportunityDraft } from './opportunities.js';

export interface CalendarEntryDraft {
  scheduledDate: Date;
  title: string;
  format: 'short' | 'long_form';
  rationale: string;
  sourceOpportunityType: string | null;
}

export interface GenerateCalendarInput {
  /** Ranked opportunities to draw ideas from (highest priority first). */
  opportunities: YouTubeOpportunityDraft[];
  /** How many content slots per week. */
  cadencePerWeek: number;
  /** How many weeks to plan. */
  weeks: number;
  startDate: Date;
}

/**
 * Spread cadence*weeks slots evenly across the period, cycling through
 * opportunities so the same one doesn't dominate every slot (Part 39:
 * "balance content themes"). Falls back to a generic planning slot with an
 * honest rationale when there are fewer opportunities than slots — never
 * fabricates a topic.
 */
export function generateCalendarDrafts(input: GenerateCalendarInput): CalendarEntryDraft[] {
  const totalSlots = Math.max(0, Math.round(input.cadencePerWeek * input.weeks));
  if (totalSlots === 0) return [];

  const dayStep = (input.weeks * 7) / totalSlots;
  const drafts: CalendarEntryDraft[] = [];

  for (let i = 0; i < totalSlots; i++) {
    const date = new Date(input.startDate);
    date.setUTCDate(date.getUTCDate() + Math.round(i * dayStep));

    const opp =
      input.opportunities.length > 0 ? input.opportunities[i % input.opportunities.length] : null;
    if (opp) {
      const isShorts = opp.type === 'SHORTS_OPPORTUNITY';
      drafts.push({
        scheduledDate: date,
        title: opp.title,
        format: isShorts ? 'short' : 'long_form',
        rationale: opp.description,
        sourceOpportunityType: opp.type,
      });
    } else {
      drafts.push({
        scheduledDate: date,
        title: `Content slot ${i + 1} — idea not yet assigned`,
        format: 'long_form',
        rationale:
          'No specific opportunity was available for this slot. Run channel analysis or add a content idea manually before this date.',
        sourceOpportunityType: null,
      });
    }
  }

  return drafts;
}

export async function saveCalendarEntries(
  input: {
    organizationId: string;
    youTubeChannelId: string;
    userId: string;
    drafts: CalendarEntryDraft[];
  },
  db: Db = prisma,
): Promise<number> {
  let created = 0;
  for (const d of input.drafts) {
    await db.youTubeCalendarEntry.create({
      data: {
        organizationId: input.organizationId,
        youTubeChannelId: input.youTubeChannelId,
        scheduledDate: d.scheduledDate,
        title: d.title,
        format: d.format,
        status: 'IDEA',
        rationale: d.rationale,
        createdById: input.userId,
      },
    });
    created++;
  }
  return created;
}

export async function listCalendarEntries(
  organizationId: string,
  opts: { from?: Date; to?: Date } = {},
  db: Db = prisma,
) {
  return db.youTubeCalendarEntry.findMany({
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

export async function updateCalendarEntryStatus(
  input: {
    organizationId: string;
    entryId: string;
    status:
      | 'IDEA'
      | 'PLANNED'
      | 'BRIEFED'
      | 'SCRIPTED'
      | 'DRAFT'
      | 'READY'
      | 'APPROVAL_REQUIRED'
      | 'SCHEDULED'
      | 'PUBLISHED'
      | 'ANALYZING'
      | 'COMPLETED'
      | 'CANCELLED';
  },
  db: Db = prisma,
) {
  const entry = await db.youTubeCalendarEntry.findFirst({
    where: { id: input.entryId, organizationId: input.organizationId },
  });
  if (!entry) throw AppError.notFound('Calendar entry');
  // PUBLISHED is a status marker only — this function never calls the
  // YouTube API. A real publish (if this deployment ever gains write scope)
  // would go through its own approval-gated action, exactly like WordPress's
  // publish executor; marking a calendar entry PUBLISHED here only records
  // that the creator says it happened.
  return db.youTubeCalendarEntry.update({
    where: { id: entry.id },
    data: { status: input.status },
  });
}
