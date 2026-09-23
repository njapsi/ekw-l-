# Runbook: Google Search Console outage

**Symptoms:** Search Console sync jobs fail; `/app/seo/search-console`
shows stale data; Connection Center shows `DEGRADED`/`ERROR`.

## Diagnosis

1. Check `IntegrationHealth`/`SearchConsoleSnapshot` failures (via
   `/admin`).
2. Distinguish an outage (Google's own status) from an auth problem (see
   `oauth-failure.md` — Search Console shares the Google OAuth client with
   YouTube, provider-aware via the signed `state.provider`) from a
   property-access issue (the connected Google account no longer has
   Search Console access to that property — a legitimate, non-outage
   state that should surface as a clear "property access lost" message,
   not a generic error).

## Commands / tools

`/admin` integration health views.

## Mitigation

- Outage: wait; syncs resume on the next scheduled tick.
- Lost property access: the user needs to re-grant Search Console access
  to the property at Google's end, then reconnect.

## Recovery

No manual restart needed for a transient outage.

## Verification

- A manual sync succeeds and returns real Google data (never fabricated —
  `docs/GOOGLE-SEARCH-CONSOLE.md`'s own "every displayed figure is
  Google's own" principle).

## Escalation

SEV-3 (single feature, not core to the platform).

## Post-incident

None specific — this integration's read-only, non-sensitive-scope design
(`webmasters.readonly`) means an outage here has a contained blast radius
by construction.
