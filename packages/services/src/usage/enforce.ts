/**
 * `usage.enforce` — the guard. Server-side only; the browser is never trusted
 * for a limit decision. Call it before starting metered work; it throws
 * `AppError('usage_limit_exceeded')` (HTTP 429) when the operation would push
 * the org over its plan cap.
 *
 * `guardUsage` is the non-throwing variant for places that want to degrade
 * gracefully rather than error.
 */
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';
import { checkUsage, type UsageVerdict } from './check.js';
import { describeMeter, type MeterKey } from './meters.js';

export interface EnforceUsageInput {
  organizationId: string;
  meter: MeterKey;
  amount?: number;
}

export class UsageLimitError extends AppError {
  constructor(
    readonly verdict: UsageVerdict,
    message: string,
  ) {
    super('usage_limit_exceeded', message, { expose: true });
    this.name = 'UsageLimitError';
  }
}

export async function enforceUsage(
  input: EnforceUsageInput,
  db: Db = prisma,
): Promise<UsageVerdict> {
  const verdict = await checkUsage(input, db);
  if (!verdict.unlimited && verdict.wouldExceed) {
    const info = describeMeter(input.meter);
    throw new UsageLimitError(
      verdict,
      `You've reached your plan's ${info.label.toLowerCase()} limit ` +
        `(${verdict.used.toLocaleString('en-US')} / ${verdict.limit?.toLocaleString('en-US')} ${info.unit}). ` +
        `Upgrade your plan or wait for the next billing period.`,
    );
  }
  return verdict;
}

/** Non-throwing: returns `true` when the operation is within the cap. */
export async function guardUsage(input: EnforceUsageInput, db: Db = prisma): Promise<boolean> {
  const verdict = await checkUsage(input, db);
  return verdict.unlimited || !verdict.wouldExceed;
}
