/**
 * Linear-time wildcard matching for robots.txt Allow/Disallow paths and crawl
 * include/exclude path globs (docs/SEO-ENGINE.md, docs/CRAWLER-SECURITY-AUDIT.md
 * CRITICAL-2). Both call sites used to translate a `*`-wildcard pattern into a
 * backtracking regex (`* -> .*`); a pattern with several `.*` groups separated
 * by literal text that fails to match causes catastrophic backtracking —
 * confirmed to hang the process indefinitely on a ~40-character pattern, and
 * the robots.txt content is entirely attacker-controlled (it's the crawled
 * site's own file).
 *
 * `wildcardMatch` is the classic two-pointer glob algorithm: `*` means "zero or
 * more of any character", every other character is literal. It is O(n+m) in
 * the worst case with no backtracking, so no input can make it slow — there is
 * nothing to escape and no regex involved.
 */

/** True if `pattern` matches the *entire* `text` (`*` = zero-or-more chars). */
export function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starIdx = -1;
  let matchFrom = 0;

  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      starIdx = p;
      matchFrom = t;
      p++;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (starIdx !== -1) {
      p = starIdx + 1;
      matchFrom++;
      t = matchFrom;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
