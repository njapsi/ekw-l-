/**
 * Billing job entry points. Like the other modules (ADR-0013) these run inline
 * for now; the wrappers exist so a scheduler can call them unchanged later.
 */
import { type Db, prisma } from '@growth-agent/db';
import { refreshUsageCounters } from '../usage/summary.js';
import { reconcileAllOrganizations, reconcileOrganization } from './reconcile.js';
import { billingContextFromEnv } from './service.js';

export async function runBillingReconcileJob(
  input: { organizationId?: string } = {},
  db: Db = prisma,
) {
  const ctx = billingContextFromEnv();
  if (input.organizationId) {
    return reconcileOrganization(input.organizationId, ctx, db);
  }
  return reconcileAllOrganizations(ctx, db);
}

export async function rebuildUsageCountersJob(input: { organizationId: string }, db: Db = prisma) {
  await refreshUsageCounters(input.organizationId, db);
  return { ok: true };
}
