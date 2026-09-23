# Runbook: OAuth failure (YouTube / TikTok / Search Console connect or refresh)

**Symptoms:** a user's "Connect" attempt fails, or a previously-connected
integration shows `EXPIRED`/`REAUTH_REQUIRED`/`ERROR` in the Connection
Center (`packages/services/src/integrations/contract.ts`'s 8-state model);
`IntegrationHealth` rows show repeated failures.

## Diagnosis

1. `/app/integrations/<provider>` — what state does the Connection Center
   actually show? (`NOT_CONNECTED`/`CONNECTING`/`CONNECTED`/`DEGRADED`/
   `EXPIRED`/`REAUTH_REQUIRED`/`ERROR`/`DISCONNECTED`.)
2. Check `OAuthConnection.lastError`/`IntegrationHealth.detail` for that
   connection (via `/admin`, secret-scrubbed) — a real error message from
   the provider, not a generic failure.
3. Common root causes, in order of likelihood:
   - The refresh token was revoked by the user at the provider (Google/
     TikTok account settings) — expected, requires reconnect.
   - The OAuth client's own credentials (`GOOGLE_OAUTH_CLIENT_ID`/
     `_SECRET`, `TIKTOK_CLIENT_KEY`/`_SECRET`) were rotated without
     updating the deployment's env.
   - The registered redirect URI no longer matches the deployed domain
     (a domain change, an accidental staging-URL leftover in a production
     OAuth client's allowed redirect list).
   - Provider-side quota/outage — check the provider's own status page.
4. If the failure is specifically at the **callback** step (not
   connect-start): check for a rejected signed `state` (session mismatch —
   ADR-0029's session-binding check) — this is a security feature working
   as intended if a user tried to complete a connect flow in a different
   browser session than they started it in, not a bug.

## Commands / tools

`/admin` connection health views; the provider's own developer-console
status page (Google Cloud Console / TikTok for Developers).

## Mitigation

- Revoked/expired token: nothing to fix — the user reconnects via
  `/app/integrations/<provider>`.
- Rotated client credentials: update the env var, redeploy.
- Redirect URI mismatch: fix the registered URI in the provider's console
  to match `https://<domain>/api/integrations/<provider>/callback` exactly.
- Provider outage: wait; the Connection Center should show `DEGRADED`/
  `ERROR`, never a false `CONNECTED` (Phase 14 §9's own requirement —
  verified against `contract.ts`'s state-resolution logic, not live
  against a real provider outage in this sandbox).

## Recovery

Once the root cause is fixed, the user (or an admin re-triggering a health
check) reconnects; confirm the Connection Center shows `CONNECTED` and a
real data fetch (e.g. a channel list) succeeds.

## Verification

- Connection Center state matches actual backend reachability.
- A real API call against the reconnected integration returns data.

## Escalation

SEV-3 for a single organization's expired token (self-service reconnect);
SEV-2 if it's the OAuth client's own credentials/redirect URI (affects
every organization trying to connect that provider).

## Post-incident

If this was caused by a redirect-URI/domain change, add a checklist item
to `docs/GO-LIVE.md`'s domain-change procedure so it isn't missed again.
