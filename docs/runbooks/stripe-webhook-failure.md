# Runbook: Stripe webhook failure

**Symptoms:** subscription/entitlement state stops updating after a real
Stripe event (a plan change, a payment); `BillingEvent` rows accumulate in
`FAILED` status; the `webhook_signature_failures_total` metric spikes
(Phase 31's own added metric).

## Diagnosis

1. Query `BillingEvent` (via `/admin` or a direct read) for rows with
   `status: FAILED` — read the `error` column for the actual handler
   exception, not just "it failed."
2. Check Stripe's own Dashboard → Developers → Webhooks → the endpoint's
   delivery log for the exact HTTP status this app returned and the
   response body.
3. A spike in `webhook_signature_failures_total` with no corresponding
   real Stripe event means either: `STRIPE_WEBHOOK_SECRET` is wrong/stale
   (was it rotated at Stripe without updating the deployment env?), or a
   malicious/malformed request is hitting the endpoint (expected to be
   rejected — not itself an incident unless volume is abnormal, see
   `security-incident.md`).

## Commands / tools

Stripe Dashboard webhook delivery log; `/admin` billing event views;
`curl` a deliberately-bad-signature test request to confirm the endpoint
still correctly 400s (matching Phase 31's own live verification method).

## Mitigation

- Wrong/stale `STRIPE_WEBHOOK_SECRET`: update it from Stripe's dashboard
  value, redeploy. Every event Stripe already attempted will be
  automatically **redelivered** by Stripe's own retry policy — no manual
  replay needed for those (Stripe retries failed webhooks on its own
  schedule for up to 3 days).
- A real handler bug (a `FAILED` row with a genuine application exception,
  not a signature failure): fix the bug, then trigger `resend` for the
  specific stuck event from Stripe's dashboard, or wait for Stripe's own
  retry — the handler is idempotent either way (event-id ledger + upsert
  -keyed writes), so a redelivery is always safe.

## Recovery

Confirm the next real Stripe event (or a manual "resend" from Stripe's
dashboard for a previously-failed one) processes to `PROCESSED`.

## Verification

- `BillingEvent` rows for the affected event(s) show `status: PROCESSED`.
- The affected organization's `Subscription`/`Entitlement` rows reflect
  the correct, current state.
- `webhook_signature_failures_total` returns to baseline.

## Escalation

SEV-2 (billing correctness) — SEV-1 if it has caused a customer to be
incorrectly denied or granted access based on stale entitlement state.

## Post-incident

If caused by a secret rotation without updating the deployment, add a
checklist item to whatever process rotates Stripe secrets so this doesn't
recur.
