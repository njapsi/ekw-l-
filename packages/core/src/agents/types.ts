import type { AnalysisReport } from '../schemas/recommendation.js';
import type { Result } from '../result.js';

/**
 * Agent architecture (master instruction, section J):
 *  - many specialized agents, each with a narrow tool set
 *  - an orchestration layer routes a task to the right agent
 *  - agents never get unrestricted DB access and never perform destructive
 *    actions without explicit authorization
 */
export type AgentId =
  | 'growth-analyst'
  | 'youtube-analyst'
  | 'tiktok-analyst'
  | 'seo-crawler'
  | 'seo-technical-auditor'
  | 'content-strategy'
  | 'monetization-opportunity'
  | 'recommendation'
  | 'reporting';

export interface TenantContext {
  organizationId: string;
  userId: string;
  /** Roles resolved for this user within the organization (RBAC). */
  roles: string[];
  /** When true the user has opted into automation for non-destructive actions. */
  automationEnabled: boolean;
}

export interface AgentTask<TInput = unknown> {
  id: string;
  agent: AgentId;
  input: TInput;
  tenant: TenantContext;
}

export interface AgentError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface Agent<TInput = unknown, TOutput = AnalysisReport> {
  readonly id: AgentId;
  /** Names of the tools this agent is permitted to call. */
  readonly allowedTools: readonly string[];
  run(task: AgentTask<TInput>): Promise<Result<TOutput, AgentError>>;
}

export interface Orchestrator {
  /** Decide which agent should handle a free-form request. */
  route(request: string, tenant: TenantContext): Promise<AgentId>;
  dispatch<TInput, TOutput>(task: AgentTask<TInput>): Promise<Result<TOutput, AgentError>>;
}
