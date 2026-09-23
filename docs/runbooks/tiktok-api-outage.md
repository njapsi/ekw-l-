# Runbook: TikTok API outage or quota exhaustion

**Symptoms:** TikTok sync jobs fail; Connection Center shows `DEGRADED`/
`ERROR` for TikTok; publishing drafts get stuck in `AWAITING_APPROVAL` or
fail on submit.

## Diagnosis

1. Check `IntegrationHealth`/`OAuthConnection.lastError` for the failing
   TikTok connections (via `/admin`).
2. Distinguish an outage/quota issue (TikTok's own API returning 5xx or a
   rate-limit code — `DisplayTikTokClient`'s own typed failure modes,
   confirmed retried on transient rate limits by
   `tiktok/display-client.test.ts`) from an auth problem (see
   `oauth-failure.md`) from a **capability restriction** — TikTok's
   sandbox/audited-app distinction means some capabilities (non-private
   posting) may be genuinely unavailable for this app's current audit
   status, which is not an "outage" and must never be reported as one
   (`docs/TIKTOK-INTEGRATION.md`, `docs/TIKTOK-GROWTH-AGENT.md`).
3. Check TikTok for Developers' own status/announcements page.

## Commands / tools

`/admin` integration health views.

## Mitigation

- Outage/rate-limit: wait; the client already retries transient failures
  with backoff.
- A publish stuck at `AWAITING_APPROVAL`→submit failing repeatedly:
  check the content-hash duplicate guard hasn't incorrectly flagged a
  legitimate resubmission, and check the specific TikTok API error
  returned (quota, content-policy rejection, or a genuine outage each
  need a different response — do not retry blindly on a content-policy
  rejection).

## Recovery

No manual restart needed for sync; a stuck publish may need the user to
be told the specific reason (never silently retried indefinitely — Phase
14's own "no silently spending customer money / no misleading success
messages" principle applies equally to "silently retrying a rejected
publish").

## Verification

- A manual "sync now" succeeds.
- A test draft-and-approve-and-submit cycle completes (in a non-production
  TikTok sandbox app, never against a real customer's account for testing).

## Escalation

SEV-3 for a single organization; SEV-2 if TikTok's own API is down for
every organization using the integration.

## Post-incident

If a capability was mistakenly reported as "outage" when it was actually
an audit-status restriction, fix the error classification — this is
exactly the kind of "claim an integration is connected/working when it
isn't really" the master product principles forbid.
