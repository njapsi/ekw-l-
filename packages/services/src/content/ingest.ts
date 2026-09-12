/**
 * SOURCE CONTENT stage — create a `RepurposeProject` from an accepted input.
 *
 * Accepted sources: a synced YouTube video, a video URL (metadata only — the
 * engine does NOT scrape a transcript from a URL, ADR-0023), a pasted
 * transcript, or free-form user-provided content. The user can pair a URL with
 * a pasted transcript/title/description.
 */
import { type Db, type RepurposeSourceType, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';

export type RepurposeSourceInput =
  | { kind: 'youtube_video'; youTubeVideoId: string; transcript?: string }
  | { kind: 'video_url'; url: string; title?: string; description?: string; transcript?: string }
  | { kind: 'transcript'; title?: string; transcript: string }
  | { kind: 'manual'; title?: string; body: string };

const SOURCE_TYPE: Record<RepurposeSourceInput['kind'], RepurposeSourceType> = {
  youtube_video: 'YOUTUBE_VIDEO',
  video_url: 'VIDEO_URL',
  transcript: 'TRANSCRIPT',
  manual: 'MANUAL',
};

const MAX_TEXT = 200_000;

function clampText(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t ? t.slice(0, MAX_TEXT) : null;
}

export interface CreateProjectInput {
  organizationId: string;
  userId: string;
  name?: string;
  source: RepurposeSourceInput;
}

export async function createRepurposeProject(input: CreateProjectInput, db: Db = prisma) {
  const src = input.source;
  const data: {
    sourceType: RepurposeSourceType;
    name: string;
    sourceYouTubeVideoId: string | null;
    sourceUrl: string | null;
    sourceTitle: string | null;
    sourceDescription: string | null;
    sourceTranscript: string | null;
    sourceBody: string | null;
    sourceTags: string[];
    sourceDurationSec: number | null;
  } = {
    sourceType: SOURCE_TYPE[src.kind],
    name: input.name?.trim().slice(0, 200) || 'Untitled project',
    sourceYouTubeVideoId: null,
    sourceUrl: null,
    sourceTitle: null,
    sourceDescription: null,
    sourceTranscript: null,
    sourceBody: null,
    sourceTags: [],
    sourceDurationSec: null,
  };

  if (src.kind === 'youtube_video') {
    const video = await db.youTubeVideo.findFirst({
      where: { id: src.youTubeVideoId, organizationId: input.organizationId },
    });
    if (!video) throw AppError.notFound('YouTube video');
    data.sourceYouTubeVideoId = video.id;
    data.sourceUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    data.sourceTitle = video.title;
    data.sourceDescription = clampText(video.description ?? undefined);
    data.sourceTranscript = clampText(src.transcript);
    data.sourceTags = video.tags.slice(0, 50);
    data.sourceDurationSec = video.durationSeconds ?? null;
    if (!input.name) data.name = `Repurpose: ${video.title}`.slice(0, 200);
  } else if (src.kind === 'video_url') {
    let u: URL;
    try {
      u = new URL(src.url);
    } catch {
      throw AppError.validation('That does not look like a valid URL.');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw AppError.validation('Only http(s) URLs are accepted.');
    }
    data.sourceUrl = u.toString();
    data.sourceTitle = clampText(src.title);
    data.sourceDescription = clampText(src.description);
    data.sourceTranscript = clampText(src.transcript);
    if (!data.sourceTitle && !data.sourceTranscript && !data.sourceDescription) {
      throw AppError.validation(
        'A URL alone is not enough to repurpose. Paste the title, description, or transcript too — the engine does not fetch or transcribe videos.',
      );
    }
    if (!input.name && data.sourceTitle) data.name = `Repurpose: ${data.sourceTitle}`.slice(0, 200);
  } else if (src.kind === 'transcript') {
    data.sourceTitle = clampText(src.title);
    data.sourceTranscript = clampText(src.transcript);
    if (!data.sourceTranscript || data.sourceTranscript.length < 40) {
      throw AppError.validation('Provide a transcript of at least a few sentences.');
    }
    if (!input.name && data.sourceTitle) data.name = `Repurpose: ${data.sourceTitle}`.slice(0, 200);
  } else {
    data.sourceTitle = clampText(src.title);
    data.sourceBody = clampText(src.body);
    if (!data.sourceBody || data.sourceBody.length < 40) {
      throw AppError.validation('Provide at least a few sentences of source content.');
    }
    if (!input.name && data.sourceTitle) data.name = `Repurpose: ${data.sourceTitle}`.slice(0, 200);
  }

  const project = await db.repurposeProject.create({
    data: { organizationId: input.organizationId, createdById: input.userId, ...data },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.project.created',
      targetType: 'repurpose_project',
      targetId: project.id,
      metadata: { sourceType: data.sourceType },
    },
    db,
  );
  return project;
}

export async function archiveRepurposeProject(
  input: { organizationId: string; userId: string; projectId: string },
  db: Db = prisma,
) {
  const project = await db.repurposeProject.findFirst({
    where: { id: input.projectId, organizationId: input.organizationId, deletedAt: null },
  });
  if (!project) throw AppError.notFound('Project');
  await db.repurposeProject.update({
    where: { id: project.id },
    data: { status: 'ARCHIVED', deletedAt: new Date() },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'content.project.archived',
      targetType: 'repurpose_project',
      targetId: project.id,
    },
    db,
  );
}
