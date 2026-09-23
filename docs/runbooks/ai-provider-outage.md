# Runbook: AI provider outage

**Symptoms:** `/api/health`'s `ai_provider` check reports `down`; AI Agent
chat, analyst agents, and content generation fail or fall back to their
deterministic paths; users report the AI Agent "isn't working."

## Diagnosis

1. `curl -sf https://<domain>/api/health?deep=1 | jq` (as platform staff —
   the deep AI probe is staff-only) for the actual reachable/unreachable
   detail.
2. Check the configured provider's own status page (Anthropic/OpenAI/
   Google, whichever `AI_MODEL_*`/API key is active).
3. Confirm this isn't `AI_DISABLED`/`AI_DISABLED_PROVIDERS` being set
   deliberately (Phase 22's kill switch) rather than a real outage —
   check the deployment env first.

## Commands / tools

`/api/health?deep=1` (staff session or `Bearer $METRICS_TOKEN` where
applicable); the provider's status page.

## Mitigation

- Real provider outage: `packages/ai`'s `withResilience` already retries
  transient failures once and `FallbackProvider` (`AI_FALLBACK_MODELS`)
  can fail over to a different provider/model if configured — confirm
  it's actually configured for this deployment (optional, not on by
  default).
- No fallback configured and the outage is prolonged: every analyst agent
  has a deterministic fallback path that still produces a real, non
  -fabricated result without a model call (documented throughout
  `docs/AI-ARCHITECTURE.md`) — the product **degrades**, it does not fail
  outright, for most AI-touching features. The interactive AI Agent chat
  itself has less of a deterministic substitute and will genuinely be
  degraded.
- Runaway/unexpected cost during what looks like an "outage": see
  `security-incident.md`'s "abnormal AI spending" scenario instead — a
  cost spike is a different problem from unavailability.

## Recovery

No restart needed; confirm `ai_provider` returns to `ok` once the
provider recovers.

## Verification

- `/api/health?deep=1` shows the provider reachable.
- A real AI Agent turn produces a real (not fallback) model response.

## Escalation

SEV-3 (degraded, not down, for most features) — SEV-2 if the interactive
AI Agent is the primary sold feature and is unusable for an extended
period.

## Post-incident

If this recurs often, `AI_FALLBACK_MODELS` cross-provider failover is a
real, already-built mitigation worth actually configuring rather than
leaving optional.
