import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { createRepurposeProject } from './ingest.js';

const VIDEO = {
  id: 'yt_1',
  organizationId: 'org_1',
  videoId: 'abc123',
  title: 'How to grow a channel',
  description: 'A long description about growing a channel and staying consistent.',
  tags: ['youtube', 'growth', 'creator'],
  durationSeconds: 720,
};

function fakeDb() {
  const projects: any[] = [];
  const audit: any[] = [];
  return {
    projects,
    audit,
    youTubeVideo: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === VIDEO.id && where.organizationId === VIDEO.organizationId ? VIDEO : null,
      ),
    },
    repurposeProject: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `p${projects.length}`, status: 'DRAFT', ...data };
        projects.push(row);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        audit.push(data);
        return {};
      }),
    },
  };
}

describe('createRepurposeProject', () => {
  it('builds a project from a synced YouTube video (+ optional transcript)', async () => {
    const db = fakeDb();
    const p = await createRepurposeProject(
      {
        organizationId: 'org_1',
        userId: 'u1',
        source: {
          kind: 'youtube_video',
          youTubeVideoId: 'yt_1',
          transcript: 'So today I want to talk about consistency.',
        },
      },
      db as never,
    );
    expect(p).toMatchObject({ sourceType: 'YOUTUBE_VIDEO', sourceTitle: VIDEO.title });
    expect(p.sourceUrl).toContain('abc123');
    expect(p.sourceTranscript).toMatch(/consistency/);
    expect(p.sourceTags).toEqual(VIDEO.tags);
    expect(db.audit.some((a) => a.action === 'content.project.created')).toBe(true);
  });

  it('refuses a video from another org', async () => {
    const db = fakeDb();
    await expect(
      createRepurposeProject(
        {
          organizationId: 'org_2',
          userId: 'u1',
          source: { kind: 'youtube_video', youTubeVideoId: 'yt_1' },
        },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'resource_not_found');
  });

  it('accepts a pasted transcript', async () => {
    const db = fakeDb();
    const p = await createRepurposeProject(
      {
        organizationId: 'org_1',
        userId: 'u1',
        source: {
          kind: 'transcript',
          title: 'My talk',
          transcript: 'This is a reasonably long transcript with several sentences of content.',
        },
      },
      db as never,
    );
    expect(p.sourceType).toBe('TRANSCRIPT');
  });

  it('rejects a bare video URL with no text (no fetching / transcribing)', async () => {
    const db = fakeDb();
    await expect(
      createRepurposeProject(
        {
          organizationId: 'org_1',
          userId: 'u1',
          source: { kind: 'video_url', url: 'https://youtu.be/abc' },
        },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
  });

  it('rejects too-short manual content', async () => {
    const db = fakeDb();
    await expect(
      createRepurposeProject(
        { organizationId: 'org_1', userId: 'u1', source: { kind: 'manual', body: 'too short' } },
        db as never,
      ),
    ).rejects.toSatisfy((e) => isAppError(e) && e.code === 'validation_failed');
  });
});
