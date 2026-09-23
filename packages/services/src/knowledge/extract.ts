/**
 * Part 20: a deterministic (no extra model call — matching `agent/memory.ts`'s
 * own regex-fallback convention) detector for durable business-context
 * statements in a chat message, feeding `candidates.ts`'s governance gate.
 * This is intentionally narrow and pattern-based rather than another model
 * call on every turn (cost/latency, Part 30's context-budget discipline) —
 * a much richer extraction is possible from a model, but that is exactly
 * what `memory.propose` (the tool) is for when a capability has model+tool
 * access; this is the always-on, zero-cost floor.
 */
import type { KnowledgeType } from '@growth-agent/db';

interface Pattern {
  re: RegExp;
  type: KnowledgeType;
}

const PATTERNS: Pattern[] = [
  { re: /\b(?:our|my) target (?:market|audience|customers?)\s+(?:is|are)\s+.{3,200}/i, type: 'AUDIENCE_PROFILE' },
  { re: /\bwe\s+(?:sell|offer|provide)\s+.{3,200}/i, type: 'PRODUCT' },
  { re: /\b(?:our|my) brand\s+(?:is|voice is|stands for)\s+.{3,200}/i, type: 'BRAND_PROFILE' },
  { re: /\b(?:our|my) business\s+(?:is|does)\s+.{3,200}/i, type: 'BUSINESS_PROFILE' },
  { re: /\b(?:our|my) (?:main )?competitors?\s+(?:is|are)\s+.{3,200}/i, type: 'COMPETITOR' },
  { re: /\b(?:our|my) goal (?:this (?:quarter|month|year)|for (?:the )?(?:next|coming) \d+ (?:days|weeks|months))?\s*(?:is|are)\s+to\s+.{3,200}/i, type: 'GOAL' },
];

export interface DeterministicCandidate {
  content: string;
  proposedType: KnowledgeType;
  reason: string;
}

/** Capped at 2 per message — a single statement being caught twice by
 * overlapping patterns is more useful signal than noise, but an unbounded
 * message shouldn't spawn a dozen candidates. */
export function extractCandidatesDeterministic(message: string): DeterministicCandidate[] {
  const out: DeterministicCandidate[] = [];
  for (const { re, type } of PATTERNS) {
    const match = re.exec(message);
    if (!match) continue;
    out.push({
      content: match[0].trim().slice(0, 300),
      proposedType: type,
      reason: 'Detected from a message in an AI Agent conversation.',
    });
    if (out.length >= 2) break;
  }
  return out;
}
