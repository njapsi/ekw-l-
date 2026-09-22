import { describe, expect, it } from 'vitest';
import { evaluateMissionPolicy, lookupToolRisk, type MissionPolicyInput } from './policy.js';

function input(overrides: Partial<MissionPolicyInput> = {}): MissionPolicyInput {
  return {
    allowedPlatforms: ['YOUTUBE'],
    allowedActions: [],
    autonomyLevel: 'ASSISTED',
    alwaysApproveRisks: [],
    ...overrides,
  };
}

describe('lookupToolRisk', () => {
  it('is LOW for a task with no tool (a pure human-decision point)', () => {
    expect(lookupToolRisk(null)).toBe('LOW');
  });

  it('is LOW for a real read tool', () => {
    expect(lookupToolRisk('youtube.content.performance')).toBe('LOW');
  });

  it('is MEDIUM for a real propose-only ACTION tool', () => {
    expect(lookupToolRisk('wordpress.content.update.propose')).toBe('MEDIUM');
  });

  it('never assumes an unrecognized tool name is safe', () => {
    expect(lookupToolRisk('not.a.real.tool')).toBe('HIGH');
  });
});

describe('evaluateMissionPolicy — platform/action boundaries', () => {
  it('refuses a platform the mission does not allow', () => {
    const d = evaluateMissionPolicy(input({ allowedPlatforms: ['TIKTOK'] }), {
      platform: 'YOUTUBE',
      toolName: 'youtube.content.performance',
    });
    expect(d.permitted).toBe(false);
  });

  it('allows any platform when CROSS_PLATFORM is declared', () => {
    const d = evaluateMissionPolicy(input({ allowedPlatforms: ['CROSS_PLATFORM'] }), {
      platform: 'SEO',
      toolName: null,
    });
    expect(d.permitted).toBe(true);
  });

  it('refuses a tool outside the mission\'s allowedActions allowlist', () => {
    const d = evaluateMissionPolicy(input({ allowedActions: ['youtube.content'] }), {
      platform: 'YOUTUBE',
      toolName: 'wordpress.content.draft',
    });
    expect(d.permitted).toBe(false);
  });

  it('an empty allowedActions list means no restriction', () => {
    const d = evaluateMissionPolicy(input({ allowedActions: [] }), {
      platform: 'YOUTUBE',
      toolName: 'youtube.content.performance',
    });
    expect(d.permitted).toBe(true);
  });
});

describe('evaluateMissionPolicy — autonomy levels', () => {
  it('LOW risk auto-runs at every autonomy level, including ADVISORY', () => {
    for (const autonomyLevel of ['ADVISORY', 'ASSISTED', 'SUPERVISED', 'CONTROLLED'] as const) {
      const d = evaluateMissionPolicy(input({ autonomyLevel }), {
        platform: 'YOUTUBE',
        toolName: 'youtube.content.performance',
      });
      expect(d.permitted).toBe(true);
      expect(d.autoExecutable).toBe(true);
    }
  });

  it('ADVISORY never permits a MEDIUM+ risk action, even the propose-only kind', () => {
    const d = evaluateMissionPolicy(input({ autonomyLevel: 'ADVISORY' }), {
      platform: 'YOUTUBE',
      toolName: 'wordpress.content.update.propose',
    });
    expect(d.permitted).toBe(false);
  });

  it('ASSISTED permits a MEDIUM-risk task but never auto-executes it', () => {
    const d = evaluateMissionPolicy(input({ autonomyLevel: 'ASSISTED' }), {
      platform: 'YOUTUBE',
      toolName: 'wordpress.content.update.propose',
    });
    expect(d.permitted).toBe(true);
    expect(d.autoExecutable).toBe(false);
  });

  it('SUPERVISED still requires an explicit human trigger for MEDIUM risk', () => {
    const d = evaluateMissionPolicy(input({ autonomyLevel: 'SUPERVISED' }), {
      platform: 'YOUTUBE',
      toolName: 'wordpress.content.update.propose',
    });
    expect(d.permitted).toBe(true);
    expect(d.autoExecutable).toBe(false);
  });

  it('CONTROLLED auto-executes a MEDIUM-risk pre-approved action class', () => {
    const d = evaluateMissionPolicy(input({ autonomyLevel: 'CONTROLLED' }), {
      platform: 'YOUTUBE',
      toolName: 'wordpress.content.update.propose',
    });
    expect(d.permitted).toBe(true);
    expect(d.autoExecutable).toBe(true);
  });

  it('HIGH/CRITICAL risk is never auto-executable at any autonomy level, including CONTROLLED', () => {
    // tiktok.content.publish.draft is MEDIUM in the real registry; simulate a
    // HIGH-risk tool via an unrecognized name (defaults to HIGH, never LOW).
    for (const autonomyLevel of ['SUPERVISED', 'CONTROLLED'] as const) {
      const d = evaluateMissionPolicy(input({ autonomyLevel }), {
        platform: 'YOUTUBE',
        toolName: 'unknown.dangerous.tool',
      });
      expect(d.autoExecutable).toBe(false);
    }
  });

  it('a mission-configured alwaysApprove risk overrides an autonomy level that would otherwise auto-execute', () => {
    const d = evaluateMissionPolicy(
      input({ autonomyLevel: 'CONTROLLED', alwaysApproveRisks: ['MEDIUM'] }),
      { platform: 'YOUTUBE', toolName: 'wordpress.content.update.propose' },
    );
    expect(d.permitted).toBe(true);
    expect(d.autoExecutable).toBe(false);
  });
});
