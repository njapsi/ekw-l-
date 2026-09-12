/**
 * A tiny 5-field cron parser + "next run after" evaluator (ADR-0027).
 *
 * Fields: `minute hour day-of-month month day-of-week`.
 *   - `*`            every value
 *   - `a`            a single value
 *   - `a-b`          an inclusive range
 *   - `a,b,c`        a list
 *   - `* / n`        a step over the whole range
 *   - `a-b/n`        a step over a range
 * day-of-week: 0-6 (0 = Sunday). `7` is accepted as Sunday too.
 *
 * Schedules are evaluated in **UTC**. No dependency, no timezone database.
 * `AutomationRule.timezone` is stored for a future enhancement.
 */

const RANGES: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

type FieldName = 'minute' | 'hour' | 'dom' | 'month' | 'dow';

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when day-of-month is restricted (not `*`). */
  domRestricted: boolean;
  /** True when day-of-week is restricted (not `*`). */
  dowRestricted: boolean;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

function parseField(raw: string, field: FieldName): { values: Set<number>; restricted: boolean } {
  const [min, max] = RANGES[field]!;
  const restricted = raw.trim() !== '*';
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) throw new CronError(`empty term in ${field} field`);
    let rangeSpec = token;
    let step = 1;
    const slash = token.indexOf('/');
    if (slash !== -1) {
      rangeSpec = token.slice(0, slash);
      step = Number(token.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0)
        throw new CronError(`bad step "${token}" in ${field}`);
    }
    let lo: number;
    let hi: number;
    if (rangeSpec === '*') {
      lo = min;
      hi = max;
    } else if (rangeSpec.includes('-')) {
      const [a, b] = rangeSpec.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangeSpec);
      hi = lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new CronError(`non-integer value "${token}" in ${field}`);
    }
    // day-of-week: normalise 7 → 0
    if (field === 'dow') {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo > hi) throw new CronError(`inverted range "${token}" in ${field}`);
    if (lo < min || hi > max) {
      throw new CronError(`"${token}" out of range ${min}-${max} in ${field}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new CronError(`no values parsed for ${field}`);
  return { values: out, restricted };
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`cron must have exactly 5 fields, got ${parts.length}: "${expression}"`);
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const m = parseField(minute, 'minute');
  const h = parseField(hour, 'hour');
  const d = parseField(dom, 'dom');
  const mo = parseField(month, 'month');
  const w = parseField(dow, 'dow');
  return {
    minute: m.values,
    hour: h.values,
    dom: d.values,
    month: mo.values,
    dow: w.values,
    domRestricted: d.restricted,
    dowRestricted: w.restricted,
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first time at or after `from` (exclusive of `from` itself) that matches
 * the expression. Searches minute by minute for up to ~400 days, then throws
 * (a schedule that never fires — e.g. `0 0 30 2 *` — is a config error).
 */
export function nextRunAfter(expression: string, from: Date): Date {
  const cron = parseCron(expression);
  // Start from the next whole minute.
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const limit = from.getTime() + 400 * 24 * 60 * 60 * 1000;

  while (t.getTime() <= limit) {
    if (matches(cron, t)) return new Date(t);
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  throw new CronError(`cron "${expression}" has no run in the next 400 days`);
}

export function matches(cron: ParsedCron, date: Date): boolean {
  if (!cron.minute.has(date.getUTCMinutes())) return false;
  if (!cron.hour.has(date.getUTCHours())) return false;
  if (!cron.month.has(date.getUTCMonth() + 1)) return false;

  const domOk = cron.dom.has(date.getUTCDate());
  const dowOk = cron.dow.has(date.getUTCDay());

  // Standard cron semantics: if BOTH dom and dow are restricted, either match
  // is sufficient; otherwise both restricted fields must match.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

// --- cadence → cron -------------------------------------------------------

export interface CadenceOptions {
  /** 0-23 UTC, default 9. */
  hour?: number;
  /** 0-59, default 0. */
  minute?: number;
  /** DAILY: ignored. WEEKLY: 0-6 (0 = Sunday), default 1 (Monday). */
  weekday?: number;
  /** MONTHLY: 1-28 (kept ≤ 28 so it fires every month), default 1. */
  monthday?: number;
}

export function cronForCadence(
  cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY',
  opts: CadenceOptions = {},
): string {
  const minute = clamp(opts.minute ?? 0, 0, 59);
  const hour = clamp(opts.hour ?? 9, 0, 23);
  switch (cadence) {
    case 'DAILY':
      return `${minute} ${hour} * * *`;
    case 'WEEKLY': {
      const wd = clamp(opts.weekday ?? 1, 0, 6);
      return `${minute} ${hour} * * ${wd}`;
    }
    case 'MONTHLY': {
      const md = clamp(opts.monthday ?? 1, 1, 28);
      return `${minute} ${hour} ${md} * *`;
    }
    default: {
      const _x: never = cadence;
      throw new CronError(`unknown cadence ${String(_x)}`);
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/** Human-readable, e.g. "Every Monday at 09:00 UTC". */
export function describeCron(expression: string): string {
  let cron: ParsedCron;
  try {
    cron = parseCron(expression);
  } catch {
    return expression;
  }
  const single = (s: Set<number>): number | null => (s.size === 1 ? [...s][0]! : null);
  const minute = single(cron.minute);
  const hour = single(cron.hour);
  const time =
    minute != null && hour != null
      ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`
      : null;

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (cron.dowRestricted && !cron.domRestricted) {
    const wd = single(cron.dow);
    const day = wd != null ? DAYS[wd] : [...cron.dow].map((d) => DAYS[d]).join(', ');
    return `Every ${day}${time ? ` at ${time}` : ''}`;
  }
  if (cron.domRestricted && !cron.dowRestricted) {
    const md = single(cron.dom);
    return `On day ${md ?? [...cron.dom].join(', ')} of each month${time ? ` at ${time}` : ''}`;
  }
  if (!cron.domRestricted && !cron.dowRestricted) {
    return `Every day${time ? ` at ${time}` : ''}`;
  }
  return expression;
}
