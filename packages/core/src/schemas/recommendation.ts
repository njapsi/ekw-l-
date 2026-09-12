import { z } from 'zod';
import { Claim } from './claim.js';

/**
 * Every recommendation the Growth Agent produces must be explainable and carry
 * the full chain from evidence to expected impact (master instruction,
 * section D). This schema is the contract all analyst agents emit.
 */
export const Priority = z.enum(['critical', 'high', 'medium', 'low']);
export type Priority = z.infer<typeof Priority>;

export const EffortLevel = z.enum(['trivial', 'small', 'medium', 'large']);
export type EffortLevel = z.infer<typeof EffortLevel>;

export const Finding = z.object({
  id: z.string(),
  title: z.string().min(1),
  summary: z.string().min(1),
  claims: z.array(Claim).min(1),
});
export type Finding = z.infer<typeof Finding>;

export const Recommendation = z.object({
  id: z.string(),
  findingIds: z.array(z.string()).default([]),
  title: z.string().min(1),
  explanation: z.string().min(1),
  priority: Priority,
  recommendedActions: z.array(z.string().min(1)).min(1),
  implementationInstructions: z.string().min(1),
  expectedImpact: z.string().min(1),
  confidence: z.number().min(0).max(1),
  effort: EffortLevel,
  evidence: z.array(Claim).default([]),
  /** True once a human has approved acting on this (see section K). */
  requiresApproval: z.boolean().default(true),
});
export type Recommendation = z.infer<typeof Recommendation>;

export const AnalysisReport = z.object({
  generatedAt: z.string().datetime(),
  subject: z.string().min(1),
  findings: z.array(Finding),
  recommendations: z.array(Recommendation),
  disclaimers: z.array(z.string()).default([]),
});
export type AnalysisReport = z.infer<typeof AnalysisReport>;
