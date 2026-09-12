/**
 * robots.txt parsing + matching (docs/SEO-ENGINE.md "Discovery inputs" and the
 * ROBOTS.TXT analysis section). Implements the de-facto standard:
 *   - user-agent grouping (consecutive User-agent lines share the following rules)
 *   - Allow / Disallow with **longest-match wins**, Allow wins an exact-length tie
 *   - `*` wildcard and `$` end-anchor in paths
 *   - Crawl-delay (seconds)
 *   - Sitemap: directives (global, not per-group)
 * Also surfaces syntax problems for the auditor.
 */

import { wildcardMatch } from './pattern-match.js';

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export interface RobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
  crawlDelaySec: number | null;
}

export interface RobotsSyntaxIssue {
  line: number;
  text: string;
  problem: string;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  issues: RobotsSyntaxIssue[];
  /** True if the file could not be parsed into any directive at all. */
  empty: boolean;
}

const KNOWN_FIELDS = new Set(['user-agent', 'allow', 'disallow', 'crawl-delay', 'sitemap', 'host']);

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const issues: RobotsSyntaxIssue[] = [];

  let current: RobotsGroup | null = null;
  let expectingAgent = false; // are we still in the User-agent block of `current`?
  let sawAnyDirective = false;

  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;

    const colon = line.indexOf(':');
    if (colon === -1) {
      issues.push({ line: lineNo, text: rawLine.trim(), problem: 'missing ":" — not a directive' });
      return;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (!KNOWN_FIELDS.has(field)) {
      issues.push({ line: lineNo, text: rawLine.trim(), problem: `unknown directive "${field}"` });
      return;
    }
    sawAnyDirective = true;

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      else issues.push({ line: lineNo, text: rawLine.trim(), problem: 'empty Sitemap value' });
      return;
    }
    if (field === 'host') return; // non-standard, ignore silently

    if (field === 'user-agent') {
      const ua = value.toLowerCase();
      if (!ua) {
        issues.push({ line: lineNo, text: rawLine.trim(), problem: 'empty User-agent' });
        return;
      }
      if (current && !expectingAgent) {
        // A new User-agent after rules starts a fresh group.
        current = null;
      }
      if (!current) {
        current = { userAgents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.userAgents.push(ua);
      expectingAgent = true;
      return;
    }

    // allow / disallow / crawl-delay must belong to a group.
    if (!current) {
      issues.push({
        line: lineNo,
        text: rawLine.trim(),
        problem: `"${field}" before any User-agent`,
      });
      return;
    }
    expectingAgent = false;

    if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
      else issues.push({ line: lineNo, text: rawLine.trim(), problem: 'invalid Crawl-delay' });
      return;
    }

    // allow / disallow — an empty Disallow means "allow all", keep it as a rule
    // with an empty path so length-0 never matches.
    current.rules.push({ type: field as 'allow' | 'disallow', path: value });
  });

  return { groups, sitemaps, issues, empty: !sawAnyDirective };
}

/** Pick the group that best matches `userAgent` (exact token > `*` > none). */
export function groupFor(parsed: ParsedRobots, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let star: RobotsGroup | null = null;
  let best: { group: RobotsGroup; score: number } | null = null;
  for (const g of parsed.groups) {
    for (const token of g.userAgents) {
      if (token === '*') {
        star = g;
        continue;
      }
      if (ua.includes(token) && (!best || token.length > best.score)) {
        best = { group: g, score: token.length };
      }
    }
  }
  return best?.group ?? star;
}

/**
 * robots.txt path matching is a PREFIX match unless the pattern ends with a
 * literal `$` (then it must match exactly through the end). Both cases reduce
 * to one full-match call against the linear `wildcardMatch` primitive — see
 * `pattern-match.ts` for why this replaced a backtracking-regex translation
 * (CRAWLER-SECURITY-AUDIT.md CRITICAL-2: the old `* -> .*` regex translation
 * was vulnerable to catastrophic backtracking on an attacker-controlled
 * robots.txt).
 */
function robotsPatternMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith('$')) {
    return wildcardMatch(pattern.slice(0, -1), path);
  }
  return wildcardMatch(`${pattern}*`, path);
}

export interface RobotsMatch {
  allowed: boolean;
  /** The rule that decided it, if any (undefined ⇒ default allow). */
  rule?: RobotsRule;
}

/**
 * Decide whether `path` (path + query, starting with `/`) is crawlable for
 * `userAgent`. Longest matching rule wins; on an equal-length tie, Allow wins.
 */
export function matchRobots(parsed: ParsedRobots, path: string, userAgent: string): RobotsMatch {
  const group = groupFor(parsed, userAgent);
  if (!group) return { allowed: true };

  let decided: { rule: RobotsRule; len: number } | null = null;
  for (const rule of group.rules) {
    if (rule.type === 'disallow' && rule.path === '') continue; // "Disallow:" ⇒ allow all
    if (!robotsPatternMatches(rule.path, path)) continue;
    const len = rule.path.replace(/\$$/, '').length;
    if (
      !decided ||
      len > decided.len ||
      (len === decided.len && rule.type === 'allow' && decided.rule.type === 'disallow')
    ) {
      decided = { rule, len };
    }
  }
  if (!decided) return { allowed: true };
  return { allowed: decided.rule.type === 'allow', rule: decided.rule };
}

export function isPathAllowed(parsed: ParsedRobots, path: string, userAgent: string): boolean {
  return matchRobots(parsed, path, userAgent).allowed;
}

/**
 * Given a set of paths the operator considers important (e.g. from the sitemap
 * or nav), return the ones robots.txt blocks for our UA — feeds the
 * `ROBOTS_BLOCKS_IMPORTANT_PATH` issue.
 */
export function importantPathsBlocked(
  parsed: ParsedRobots,
  importantPaths: string[],
  userAgent: string,
): Array<{ path: string; rule: RobotsRule }> {
  const out: Array<{ path: string; rule: RobotsRule }> = [];
  for (const p of importantPaths) {
    const m = matchRobots(parsed, p, userAgent);
    if (!m.allowed && m.rule) out.push({ path: p, rule: m.rule });
  }
  return out;
}

/** True if robots.txt disallows everything for our UA (crawl ⇒ BLOCKED). */
export function isFullyDisallowed(parsed: ParsedRobots, userAgent: string): boolean {
  const group = groupFor(parsed, userAgent);
  if (!group) return false;
  const root = matchRobots(parsed, '/', userAgent);
  const deep = matchRobots(parsed, '/any/deep/path', userAgent);
  return !root.allowed && !deep.allowed;
}
