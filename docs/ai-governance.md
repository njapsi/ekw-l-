# ai-governance.md — what AI may do, and who approves it

Code: `packages/services/src/governance/`, `approvals/`,
`agent/integration-tools.ts`, `agent/orchestrator.ts`, `automation/`.
Decision records: ADR-0022, ADR-0051, ADR-0052.

## 1. The rule

The AI agent is never an authorization bypass. "The user asked me" does not
widen what it may do. Every AI-initiated action goes through the same chain:

```
USER REQUEST → AGENT INTENT → TOOL → AUTHORIZATION → PERMISSION → GOVERNANCE → APPROVAL → EXECUTION
```

1. **Tool.** The agent has a closed registry of tools. Unknown tool names
   are refused, and tool inputs are Zod-validated.
2. **Authorization.** The organization comes from server context. The
   requesting user's role must grant the permission.
3. **Capability.** `assertCapabilityUsable` checks the connection's state and
   its actually-granted scopes or WordPress capabilities. The refusal names
   exactly what is missing.
4. **Governance.** The org's policy for that integration and action class
   (§2).
5. **Approval.** WRITE / PUBLISH / DANGEROUS always become a PENDING request
   that a human with `content.publish` must approve. The agent's only
   "write" tool is `integrations.propose_action`, which creates that request
   and nothing else.
6. **Execution.** It happens only in `decideActionRequest`, which re-checks
   capability _and_ governance at execution time.

## 2. The governance policy (Settings → AI governance)

The policy is stored per organization (`AiGovernancePolicy`) and validated
by a Zod schema. Without a stored row, `DEFAULT_POLICY` applies. A stored
row that no longer parses also falls back to the defaults, which are never
looser.

For each integration (YouTube, TikTok, WordPress, Search Console, Website):

| Setting      | Values                                   | Default                              |
| ------------ | ---------------------------------------- | ------------------------------------ |
| Agent access | allowed / not allowed                    | allowed                              |
| Analyze      | automatic · approval required · disabled | automatic                            |
| Generate     | automatic · approval required · disabled | automatic (Search Console: disabled) |
| Draft        | automatic · approval required · disabled | automatic (Search Console: disabled) |
| Modify       | **approval required** · disabled         | approval required                    |
| Publish      | **approval required** · disabled         | approval required                    |
| Delete       | **approval required** · disabled         | approval required                    |

Automation settings:

- **Minimum interval** between runs of one automation, in minutes. The
  default is 60 and the floor is 15.
- **Allowed background job types.** All are allowed by default.

**The schema cannot express automatic modify, publish or delete.** Hard
rule 4 would allow skipping approval in an explicit "automation mode", but
that mode does not exist in the product. So the safe floor is enforced by
the type, not by a UI convention. Only `agent.configure` holders (ADMIN+)
may change the policy. Every change is audited with a field-level diff
(`governance.updated`).

## 3. Where it is enforced

| Enforcement point                                   | What it checks                                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Growth Agent orchestrator (`CAPABILITY_GOVERNANCE`) | `agentAllowed` + `analyze` for YouTube / TikTok / Website analysts. A blocked capability is **skipped with the reason**, not run. |
| Agent tool `wordpress.list_content`                 | `agentAllowed` + `analyze` for WordPress                                                                                          |
| Approval requests (`requestIntegrationAction`)      | Disabled classes cannot be requested. `approval_required` on DRAFT routes drafts through approval.                                |
| Approval execution (`decideActionRequest`)          | Re-checks governance; a policy tightened after the request wins.                                                                  |
| Direct WordPress draft (`createDraft`)              | `draft = disabled` blocks it for everyone                                                                                         |
| Automation create / update                          | Allowed task type; cron interval ≥ the minimum                                                                                    |
| Automation run (`automationBlockReason`)            | Task type still allowed and org not being deleted; otherwise the run is SKIPPED and the rule PAUSED                               |

What "automatic" means today: an allowed action runs without a separate
approval step _when a person or an automation starts it_. The agent itself
has no direct-execution tools yet, and ADR-0022 still applies. When a future
phase gives the agent execution tools, they must call `assertGovernanceAllows`
before acting.

## 4. The approval object (Part 24)

`IntegrationActionRequest` holds:

| Field            | Contents                                               |
| ---------------- | ------------------------------------------------------ |
| id               | Approval id                                            |
| Organization     | The org the action belongs to                          |
| Requester        | `requestedById` + `source` (USER / AGENT / AUTOMATION) |
| Action           | `capabilityId`                                         |
| Target           | `integration` + `connectionRef`                        |
| Proposed changes | Exact `payload`, validated                             |
| Risk level       | `level`: WRITE / PUBLISH / DANGEROUS                   |
| Timing           | `createdAt`, `expiresAt` (7 days)                      |
| Status           | See below                                              |
| Approver         | `decidedById` + `decidedAt`                            |
| Outcome          | `executedAt`, `result` / `error`                       |

**Statuses:** PENDING, APPROVED, REJECTED, EXPIRED, CANCELLED, EXECUTED,
FAILED.

The approvals page shows the exact proposed payload before anyone approves.
A request from the agent is labelled as such. Approval is a single
conditional claim, so two approvers cannot execute it twice.

## 5. Worker authorization (Part 22)

Agent, report, content-generation and crawl jobs call `assertJobAuthorized`
before doing anything. Between enqueue and execution:

- the org may have entered deletion;
- the member may have been removed, demoted or deactivated.

Any of these makes the job fail with a clear reason. Integration syncs and
lifecycle sweeps are platform jobs. Each re-scopes to the row's own
organization and checks ownership before writing.
