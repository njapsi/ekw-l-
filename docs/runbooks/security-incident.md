# Runbook: Security incident (general)

This is the entry point for any suspected security incident that doesn't
already have a more specific runbook. For the ten specific, detailed
scenarios this project has step-by-step procedures for (OAuth token
compromise, API key compromise, database compromise, AI provider key
compromise, webhook secret leak, admin account compromise, `ENCRYPTION_KEY`
compromise, tenant data leak, crawler misuse, Growth Mission misuse), go
directly to **`docs/INCIDENT-RESPONSE.md`** instead — it has the real
detect/contain/investigate/mitigate/recover/communicate/postmortem/
preventive-action steps for each, naming the actual kill switches and
revocation functions this codebase has.

## Symptoms that land here (not already covered by a specific runbook)

- Repeated failed logins against one or many accounts (`SecurityEvent`
  `REPEATED_LOGIN_FAILURE`).
- Suspicious API usage pattern (a burst of `/api/v1/*` calls, an unusual
  access pattern from one API key).
- A prompt-injection or tool-abuse attempt against the AI Agent.
- Unauthorized organization access attempt (a cross-tenant request that
  was correctly rejected — confirm it *was* rejected, then decide whether
  it's a probe worth watching or a one-off).
- Abnormal AI spending (a sudden spike in `AI_REQUESTS`/`AI_TOKENS` usage
  for one org, beyond normal usage-threshold-alert territory).
- A malicious/malformed webhook request.
- OAuth callback abuse (repeated callback hits with invalid/mismatched
  `state`).

## Diagnosis

1. Identify the severity using `docs/INCIDENT-RESPONSE.md`'s SEV-1..4
   table.
2. Query `SecurityEvent` (per-user) and `AuditLog` (per-org) for the
   actual sequence of events — both are real, already-instrumented tables,
   not something to add.
3. For an AI-specific concern, check `AgentRunEvent` for the specific
   run's timeline and whether `finalizeBlocks`'s forced-confirmation
   invariant and `scrubModelOutput`'s output-side secret scrubbing
   (Phase 25) actually fired as designed.

## Commands / tools

`/admin` security/audit views; direct `SecurityEvent`/`AuditLog`/
`AgentRunEvent` queries (never expose raw query results with tokens/
secrets to anyone without a legitimate need).

## Mitigation

Match the specific scenario in `docs/INCIDENT-RESPONSE.md` if it's one of
the ten named ones. Otherwise: contain first (revoke the specific
session/key/connection involved), then investigate scope, following the
same detect→contain→investigate→mitigate→recover→communicate→postmortem→
preventive-action shape.

## Recovery

Scenario-dependent — see the specific runbook or `docs/INCIDENT-RESPONSE.md`.

## Verification

Confirm the specific control that should have stopped this (rate limit,
tenant-scope check, tool authorization, output scrubbing) actually did,
via the relevant test suite (`security/*.test.ts`, `agents/
ai-red-team.test.ts`, `seo/ssrf.test.ts`) re-run against current code, not
just assumed from documentation.

## Escalation

Per `docs/INCIDENT-RESPONSE.md`'s severity table. **No automated
alerting/paging exists on any `SecurityEvent` yet** (a disclosed gap,
`RISK-ALERT-1` in `docs/SECURITY_POSTURE.md`) — detection today depends on
someone actively looking.

## Post-incident

Write up within 5 business days; add a regression test reproducing the
specific attack if one doesn't already exist (matching this project's
established "reproduce the attack as a test before/while fixing it"
convention from Phases 24/25).
