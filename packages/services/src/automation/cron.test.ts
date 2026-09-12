import { describe, expect, it } from 'vitest';
import {
  CronError,
  cronForCadence,
  describeCron,
  isValidCron,
  matches,
  nextRunAfter,
  parseCron,
} from './cron.js';

describe('parseCron', () => {
  it('parses wildcards, lists, ranges and steps', () => {
    const c = parseCron('*/15 9-17 1,15 * 1-5');
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect([...c.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...c.dom]).toEqual([1, 15]);
    expect(c.month.size).toBe(12);
    expect([...c.dow]).toEqual([1, 2, 3, 4, 5]);
    expect(c.domRestricted).toBe(true);
    expect(c.dowRestricted).toBe(true);
  });

  it('normalises day-of-week 7 to Sunday (0)', () => {
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0]);
  });

  it('rejects malformed expressions', () => {
    for (const bad of [
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      'a * * * *',
      '5-2 * * * *',
    ]) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }
    expect(isValidCron('0 9 * * 1')).toBe(true);
    expect(isValidCron('nope')).toBe(false);
  });
});

describe('nextRunAfter', () => {
  it('finds the next daily slot', () => {
    const from = new Date('2026-03-02T10:00:00Z');
    expect(nextRunAfter('0 9 * * *', from).toISOString()).toBe('2026-03-03T09:00:00.000Z');
  });

  it('finds the next Monday for a weekly schedule', () => {
    // 2026-03-02 is a Monday; 09:00 has passed so the next is the following Monday.
    const from = new Date('2026-03-02T09:30:00Z');
    const next = nextRunAfter('0 9 * * 1', from);
    expect(next.getUTCDay()).toBe(1);
    expect(next.toISOString()).toBe('2026-03-09T09:00:00.000Z');
  });

  it('finds the next month for a monthly schedule', () => {
    const from = new Date('2026-03-15T00:00:00Z');
    expect(nextRunAfter('0 6 1 * *', from).toISOString()).toBe('2026-04-01T06:00:00.000Z');
  });

  it('is exclusive of `from`', () => {
    const from = new Date('2026-03-02T09:00:00Z');
    expect(nextRunAfter('0 9 * * *', from).toISOString()).toBe('2026-03-03T09:00:00.000Z');
  });

  it('throws for a schedule that never fires', () => {
    expect(() => nextRunAfter('0 0 30 2 *', new Date('2026-01-01T00:00:00Z'))).toThrow(CronError);
  });
});

describe('matches — dom/dow semantics', () => {
  it('when both dom and dow are restricted, either match fires (standard cron)', () => {
    const c = parseCron('0 0 13 * 5'); // 13th OR Friday
    expect(matches(c, new Date('2026-02-13T00:00:00Z'))).toBe(true); // Friday the 13th
    expect(matches(c, new Date('2026-02-06T00:00:00Z'))).toBe(true); // a Friday
    expect(matches(c, new Date('2026-03-13T00:00:00Z'))).toBe(true); // the 13th (a Friday too)
    expect(matches(c, new Date('2026-02-10T00:00:00Z'))).toBe(false); // neither
  });
});

describe('cronForCadence + describeCron', () => {
  it('builds daily / weekly / monthly expressions', () => {
    expect(cronForCadence('DAILY', { hour: 8, minute: 30 })).toBe('30 8 * * *');
    expect(cronForCadence('WEEKLY', { hour: 9, weekday: 1 })).toBe('0 9 * * 1');
    expect(cronForCadence('MONTHLY', { hour: 7, monthday: 15 })).toBe('0 7 15 * *');
  });

  it('clamps out-of-range knobs', () => {
    expect(cronForCadence('WEEKLY', { hour: 99, weekday: 12 })).toBe('0 23 * * 6');
    expect(cronForCadence('MONTHLY', { monthday: 40 })).toBe('0 9 28 * *');
  });

  it('describes common schedules in plain language', () => {
    expect(describeCron('0 9 * * 1')).toBe('Every Monday at 09:00 UTC');
    expect(describeCron('30 6 * * *')).toBe('Every day at 06:30 UTC');
    expect(describeCron('0 0 1 * *')).toBe('On day 1 of each month at 00:00 UTC');
  });
});
