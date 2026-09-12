// Combining diacritical marks (U+0300–U+036F), stripped after NFKD normalization.
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Turn an org name into a URL-safe slug candidate. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/**
 * Given a desired slug and a predicate that reports whether a slug is taken,
 * return the first free slug (`name`, then `name-2`, `name-3`, …).
 */
export async function uniqueSlug(
  desired: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(desired) || 'org';
  if (!(await isTaken(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 37)}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(`Could not derive a unique slug from "${desired}"`);
}
