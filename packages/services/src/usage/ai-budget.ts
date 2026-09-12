/**
 * The AI budget gate (Phase 23). One call that enforces **both** the per-org
 * `AI_REQUESTS` and `AI_TOKENS` plan caps before a model call.
 *
 * `AI_TOKENS` cannot be reserved — a call's token count is unknowable until it
 * returns — so with the default `tokenEstimate` of 1 this is a "budget
 * exhausted" gate: it blocks the *next* request once the org has spent its
 * token allowance, matching how every post-hoc counter meter behaves
 * (ADR-0038). Pass a `tokenEstimate` when the caller has a rough size.
 *
 * `AI_REQUESTS` is reservable and is checked with `amount: 1`.
 */
import { type Db, prisma } from '@growth-agent/db';
import { checkUsage, type UsageVerdict } from './check.js';
import { UsageLimitError } from './enforce.js';
import { describeMeter, type MeterKey } from './meters.js';

export interface AiBudgetInput {
  organizationId: string;
  /** Rough token count the pending call will consume. Default 1 (exhaustion gate). */
  tokenEstimate?: number;
  db?: Db;
}

export interface AiBudgetVerdict {
  ok: boolean;
  /** The meter that tripped, when `ok` is false. */
  meter?: MeterKey;
  verdict?: UsageVerdict;
}

/** Non-throwing check of both AI meters. Returns which one (if any) is over. */
export async function checkAiBudget(input: AiBudgetInput): Promise<AiBudgetVerdict> {
  const db = input.db ?? prisma;
  const requests = await checkUsage(
    { organizationId: input.organizationId, meter: 'AI_REQUESTS', amount: 1 },
    db,
  );
  if (!requests.unlimited && requests.wouldExceed) {
    return { ok: false, meter: 'AI_REQUESTS', verdict: requests };
  }
  const tokens = await checkUsage(
    {
      organizationId: input.organizationId,
      meter: 'AI_TOKENS',
      amount: Math.max(1, Math.trunc(input.tokenEstimate ?? 1)),
    },
    db,
  );
  if (!tokens.unlimited && tokens.wouldExceed) {
    return { ok: false, meter: 'AI_TOKENS', verdict: tokens };
  }
  return { ok: true };
}

/**
 * Throwing guard — `UsageLimitError` (`usage_limit_exceeded`, HTTP 429) naming
 * whichever AI meter is over. Call it server-side before every model request.
 */
export async function enforceAiBudget(input: AiBudgetInput): Promise<void> {
  const res = await checkAiBudget(input);
  if (res.ok || !res.verdict || !res.meter) return;
  const info = describeMeter(res.meter);
  throw new UsageLimitError(
    res.verdict,
    `You've reached your plan's ${info.label.toLowerCase()} limit ` +
      `(${res.verdict.used.toLocaleString('en-US')} / ${res.verdict.limit?.toLocaleString('en-US')} ${info.unit}). ` +
      `Upgrade your plan or wait for the next billing period.`,
  );
}
