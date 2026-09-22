/**
 * A small, dependency-free text diff for the content editor's "compare
 * changes" view (Phase 9, §18/§30). Word-level LCS diff — good enough for
 * showing what changed in a title/excerpt/body without pulling in a diff
 * library, matching this codebase's "hand-roll before a dependency"
 * convention (the PDF writer, the cron parser, etc.).
 */
export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffToken {
  op: DiffOp;
  text: string;
}

/** Splits on whitespace, keeping the whitespace as its own token so the
 *  rendered diff reads naturally. */
function tokenize(text: string): string[] {
  return text.match(/\S+|\s+/g) ?? [];
}

/** Splits into paragraphs (runs of one or more blank lines) — a much
 *  coarser unit than a word, so a long piece of content still yields a
 *  small, fast-to-diff token count. */
function tokenizeParagraphs(text: string): string[] {
  return text.match(/[^\n]+\n*|\n+/g) ?? [];
}

/**
 * The word-level LCS table below is O(n*m) — exact and readable for a
 * normal edit, but genuinely too slow past a few hundred thousand cells
 * (confirmed live: a 20,000×20,000 table took over 80 seconds). Word-level
 * diffing is used only when both texts are short enough for that table to
 * stay fast; a longer piece of content (WordPress posts can be up to
 * 200,000 characters, `wordpress/actions.ts`'s own limit) falls back to a
 * paragraph-level diff instead — coarser, but the token count for even a
 * very long article stays small, so it never risks hanging.
 */
const WORD_LEVEL_MAX_TOKENS = 1_500;

function lcsDiff(a: string[], b: string[]): DiffToken[] {
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'equal', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ op: 'delete', text: a[i]! });
      i++;
    } else {
      ops.push({ op: 'insert', text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ op: 'delete', text: a[i++]! });
  while (j < m) ops.push({ op: 'insert', text: b[j++]! });

  // Merge adjacent same-op tokens so the UI doesn't render one <span> per word.
  const merged: DiffToken[] = [];
  for (const t of ops) {
    const last = merged[merged.length - 1];
    if (last && last.op === t.op) last.text += t.text;
    else merged.push({ ...t });
  }
  return merged;
}

/**
 * Public entry point. Tries a word-level diff first (the readable,
 * fine-grained result an editor UI wants); if either text tokenizes past
 * `WORD_LEVEL_MAX_TOKENS`, falls back to a paragraph-level diff, which for
 * ordinary prose collapses to a tiny token count no matter how long the
 * article is. If even that is somehow too large (pathological input with
 * thousands of one-line "paragraphs"), returns a single-token summary
 * rather than ever running an unbounded O(n*m) table.
 */
export function diffText(original: string, proposed: string): DiffToken[] {
  const wordsA = tokenize(original);
  const wordsB = tokenize(proposed);
  if (wordsA.length <= WORD_LEVEL_MAX_TOKENS && wordsB.length <= WORD_LEVEL_MAX_TOKENS) {
    return lcsDiff(wordsA, wordsB);
  }

  const parasA = tokenizeParagraphs(original);
  const parasB = tokenizeParagraphs(proposed);
  if (parasA.length <= WORD_LEVEL_MAX_TOKENS && parasB.length <= WORD_LEVEL_MAX_TOKENS) {
    return lcsDiff(parasA, parasB);
  }

  return original === proposed
    ? [{ op: 'equal', text: original }]
    : [
        { op: 'delete', text: original },
        { op: 'insert', text: proposed },
      ];
}

/** Counts changed (inserted + deleted) tokens as a rough "how big is this
 *  edit" signal for the UI, without rendering the full diff. */
export function diffChangeRatio(original: string, proposed: string): number {
  const tokens = diffText(original, proposed);
  const changed = tokens.filter((t) => t.op !== 'equal').reduce((s, t) => s + t.text.trim().length, 0);
  const total = Math.max(1, original.length);
  return Math.min(1, changed / total);
}
