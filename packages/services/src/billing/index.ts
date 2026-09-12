/**
 * The `billing` module — Stripe subscriptions, checkout, portal, plan changes,
 * invoices, webhooks, and the plan catalog + entitlements. Stripe is the source
 * of truth for money; we store only ids + non-sensitive mirrors and never card
 * data (ADR-0010, ADR-0025). Metering + limit enforcement live in the sibling
 * `usage` module. Billing authorization is always server-side (`billing:manage`).
 */
export * from './plans.js';
export {
  loadBillingConfig,
  priceIdFor,
  priceKey,
  tierForPrice,
  type BillingConfig,
} from './config.js';
export {
  verifyStripeSignature,
  signStripePayload,
  StripeSignatureError,
} from './stripe-signature.js';
export {
  type BillingGateway,
  StripeHttpGateway,
  NullBillingGateway,
  createBillingGateway,
  toFormBody,
  type StripeEvent,
  type StripeSubscription,
  type StripeInvoice,
  type StripeCheckoutSession,
} from './gateway.js';
export {
  resolveEntitlements,
  syncPlanEntitlements,
  getLimit,
  hasFeature,
  setEntitlementOverride,
  clearEntitlementOverride,
  type ResolvedEntitlements,
} from './entitlements.js';
export {
  getSubscription,
  getOrCreateSubscription,
  getBillingSummary,
  applyStripeSubscription,
  downgradeToFree,
  mapStripeStatus,
  isEntitledStatus,
  describeStatus,
  type BillingSummary,
} from './subscription.js';
export { ensureStripeCustomer } from './customers.js';
export {
  startCheckout,
  openBillingPortal,
  type CheckoutDeps,
  type StartCheckoutInput,
} from './checkout.js';
export {
  changePlan,
  cancelSubscription,
  resumeSubscription,
  type PlanChangeDeps,
  type ChangePlanResult,
} from './plan-change.js';
export { upsertInvoiceFromStripe, listInvoices } from './invoices.js';
export { handleStripeWebhook, type WebhookDeps, type WebhookResult } from './webhook.js';
export { reconcileOrganization, reconcileAllOrganizations } from './reconcile.js';
export { billingContextFromEnv, isBillingConfigured, type BillingContext } from './service.js';
export { runBillingReconcileJob, rebuildUsageCountersJob } from './jobs.js';
