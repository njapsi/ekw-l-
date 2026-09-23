# Runbook: YouTube API outage or quota exhaustion

**Symptoms:** YouTube sync jobs fail; the Connection Center shows
`DEGRADED`/`ERROR` for YouTube; `/app/youtube/*` pages show stale data with
a "last synced" timestamp that isn't advancing.

## Diagnosis

1. Check `IntegrationHealth`/`OAuthConnection.lastError` for the specific
   YouTube connections failing (via `/admin`).
2. Distinguish quota exhaustion (a specific YouTube Data/Analytics API
   quota-exceeded error code) from a genuine outage (Google Cloud's own
   status page) from an auth problem (see `oauth-failure.md` instead if
   the error is 401/invalid_grant, not a quota/5xx).
3. Check whether this is affecting one organization (their own API quota,
   if using per-project quota) or every organization (this app's shared
   Google Cloud project quota, the more likely shared-fate scenario).

## Commands / tools

`/admin` integration health views; Google Cloud Console's API quota
dashboard for the project backing `GOOGLE_OAUTH_CLIENT_ID`.

## Mitigation

- Quota exhaustion: this is rate-limited at the request layer already
  (`docs/SECURITY.md` §8), but a genuine quota exhaustion needs either
  waiting for the daily quota reset or requesting a quota increase from
  Google — no in-app mitigation beyond backing off retries (already
  handled by `GoogleYouTubeClient`'s own retry/backoff on transient 5xx,
  confirmed by `youtube/google-client.test.ts`'s "retries transient 5xx"
  test).
- Outage: wait for Google's own recovery; syncs resume automatically on
  the next scheduled tick once the API responds normally again.

## Recovery

No manual restart needed — `youtube-sync` queue jobs retry with
exponential backoff (Phase 12's `STANDARD_JOB_OPTIONS`) and resume once
the API is healthy.

## Verification

- A manual "sync now" for a test connection succeeds.
- `/app/youtube/overview`'s "last synced" timestamp advances again.

## Escalation

SEV-3 (single feature degraded, not an outage of the whole app) unless
quota exhaustion is affecting every organization simultaneously, in which
case SEV-2 (a real product-facing degradation for all customers using this
integration).

## Post-incident

If quota exhaustion caused this, evaluate whether the sync frequency or
per-org data volume needs a cap, or whether a quota increase request to
Google is warranted before the next occurrence.
