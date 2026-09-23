/**
 * Enterprise contracts (Phase 13, §44-§46). A negotiated agreement layered
 * as a further override on top of the existing PLAN → contract →
 * OVERRIDE/PROMO `Entitlement` resolution — never a parallel authorization
 * path. `customEntitlements` mirrors `Entitlement`'s own `limit:<METER>` /
 * `feature:<name>` key shape so `resolveEntitlements` can apply it with the
 * same code that already parses those keys for the plan catalog.
 *
 * Priority order (§46, highest wins): system/security restrictions (outside
 * this module — RBAC, governance) > per-key OVERRIDE/PROMO `Entitlement`
 * rows > an active enterprise contract > the subscription plan default. An
 * override still wins over a contract on purpose — "Enterprise does not
 * mean unrestricted" (§88): a support-granted correction must be able to
 * tighten or loosen a specific key even for a contracted org.
 */
import { type Db, prisma } from '@growth-agent/db';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';

export interface CustomEntitlements {
  /** e.g. `{ 'limit:AI_REQUESTS': 500000, 'feature:sso': true }` — same key
   *  shape `Entitlement.key` already uses. `null` limit means unlimited. */
  [key: string]: number | boolean | null;
}

export interface CreateEnterpriseContractInput {
  organizationId: string;
  actorId: string;
  contractStart: Date;
  contractEnd?: Date | null;
  seatLimit?: number | null;
  customEntitlements: CustomEntitlements;
  billingTerms?: string;
  supportLevel?: string;
}

function validateKeys(entitlements: CustomEntitlements): void {
  for (const key of Object.keys(entitlements)) {
    if (!key.startsWith('limit:') && !key.startsWith('feature:')) {
      throw AppError.validation(`Enterprise entitlement key must start with "limit:" or "feature:" (got "${key}").`);
    }
  }
}

export async function createEnterpriseContract(input: CreateEnterpriseContractInput, db: Db = prisma) {
  validateKeys(input.customEntitlements);
  const row = await db.enterpriseContract.upsert({
    where: { organizationId: input.organizationId },
    create: {
      organizationId: input.organizationId,
      status: 'ACTIVE',
      contractStart: input.contractStart,
      contractEnd: input.contractEnd ?? null,
      seatLimit: input.seatLimit ?? null,
      customEntitlements: input.customEntitlements as never,
      billingTerms: input.billingTerms,
      supportLevel: input.supportLevel,
      createdById: input.actorId,
    },
    update: {
      status: 'ACTIVE',
      contractStart: input.contractStart,
      contractEnd: input.contractEnd ?? null,
      seatLimit: input.seatLimit ?? null,
      customEntitlements: input.customEntitlements as never,
      billingTerms: input.billingTerms,
      supportLevel: input.supportLevel,
    },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: 'billing.enterprise_contract.upserted',
      targetType: 'enterprise_contract',
      targetId: row.id,
      metadata: { seatLimit: input.seatLimit ?? null, entitlementKeys: Object.keys(input.customEntitlements) },
    },
    db,
  );
  return row;
}

export async function expireEnterpriseContract(
  input: { organizationId: string; actorId: string },
  db: Db = prisma,
) {
  const existing = await db.enterpriseContract.findUnique({ where: { organizationId: input.organizationId } });
  if (!existing) return null;
  const row = await db.enterpriseContract.update({
    where: { organizationId: input.organizationId },
    data: { status: 'CANCELLED' },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: 'billing.enterprise_contract.cancelled',
      targetType: 'enterprise_contract',
      targetId: row.id,
    },
    db,
  );
  return row;
}

/** The live contract for an org, or `null` if there isn't one, it's not
 *  ACTIVE, or it has passed its `contractEnd` date. */
export async function getActiveEnterpriseContract(organizationId: string, db: Db = prisma, now: Date = new Date()) {
  const contract = await db.enterpriseContract.findUnique({ where: { organizationId } });
  if (!contract || contract.status !== 'ACTIVE') return null;
  if (contract.contractEnd && contract.contractEnd.getTime() <= now.getTime()) return null;
  return contract;
}
