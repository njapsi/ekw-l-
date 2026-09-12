import { describe, expect, it } from 'vitest';
import { USAGE_METERS } from '../usage/meters.js';
import {
  BILLING_TIERS,
  PLAN_CATALOG,
  displayPrice,
  getPlan,
  isDowngrade,
  isUpgrade,
  listPlans,
  planLimit,
  purchasableTiers,
} from './plans.js';

describe('plan catalog', () => {
  it('defines exactly the five tiers from the spec, cheapest first', () => {
    expect(BILLING_TIERS).toEqual(['FREE', 'CREATOR', 'PRO', 'AGENCY', 'ENTERPRISE']);
    expect(listPlans().map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('every plan sets a limit for every meter (a number, or null for unlimited)', () => {
    for (const plan of listPlans()) {
      for (const meter of USAGE_METERS) {
        const v = plan.limits[meter];
        expect(v === null || (typeof v === 'number' && v >= 0)).toBe(true);
      }
    }
  });

  it('limits increase monotonically FREE → AGENCY, and ENTERPRISE is unlimited', () => {
    const ordered = ['FREE', 'CREATOR', 'PRO', 'AGENCY'] as const;
    for (const meter of USAGE_METERS) {
      for (let i = 1; i < ordered.length; i++) {
        const prev = planLimit(ordered[i - 1]!, meter) ?? Infinity;
        const cur = planLimit(ordered[i]!, meter) ?? Infinity;
        expect(cur).toBeGreaterThanOrEqual(prev);
      }
      expect(planLimit('ENTERPRISE', meter)).toBeNull();
    }
  });

  it('FREE and ENTERPRISE are not self-serve; CREATOR/PRO/AGENCY are', () => {
    expect(purchasableTiers()).toEqual(['CREATOR', 'PRO', 'AGENCY']);
    expect(getPlan('FREE').selfServe).toBe(false);
    expect(getPlan('ENTERPRISE').selfServe).toBe(false);
  });

  it('feature flags: FREE has none, ENTERPRISE has all, and they only widen up the tiers', () => {
    const featureKeys = Object.keys(PLAN_CATALOG.ENTERPRISE.features) as Array<
      keyof typeof PLAN_CATALOG.ENTERPRISE.features
    >;
    expect(Object.values(PLAN_CATALOG.FREE.features).every((v) => v === false)).toBe(true);
    expect(Object.values(PLAN_CATALOG.ENTERPRISE.features).every((v) => v === true)).toBe(true);
    const ordered = ['FREE', 'CREATOR', 'PRO', 'AGENCY', 'ENTERPRISE'] as const;
    for (const f of featureKeys) {
      for (let i = 1; i < ordered.length; i++) {
        const prev = getPlan(ordered[i - 1]!).features[f];
        const cur = getPlan(ordered[i]!).features[f];
        // a feature never turns OFF as the plan gets more expensive
        expect(prev && !cur).toBe(false);
      }
    }
  });

  it('display price comes from the catalog, never a hard-coded literal elsewhere', () => {
    expect(displayPrice('FREE', 'MONTH')).toBe('Free');
    expect(displayPrice('CREATOR', 'MONTH')).toBe(`$${PLAN_CATALOG.CREATOR.priceUsd.MONTH}/mo`);
    expect(displayPrice('ENTERPRISE', 'YEAR')).toBe('Custom');
  });

  it('upgrade / downgrade ordering', () => {
    expect(isUpgrade('FREE', 'PRO')).toBe(true);
    expect(isDowngrade('AGENCY', 'CREATOR')).toBe(true);
    expect(isUpgrade('PRO', 'PRO')).toBe(false);
  });
});
