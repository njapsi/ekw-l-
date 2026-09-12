/**
 * Convenience wiring for the app layer: build `{ config, gateway }` from the
 * environment once and hand it to the checkout / plan-change / webhook
 * functions. Tests construct these directly with a fake gateway instead.
 */
import { loadBillingConfig, type BillingConfig } from './config.js';
import { createBillingGateway, type BillingGateway } from './gateway.js';

export interface BillingContext {
  config: BillingConfig;
  gateway: BillingGateway;
}

export function billingContextFromEnv(
  env: Record<string, string | undefined> = process.env,
): BillingContext {
  const config = loadBillingConfig(env);
  return { config, gateway: createBillingGateway(config) };
}

export function isBillingConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return loadBillingConfig(env).configured;
}
