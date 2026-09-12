import { describe, expect, it } from 'vitest';
import { checkGroundingFields } from './grounding.js';

const known = new Set(['a.x', 'b.y']);
const numbers = [12000, 3.4];

describe('checkGroundingFields', () => {
  it('passes clean, cited, grounded fields', () => {
    const issues = checkGroundingFields(
      [{ path: 'r[0]', text: 'Followers are about 12,000.', factIds: ['a.x'] }],
      known,
      numbers,
    );
    expect(issues).toEqual([]);
  });

  it('flags an unknown fact id', () => {
    const issues = checkGroundingFields(
      [{ path: 'r[0]', text: 'x', factIds: ['nope'] }],
      known,
      numbers,
    );
    expect(issues[0]?.problem).toMatch(/unknown fact id/);
  });

  it('flags an ungrounded number', () => {
    const issues = checkGroundingFields([{ path: 'r[0]', text: 'CTR was 9.73%.' }], known, numbers);
    expect(issues.some((i) => i.problem.includes('9.73'))).toBe(true);
  });

  it('allows small integers, years and percentages 0-100', () => {
    const issues = checkGroundingFields(
      [{ path: 'r[0]', text: 'Post 3 times a week; in 2026 aim for 45% retention.' }],
      known,
      numbers,
    );
    expect(issues).toEqual([]);
  });

  it('flags guarantee-style phrasing (incl. "go viral")', () => {
    const issues = checkGroundingFields(
      [{ path: 'r[0]', text: 'This guarantees your next video will go viral.' }],
      known,
      numbers,
    );
    expect(issues.some((i) => /guarantee/.test(i.problem))).toBe(true);
  });
});
