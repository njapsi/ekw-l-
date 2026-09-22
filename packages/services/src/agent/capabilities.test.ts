import { describe, expect, it, vi } from 'vitest';
import type { OrgContext } from './context.js';
import type { CapabilityContext } from './capabilities.js';

const executeAgentTool = vi.fn();
vi.mock('./tool-executor.js', () => ({
  executeAgentTool: (...args: unknown[]) => executeAgentTool(...args),
}));

const { CAPABILITY_BY_ID } = await import('./capabilities.js');

function orgContext(overrides: Partial<OrgContext> = {}): OrgContext {
  return {
    youtube: {
      connected: true,
      channelTitle: 'Test Channel',
      subscriberCount: '1000',
      videoCount: 20,
      lastSyncedAt: new Date(),
      hasAnalytics: true,
    },
    tiktok: { connected: false, displayName: null, hasStats: false, lastSyncedAt: null },
    seo: { websites: 0, verifiedWebsites: 0, latestCrawl: null },
    openTasks: 0,
    recentRecommendations: 0,
    ...overrides,
  };
}

function ctx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    organizationId: 'org_1',
    userId: 'user_1',
    db: {} as never,
    message: 'what content opportunities do I have',
    orgContext: orgContext(),
    goals: [],
    agentRunId: 'run_1',
    ...overrides,
  };
}

describe('youtube-growth capability', () => {
  it('reports needs_prerequisite when YouTube is not connected, without calling any tool', async () => {
    executeAgentTool.mockClear();
    const cap = CAPABILITY_BY_ID.get('youtube-growth')!;
    const result = await cap.run(
      ctx({ orgContext: orgContext({ youtube: { ...orgContext().youtube, connected: false } }) }),
    );
    expect(result.status).toBe('needs_prerequisite');
    expect(executeAgentTool).not.toHaveBeenCalled();
  });

  it('dispatches through executeAgentTool for performance, patterns, and opportunities', async () => {
    executeAgentTool.mockReset();
    executeAgentTool.mockImplementation(async (_c: unknown, tool: string) => {
      if (tool === 'youtube.content.performance') {
        return { status: 'SUCCESS', data: { benchmarks: [{ classification: 'OUTPERFORMING' }] } };
      }
      if (tool === 'youtube.content.patterns') {
        return { status: 'SUCCESS', data: { patterns: [] } };
      }
      return {
        status: 'SUCCESS',
        data: {
          opportunities: [
            {
              title: 'Expand topic X',
              description: 'Evidence-backed.',
              evidence: [{ statement: 'seen in 5 videos' }],
              recommendedActions: ['Make 3 more videos on this topic'],
              priorityScore: 0.8,
              confidence: 'HIGH',
              relatedVideoIds: ['v1'],
            },
          ],
        },
      };
    });
    const cap = CAPABILITY_BY_ID.get('youtube-growth')!;
    const result = await cap.run(ctx());
    expect(result.status).toBe('ok');
    expect(executeAgentTool).toHaveBeenCalledTimes(3);
    expect(executeAgentTool).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1', agentRunId: 'run_1' }),
      'youtube.content.performance',
      expect.anything(),
    );
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]!.title).toBe('Expand topic X');
    // "not a virality prediction / not a guarantee" is the required
    // disclaiming phrasing itself — only a positive guarantee/virality claim
    // would violate hard rule 2.
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toMatch(/is guaranteed|will guarantee|guaranteed to/);
    expect(text).not.toMatch(/will go viral|make this go viral|will be viral/);
  });

  it('returns needs_prerequisite (not a crash) when every underlying tool call fails', async () => {
    executeAgentTool.mockReset();
    executeAgentTool.mockResolvedValue({
      status: 'FAILED',
      error: { message: 'No YouTube channel has been synced yet.' },
    });
    const cap = CAPABILITY_BY_ID.get('youtube-growth')!;
    const result = await cap.run(ctx());
    expect(result.status).toBe('needs_prerequisite');
  });
});

describe('tiktok-growth capability', () => {
  it('reports needs_prerequisite when TikTok is not connected, without calling any tool', async () => {
    executeAgentTool.mockClear();
    const cap = CAPABILITY_BY_ID.get('tiktok-growth')!;
    const result = await cap.run(ctx());
    expect(result.status).toBe('needs_prerequisite');
    expect(executeAgentTool).not.toHaveBeenCalled();
  });

  it('dispatches through executeAgentTool for performance, patterns, and opportunities', async () => {
    executeAgentTool.mockReset();
    executeAgentTool.mockImplementation(async (_c: unknown, tool: string) => {
      if (tool === 'tiktok.content.performance') {
        return { status: 'SUCCESS', data: { benchmarks: [{ classification: 'OUTPERFORMING' }] } };
      }
      if (tool === 'tiktok.content.patterns') {
        return { status: 'SUCCESS', data: { patterns: [] } };
      }
      return {
        status: 'SUCCESS',
        data: {
          opportunities: [
            {
              title: 'Expand #fyp content',
              description: 'Evidence-backed.',
              evidence: [{ statement: 'seen in 5 videos' }],
              recommendedActions: ['Make 3 more videos with this hashtag'],
              priorityScore: 0.8,
              confidence: 'HIGH',
              relatedVideoIds: ['v1'],
            },
          ],
        },
      };
    });
    const cap = CAPABILITY_BY_ID.get('tiktok-growth')!;
    const result = await cap.run(
      ctx({
        orgContext: orgContext({
          tiktok: {
            connected: true,
            displayName: 'Test',
            hasStats: true,
            lastSyncedAt: new Date(),
          },
        }),
      }),
    );
    expect(result.status).toBe('ok');
    expect(executeAgentTool).toHaveBeenCalledTimes(3);
    expect(executeAgentTool).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1', agentRunId: 'run_1' }),
      'tiktok.content.performance',
      expect.anything(),
    );
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]!.title).toBe('Expand #fyp content');
    const text = JSON.stringify(result).toLowerCase();
    expect(text).not.toMatch(/is guaranteed|will guarantee|guaranteed to/);
    expect(text).not.toMatch(/will go viral|make this go viral|will be viral/);
  });

  it('returns needs_prerequisite (not a crash) when every underlying tool call fails', async () => {
    executeAgentTool.mockReset();
    executeAgentTool.mockResolvedValue({
      status: 'FAILED',
      error: { message: 'No TikTok account has been synced yet.' },
    });
    const cap = CAPABILITY_BY_ID.get('tiktok-growth')!;
    const result = await cap.run(
      ctx({
        orgContext: orgContext({
          tiktok: {
            connected: true,
            displayName: 'Test',
            hasStats: true,
            lastSyncedAt: new Date(),
          },
        }),
      }),
    );
    expect(result.status).toBe('needs_prerequisite');
  });
});
