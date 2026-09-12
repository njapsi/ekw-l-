/**
 * Shared anti-hallucination guard for analyst-agent output
 * (docs/AI-ARCHITECTURE.md §6). An agent flattens its structured output into
 * `GroundingField`s and passes the known fact ids + the numbers that appear in
 * the fact sheet. Two checks:
 *   1. every cited fact id must exist;
 *   2. every number in free text must match a known fact value (±2 %) or be an
 *      "obviously safe" number (small integer / year / 0–100 %).
 * Plus: no guarantee-style phrasing.
 */
export interface GroundingIssue {
  path: string;
  problem: string;
}

export interface GroundingField {
  path: string;
  text: string;
  factIds?: string[];
}

const BANNED = [
  /\bguarantee[ds]?\b/i,
  /\bguaranteed (?:monetization|revenue|income|ranking|views|subscribers|followers)\b/i,
  /\bwill (?:definitely|certainly) (?:be monetized|get monetized|make money|go viral)\b/i,
  /\byou will (?:be monetized|go viral)\b/i,
  /\bensures? (?:monetization|approval|virality)\b/i,
];

const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;

function numberIsGrounded(raw: string, factNumbers: number[]): boolean {
  const value = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(value)) return true;
  if (Number.isInteger(value) && Math.abs(value) <= 100) return true;
  if (value >= 1900 && value <= 2100) return true;
  return factNumbers.some((f) => {
    const tol = Math.max(1, Math.abs(f) * 0.02);
    return Math.abs(f - value) <= tol;
  });
}

export function checkGroundingFields(
  fields: GroundingField[],
  knownFactIds: ReadonlySet<string>,
  factNumbers: number[],
): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  for (const field of fields) {
    for (const rx of BANNED) {
      if (rx.test(field.text)) {
        issues.push({ path: field.path, problem: 'contains a prohibited guarantee-style claim' });
        break;
      }
    }
    for (const id of field.factIds ?? []) {
      if (!knownFactIds.has(id)) {
        issues.push({ path: field.path, problem: `cites unknown fact id "${id}"` });
      }
    }
    for (const nStr of field.text.match(NUMBER_RE) ?? []) {
      if (!numberIsGrounded(nStr, factNumbers)) {
        issues.push({
          path: field.path,
          problem: `states the number "${nStr}" which is not in the provided data`,
        });
      }
    }
  }
  return issues;
}
