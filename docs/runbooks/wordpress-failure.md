# Runbook: WordPress connection failure

**Symptoms:** WordPress sync fails; drafts/updates fail to create; the
Connection Center shows `DEGRADED`/`ERROR`/`REAUTH_REQUIRED` for a
WordPress site.

## Diagnosis

1. Check `WordPressSite.lastError`/`lastCheckOk` (via `/admin`).
2. Common causes: the Application Password was revoked/regenerated at the
   WordPress site itself (the customer's own site admin, outside this
   app's control); the site's URL changed; the site is temporarily down
   (their hosting, not ours); a WAF/security plugin on their site started
   blocking this app's requests.
3. Confirm this app's own SSRF-safe fetch client (`seo/fetch.ts`,
   `assertSafeUrl`) isn't the cause — check whether the site's IP
   legitimately changed to something now correctly flagged as private
   /internal (a real, rare false-positive-shaped case worth ruling out,
   not assuming).

## Commands / tools

`/admin` integration health views; `wordpress/probe.ts`'s "Test
connection" from the Connection Center UI.

## Mitigation

- Revoked Application Password: the user generates a new one on their
  WordPress site and reconnects via `/app/integrations/wordpress`.
- Site down: nothing to fix on this app's side; wait for their site to
  recover.
- WAF blocking: the customer needs to allowlist this app's egress, if
  known/stable, or relax the rule blocking REST API requests to `wp/v2`.

## Recovery

User reconnects with fresh credentials; confirm "Test connection"
succeeds and a sync picks up real content.

## Verification

- Connection Center shows `CONNECTED`.
- A real post/page list is fetched (not fabricated).

## Escalation

SEV-4 (single customer's own external site, not a shared dependency) —
unless it reveals a genuine bug in this app's WordPress client, in which
case treat by actual severity of that bug.

## Post-incident

If caused by an SSRF-guard false positive, that is a HIGH-severity finding
in its own right — treat it with the same rigor as
`docs/CRAWLER-SECURITY-AUDIT.md`'s live-reproduction convention, not a
quick patch.
