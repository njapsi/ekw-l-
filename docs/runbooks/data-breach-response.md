# Runbook: Data breach response

This runbook is for a **confirmed** breach — cross-tenant data exposure,
confirmed unauthorized database access, or confirmed exfiltration of
customer data. For a *suspected* issue still being triaged, start at
`security-incident.md` or `docs/INCIDENT-RESPONSE.md` §8 ("Tenant data
leak") first; escalate here once confirmed.

## Symptoms / confirmation criteria

- The tenant-isolation integration suite fails in CI, or a manual
  reproduction confirms org A can read org B's data.
- Confirmed unauthorized database access (see `database-failure.md`'s
  diagnosis steps for detecting an unrecognized connection source, if
  that's the vector).
- A confirmed report (internal or external) of one organization's data
  appearing where it shouldn't.

## Immediate actions (contain, in order)

1. **Identify the exact vulnerable code path** — which query, which
   route, which tool. Check whether the affected model is even covered by
   `scripts/check-tenant-scope.mjs`'s allowlist (Phase 12 found and fixed
   21 models that had silently gone unchecked — confirm the offending
   model isn't a similar gap).
2. **Stop the bleeding** — take the specific feature/route offline (a
   targeted 503, not a full outage) if the blast radius can be isolated;
   otherwise this may require a full application pause.
3. **Ship the scoping fix** — add the missing `organizationId` filter,
   add the model to the tenant-scope lint's allowlist if it was missing,
   and add a cross-tenant integration test reproducing the exact leak
   *before* confirming the fix (this project's established pattern).
4. **Determine exact scope** — which organizations' data was exposed to
   which other organization(s), and for how long (check git history /
   deployment history for when the vulnerable code was introduced).

## Notification (not optional for a confirmed breach)

Per `docs/INCIDENT-RESPONSE.md` §8: **every affected organization gets
direct notification naming what was exposed** — this is the one scenario
that document treats as always warranting proactive customer
communication, not a case-by-case call. Legal/regulatory notification
timelines apply if EU/CA personal data is in scope (GDPR's 72-hour rule);
escalate to whoever holds legal responsibility for the business
immediately, in parallel with technical containment, not after.

## Recovery

Deploy the fix; re-run the full tenant-isolation integration suite
(`security/tenant-isolation.integration.test.ts` and any newly-added
reproduction test) against a real database before considering this
resolved — a fix that only typechecks is not verified.

## Verification

- The specific reproduction test now passes (org A genuinely cannot read
  org B's data through the fixed path).
- `scripts/check-tenant-scope.mjs` is clean, and the affected model is in
  its allowlist.
- No other model shares the same unscoped-query pattern (grep for the
  same anti-pattern elsewhere before declaring this closed).

## Escalation

Always SEV-1. This is the single scenario `docs/INCIDENT-RESPONSE.md`
treats with zero ambiguity about notification.

## Post-incident

This is also the standing argument for prioritizing the deferred Postgres
RLS retrofit (ADR-0035, ADR-0061) — a confirmed breach here is exactly the
failure mode RLS would make structurally impossible rather than dependent
on a lint catching it.
