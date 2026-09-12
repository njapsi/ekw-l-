import { createHash } from 'node:crypto';
import { type Db, type TikTokPrivacy, type TikTokPublishStatus, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { TT_SCOPE_VIDEO_PUBLISH } from '../integrations/tiktok-oauth.js';
import { type TikTokClient, TikTokApiError } from './client.js';

const log = createLogger('tiktok.publish');

/**
 * Authorized publishing via the Content Posting API. Nothing is ever submitted
 * without an explicit approval flag (master instruction, section K:
 * "Never silently publish"). Phase 4 supports the PULL_FROM_URL source (a
 * publicly reachable direct video URL); FILE_UPLOAD is a follow-up.
 */

export interface CreateDraftInput {
  organizationId: string;
  userId: string;
  accountId: string; // internal TikTokAccount.id
  sourceUrl: string;
  caption: string;
  hashtags?: string[];
  privacy?: TikTokPrivacy;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
}

/** Terminal caption is the caption plus hashtags appended (TikTok "title"). */
export function composeCaption(caption: string, hashtags: string[]): string {
  const tags = hashtags
    .map((h) => (h.startsWith('#') ? h : `#${h}`))
    .filter((h, i, arr) => arr.indexOf(h) === i);
  return [caption.trim(), tags.join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);
}

function contentHash(
  accountId: string,
  sourceUrl: string,
  caption: string,
  hashtags: string[],
): string {
  return createHash('sha256')
    .update(`${accountId}|${sourceUrl}|${caption.trim()}|${[...hashtags].sort().join(',')}`)
    .digest('hex');
}

const ACTIVE_STATUSES: TikTokPublishStatus[] = [
  'AWAITING_APPROVAL',
  'SUBMITTED',
  'PROCESSING',
  'PUBLISHED',
];

export async function createPublishDraft(input: CreateDraftInput, db: Db = prisma) {
  const account = await db.tikTokAccount.findFirst({
    where: { id: input.accountId, organizationId: input.organizationId },
    include: { connection: true },
  });
  if (!account) throw AppError.notFound('TikTok account');
  if (account.connection.status === 'REVOKED') {
    throw new AppError('provider_unavailable', 'This TikTok account is disconnected.');
  }
  if (!account.connection.scopes.includes(TT_SCOPE_VIDEO_PUBLISH)) {
    throw new AppError(
      'permission_denied',
      'Publishing needs the "video.publish" scope. Reconnect TikTok and approve publishing.',
    );
  }

  let url: URL;
  try {
    url = new URL(input.sourceUrl);
  } catch {
    throw AppError.validation('The source video URL is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw AppError.validation('The source video URL must be https.');
  }

  const hashtags = (input.hashtags ?? []).map((h) => h.replace(/^#/, '').trim()).filter(Boolean);
  const hash = contentHash(input.accountId, input.sourceUrl, input.caption, hashtags);

  // Duplicate-publishing guard.
  const dupe = await db.tikTokPublish.findFirst({
    where: {
      tikTokAccountId: input.accountId,
      contentHash: hash,
      status: { in: ACTIVE_STATUSES },
    },
  });
  if (dupe) {
    throw AppError.conflict(
      `An equivalent post is already ${dupe.status.toLowerCase()} (created ${dupe.createdAt.toISOString()}). Change the caption or source to publish a different post.`,
    );
  }

  const draft = await db.tikTokPublish.create({
    data: {
      organizationId: input.organizationId,
      tikTokAccountId: input.accountId,
      status: 'AWAITING_APPROVAL',
      privacy: input.privacy ?? 'SELF_ONLY',
      caption: input.caption,
      hashtags,
      sourceType: 'PULL_FROM_URL',
      sourceUrl: input.sourceUrl,
      disableComment: input.disableComment ?? false,
      disableDuet: input.disableDuet ?? false,
      disableStitch: input.disableStitch ?? false,
      contentHash: hash,
      createdById: input.userId,
    },
  });

  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'tiktok.publish.drafted',
      targetType: 'tiktok_publish',
      targetId: draft.id,
      metadata: { privacy: draft.privacy, sourceType: draft.sourceType },
    },
    db,
  );
  return draft;
}

export interface ApproveInput {
  organizationId: string;
  userId: string;
  publishId: string; // internal TikTokPublish.id
  /** MUST be exactly true. Anything else is refused. */
  approve: boolean;
}

export async function approveAndSubmit(input: ApproveInput, client: TikTokClient, db: Db = prisma) {
  if (input.approve !== true) {
    throw new AppError(
      'automation_disabled',
      'Explicit approval is required before publishing to TikTok.',
    );
  }
  const publish = await db.tikTokPublish.findFirst({
    where: { id: input.publishId, organizationId: input.organizationId },
  });
  if (!publish) throw AppError.notFound('Publish draft');
  if (publish.status !== 'AWAITING_APPROVAL') {
    throw AppError.conflict(
      `This draft is "${publish.status.toLowerCase()}" and cannot be submitted again.`,
    );
  }

  // Re-check dedupe at submit time (race with another approval).
  const dupe = await db.tikTokPublish.findFirst({
    where: {
      tikTokAccountId: publish.tikTokAccountId,
      contentHash: publish.contentHash,
      status: { in: ['SUBMITTED', 'PROCESSING', 'PUBLISHED'] },
      id: { not: publish.id },
    },
  });
  if (dupe) {
    await db.tikTokPublish.update({
      where: { id: publish.id },
      data: { status: 'CANCELLED', error: 'Superseded by an equivalent post.' },
    });
    throw AppError.conflict('An equivalent post was already submitted; this draft was cancelled.');
  }

  const title = composeCaption(publish.caption, publish.hashtags);
  await db.tikTokPublish.update({
    where: { id: publish.id },
    data: {
      status: 'SUBMITTED',
      approvedById: input.userId,
      approvedAt: new Date(),
      submittedAt: new Date(),
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'tiktok.publish.approved',
      targetType: 'tiktok_publish',
      targetId: publish.id,
      metadata: { privacy: publish.privacy },
    },
    db,
  );

  try {
    const res = await client.initDirectPost({
      title,
      privacyLevel: publish.privacy,
      disableComment: publish.disableComment,
      disableDuet: publish.disableDuet,
      disableStitch: publish.disableStitch,
      sourceUrl: publish.sourceUrl!,
    });
    const publishId = res.data.publish_id;
    if (!publishId)
      throw new TikTokApiError('TikTok did not return a publish_id.', 'no_publish_id', 200);

    const updated = await db.tikTokPublish.update({
      where: { id: publish.id },
      data: { status: 'PROCESSING', publishId, lastStatusCheck: new Date() },
    });
    log.info({ publishId, internalId: publish.id }, 'tiktok publish submitted');
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'publish failed';
    await db.tikTokPublish.update({
      where: { id: publish.id },
      data: { status: 'FAILED', error: message },
    });
    await recordAudit(
      {
        organizationId: input.organizationId,
        actorId: input.userId,
        action: 'tiktok.publish.failed',
        targetType: 'tiktok_publish',
        targetId: publish.id,
        metadata: { error: message, code: err instanceof TikTokApiError ? err.code : 'unknown' },
      },
      db,
    );
    throw err;
  }
}

const TERMINAL_OK = new Set(['PUBLISH_COMPLETE']);
const TERMINAL_FAIL = new Set(['FAILED']);

export async function refreshPublishStatus(
  organizationId: string,
  publishRowId: string,
  client: TikTokClient,
  db: Db = prisma,
) {
  const publish = await db.tikTokPublish.findFirst({
    where: { id: publishRowId, organizationId },
  });
  if (!publish) throw AppError.notFound('Publish');
  if (!publish.publishId || !['SUBMITTED', 'PROCESSING'].includes(publish.status)) {
    return publish;
  }

  const res = await client.fetchPublishStatus(publish.publishId);
  const status = res.data.status ?? '';
  let next: TikTokPublishStatus = publish.status;
  let error: string | null = publish.error;
  let completedAt: Date | null = publish.completedAt;

  if (TERMINAL_OK.has(status)) {
    next = 'PUBLISHED';
    completedAt = new Date();
  } else if (TERMINAL_FAIL.has(status)) {
    next = 'FAILED';
    error = res.data.fail_reason ?? 'TikTok reported the post failed.';
  }

  const updated = await db.tikTokPublish.update({
    where: { id: publish.id },
    data: { status: next, error, completedAt, lastStatusCheck: new Date() },
  });

  if (next !== publish.status) {
    await recordAudit(
      {
        organizationId,
        action: next === 'PUBLISHED' ? 'tiktok.publish.completed' : 'tiktok.publish.failed',
        actorType: 'SYSTEM',
        targetType: 'tiktok_publish',
        targetId: publish.id,
        metadata: { tiktokStatus: status },
      },
      db,
    );
  }
  return updated;
}

export function listPublishes(organizationId: string, db: Db = prisma) {
  return db.tikTokPublish.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
