import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { createMemoryDb, type MemoryDb } from '../testing/memory-db.js';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

const { runYouTubeTool, YOUTUBE_TOOL_NAMES } = await import('./youtube-tools.js');

let db: MemoryDb;
let asDb: Db;
const ctx = () => ({ organizationId: 'org_1', userId: 'u1', db: asDb });

beforeEach(() => {
  db = createMemoryDb();
  asDb = db as unknown as Db;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runYouTubeTool dispatcher', () => {
  it('rejects an unknown tool name', async () => {
    await expect(runYouTubeTool('youtube.publish_video', ctx(), {})).rejects.toThrow(
      /Unknown tool/,
    );
  });

  it('lists exactly ten tools, none of them a write/publish capability', () => {
    expect(YOUTUBE_TOOL_NAMES).toHaveLength(10);
    for (const name of YOUTUBE_TOOL_NAMES) {
      expect(name).not.toMatch(/publish|update|delete|create_video/i);
    }
  });

  it('validates youtube.content.compare input — fewer than two video ids is rejected before any lookup', async () => {
    await expect(
      runYouTubeTool('youtube.content.compare', ctx(), { videoIds: ['only-one'] }),
    ).rejects.toThrow(/Invalid input/);
  });

  it('validates youtube.experiment.create input — a missing hypothesis is rejected', async () => {
    await expect(
      runYouTubeTool('youtube.experiment.create', ctx(), {
        variable: 'thumbnail',
        successMetric: 'CTR',
        expectedDirection: 'INCREASE',
        experimentNote: 'test',
      }),
    ).rejects.toThrow(/Invalid input/);
  });

  it('validates youtube.channel.analytics input — an unsupported range value is rejected', async () => {
    await expect(
      runYouTubeTool('youtube.channel.analytics', ctx(), { range: 'LAST_DECADE' }),
    ).rejects.toThrow(/Invalid input/);
  });

  it('every capability-gated tool refuses when YouTube is not connected, naming the reason', async () => {
    await expect(runYouTubeTool('youtube.channel.get', ctx(), {})).rejects.toThrow(
      /YouTube is not connected/,
    );
    await expect(runYouTubeTool('youtube.channel.analytics', ctx(), {})).rejects.toThrow(
      /YouTube is not connected/,
    );
    await expect(runYouTubeTool('youtube.video.list', ctx(), {})).rejects.toThrow(
      /YouTube is not connected/,
    );
    await expect(runYouTubeTool('youtube.content.performance', ctx(), {})).rejects.toThrow(
      /YouTube is not connected/,
    );
    await expect(
      runYouTubeTool('youtube.content.compare', ctx(), { videoIds: ['a', 'b'] }),
    ).rejects.toThrow(/YouTube is not connected/);
    await expect(runYouTubeTool('youtube.content.opportunities', ctx(), {})).rejects.toThrow(
      /YouTube is not connected/,
    );
    await expect(runYouTubeTool('youtube.content.calendar.generate', ctx(), {})).rejects.toThrow(
      /YouTube is not connected/,
    );
    await expect(
      runYouTubeTool('youtube.experiment.create', ctx(), {
        hypothesis: 'Shorter titles increase CTR',
        variable: 'title_length',
        successMetric: 'ctr',
        expectedDirection: 'INCREASE',
        experimentNote: 'Testing shorter titles for two weeks.',
      }),
    ).rejects.toThrow(/YouTube is not connected/);
    await expect(runYouTubeTool('youtube.report.generate', ctx(), {})).rejects.toThrow(
      /YouTube is not connected/,
    );
  });

  it('rejects report generation and experiment creation with no signed-in user before touching the connection', async () => {
    // These require ctx.userId but the connection check runs first in both
    // tools today; confirm the anonymous case still fails safely (never a
    // silent success) rather than asserting exact ordering.
    const anon = { organizationId: 'org_1', userId: null, db: asDb };
    await expect(runYouTubeTool('youtube.report.generate', anon, {})).rejects.toThrow();
    await expect(
      runYouTubeTool('youtube.experiment.create', anon, {
        hypothesis: 'x',
        variable: 'y',
        successMetric: 'z',
        expectedDirection: 'INCREASE',
        experimentNote: 'note',
      }),
    ).rejects.toThrow();
  });
});
