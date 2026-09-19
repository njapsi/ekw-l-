# INTEGRATIONS.md — the unified integration layer

How every external connection in Growth Agent is described, stated,
permissioned and diagnosed. Provider-specific detail lives in
`YOUTUBE-INTEGRATION.md`, `TIKTOK-INTEGRATION.md`,
`GOOGLE-SEARCH-CONSOLE.md` and `SEO-ENGINE.md`; this document covers what
they have in common.

See ADR-0050 for why this is a layer over the existing tables rather than a
replacement for them, and ADR-0051 for the WordPress connector, the sync
framework, the token lifecycle, the approval queue and the agent tools.

---

## 1. Status

| Integration           | Auth                 | Implemented | Backing table     |
| --------------------- | -------------------- | ----------- | ----------------- |
| YouTube               | Google OAuth         | ✅          | `OAuthConnection` |
| Google Search Console | Google OAuth         | ✅          | `OAuthConnection` |
| TikTok                | Login Kit + PKCE     | ✅          | `OAuthConnection` |
| Website               | Ownership proof      | ✅          | `Website`         |
| WordPress             | Application Password | ✅          | `WordPressSite`   |

WordPress details: `docs/WORDPRESS-INTEGRATION.md`.

---

## 2. Connection states

`resolveConnectionState()` (`packages/services/src/integrations/contract.ts`)
is the single definition. It is pure — it takes rows, not a database — and
derives all eight states from columns that already exist.

| State             | Meaning                                                                | User action |
| ----------------- | ---------------------------------------------------------------------- | ----------- |
| `NOT_CONNECTED`   | No connection for this org.                                            | Connect     |
| `CONNECTING`      | Setup started but incomplete (e.g. a website added, not yet verified). | Configure   |
| `CONNECTED`       | Valid credential, last probe succeeded.                                | None        |
| `DEGRADED`        | Credential valid, but the last request failed (quota, outage, scope).  | Retry       |
| `EXPIRED`         | Access token lapsed **and a refresh token exists** — self-healing.     | None        |
| `REAUTH_REQUIRED` | Cannot recover automatically; the user must re-consent.                | Reconnect   |
| `ERROR`           | The provider rejected our last request for an unclassified reason.     | Retry       |
| `DISCONNECTED`    | Revoked, by the user or by the provider. Credentials scrubbed.         | Connect     |

Two rules that matter:

- **`EXPIRED` is not an error.** It means a refresh token is on file and the
  next sync will renew silently. Showing a red banner here trains users to
  ignore banners. `REAUTH_REQUIRED` is the state that genuinely needs them.
- **Never probed ≠ degraded.** A connection with no `IntegrationHealth` row
  reports `CONNECTED`, not `DEGRADED`. Unknown is not broken.

### Three different kinds of "unavailable"

Conflating these is a real bug class, so they are distinct:

- **Not configured** — the _deployment_ has no credentials for the provider.
  An operator problem. The card says so and disables the button rather than
  offering a Connect flow that would fail.
- **Not connected** — the deployment is fine; this organization has not
  linked an account.
- **Not implemented** — Growth Agent has no such integration (WordPress
  today). Never rendered as a Connect button.

---

## 3. Capabilities and the permission model

Every integration declares a fixed list of capabilities. The registry is
hard-coded — capabilities are a security boundary and are never derived
from a model or from provider responses.

| Level       | Meaning                            | Approval                            |
| ----------- | ---------------------------------- | ----------------------------------- |
| `READ`      | Reads data only.                   | None                                |
| `DRAFT`     | Creates something only we can see. | None                                |
| `WRITE`     | Changes an external system.        | Explicit approval                   |
| `PUBLISH`   | Makes something publicly visible.  | Explicit approval                   |
| `DANGEROUS` | Destructive / irreversible.        | Approval **per action**, every time |

This encodes hard rule 4: anything that leaves a visible mark outside
Growth Agent requires a human to approve it, and destructive actions can
never be blanket-approved.

`resolveCapabilities(descriptor, grantedScopes, state)` narrows the baseline
list against a specific connection:

- A capability whose `requiredScopes` were not granted resolves to
  `REQUIRES_SCOPE`, no matter what the baseline said. This is what stops the
  UI advertising "✓ Analytics" for a connection that never received the
  analytics scope.
- A baseline-gated capability is _promoted_ to `AVAILABLE` once its scopes
  really are present (e.g. a user who opted into YouTube revenue analytics).
- `REQUIRES_PROVIDER_APPROVAL` (TikTok public posting, pending their app
  audit) stays gated even with the scope granted — the scope is ours, the
  approval is theirs.
- Nothing is `usable` while the connection itself is not (`isUsable(state)`).

Every non-available capability carries a concrete `unavailableReason`. A
test enforces this; "not available" with no explanation is not acceptable.

---

## 4. Diagnostics

`diagnoseConnection()` returns, for any state:

- `category` — `AUTH | PERMISSION | QUOTA | PROVIDER | NETWORK | CONFIG | NONE`
- `title` — a short headline
- `explanation` — plain language, never "Something went wrong"
- `recommendedAction` — what the user should actually do
- `technicalDetail` — provider text, run through `scrubSecrets`, capped at
  500 characters, shown behind a disclosure
- `referenceId` — deterministic, greppable, containing no secret and no full
  connection id

Classification is deliberately conservative: an unrecognised provider error
is `PROVIDER`, never a guess at `AUTH`. Telling a user to reconnect when the
real cause was a provider outage is worse than saying "retry".

A key with no descriptor degrades to a generic label instead of throwing —
a diagnostic function must never be the thing that crashes.

---

## 5. Testing a connection

`testConnection(organizationId, connectionId, redirectUri)`
(`integrations/probe.ts`) makes one real read-only call and records the
outcome in `IntegrationHealth`.

| Provider       | Probe                                       | Cost         |
| -------------- | ------------------------------------------- | ------------ |
| YouTube        | `GET youtube/v3/channels?part=id&mine=true` | 1 quota unit |
| Search Console | `GET webmasters/v3/sites`                   | negligible   |
| TikTok         | `GET user/info/?fields=open_id`             | negligible   |

- Tenant ownership is asserted (`requireConnection`) **before** any network
  call.
- The token is refreshed first through the existing `withFreshAccessToken`,
  so a probe both tests and repairs an `EXPIRED` connection.
- Bounded by a 10-second timeout.
- Rate-limited at 10 per 5 minutes per user per org in the Server Action,
  because each call spends the org's provider quota.
- A failure is recorded as a failure. The probe never reports success it did
  not observe.

---

## 6. The Connection Center

`getConnectionCenter(organizationId)` (`integrations/center.ts`) returns one
entry per integration in a single query pass, combining descriptor + state +
diagnostic + resolved capabilities + account label + last-checked time.

Tenant scoping: every query filters on `organizationId`, which callers must
take from the session, never from request input. A dedicated test asserts
this, and `scripts/check-tenant-scope.mjs` enforces it in CI.

The read model deliberately excludes every token column. A test asserts that
no ciphertext appears in the serialized output.

Rendered at `/app/integrations`. The per-provider management pages
(`/app/integrations/youtube`, `/tiktok`, `/search-console`) are unchanged and
remain where connecting and disconnecting actually happen.

---

## 7. Adding an integration

1. Add an `IntegrationDescriptor` to `INTEGRATIONS` in `contract.ts`, with
   every capability's level, required scopes and — if it is not available —
   a concrete reason.
2. If it is OAuth-backed, add the provider to the Prisma
   `IntegrationProvider` enum and register its OAuth implementation with
   `registerProviderOAuth`.
3. Add it to `OAUTH_KEYS` and `MANAGE_HREF` in `center.ts`; if it is backed
   by a different table, add a branch like `websiteEntry`.
4. Add a probe to `PROBES` in `probe.ts`.
5. Add `isProviderConfigured` handling for its credentials.

Steps 1 and 5 alone are enough to render it honestly as unavailable, which
is the correct interim state — never a Connect button with nothing behind it.

---

## 8. API resilience (`integrations/resilience.ts`)

One error vocabulary (`IntegrationApiError.kind`: auth · permission ·
not_found · validation · rate_limited · server · timeout · network ·
circuit_open) and three composable pieces:

- `withRetry` — full-jitter exponential backoff (500 ms base, 8 s cap, 2
  retries by default). The provider's `Retry-After` wins (capped at 60 s).
  Only `rate_limited` / `server` / `timeout` / `network` are retried. A 401
  is never retried.
- `CircuitBreaker` — per key, in-process. Opens after 5 consecutive
  _transient_ failures, half-opens after 30 s with a single trial call. A
  credential error never trips it, so one bad token cannot block every
  other org's calls to the same provider.
- `withTimeout` — a hard deadline on any promise.

`resilientCall` composes them: breaker(retry(timeout(call))). The WordPress
client and the connection probe use it. The existing YouTube / TikTok clients
keep their own tested retry paths.

## 9. Sync framework (`sync/`)

`runIntegrationSync({ organizationId, key, connectionRef, trigger })` is the
single entry point for "Sync now", the schedule and automations.

- **Tenant check first.** The connection must belong to the org, or nothing
  is written.
- **Single-flight.** The run row is inserted first. Only the earliest
  `RUNNING` row for a connection proceeds, ordered by `(startedAt, id)`.
  Others are recorded `SKIPPED`.
- **Stale-run recovery.** A `RUNNING` row older than 30 min is closed as
  `FAILED` ("Abandoned…").
- **Ledger.** `IntegrationSyncRun` records status, items, duration and the
  scrubbed error. The Connection Center shows the last success and the last
  failure. Runs from the older per-provider tables still count.
- **Failure notice.** After 3 consecutive failures, one notification per
  connection per day.
- **Schedule.** The worker's `integrations` queue runs a `sync-sweep` every
  15 min, at most 10 syncs per tick. Freshness is YouTube / TikTok / Search
  Console 24 h and WordPress 12 h. After failures the backoff is 1 h, 2 h,
  4 h, … up to the interval. Kill switch: `INTEGRATION_SCHEDULED_SYNC=0`.

Websites are crawled (a separate, metered flow), not synced.

## 10. Token & credential lifecycle (`integrations/lifecycle.ts`)

The worker runs a `lifecycle-sweep` every 15 min:

1. **Refresh-ahead.** OAuth tokens expiring within 15 min that were not
   refreshed in the last 6 h are refreshed now. A rejected refresh marks the
   connection `ERROR` and notifies whoever connected it, once per day.
2. **Unrecoverable connections.** A connection with no refresh token that is
   about to lapse gets a warning.
3. **WordPress re-validation.** Application passwords are checked daily. A
   401 means `REAUTH_REQUIRED`, plus a notification.
4. **Key rotation.** While `ENCRYPTION_KEY_PREVIOUS` is set, rows sealed with
   it still open, and the sweep re-seals them under the current key. It logs
   "N stale credentials". Remove the old key once N is 0.
5. **Approval TTL.** Pending requests older than 7 days become `EXPIRED`.

## 11. Approval queue (`approvals/`)

WRITE / PUBLISH / DANGEROUS actions reach an external system only through
`decideActionRequest(…, 'approve')`:

`PENDING → APPROVED → EXECUTED | FAILED`, or `REJECTED`, `CANCELLED`,
`EXPIRED`.

- A capability can only be requested if it has a registered executor. Today
  those are `wordpress.update_post` and `wordpress.publish`. TikTok
  publishing keeps its own flow.
- Permissions are checked when the action is requested **and again when it
  executes**, because a WordPress user may have been downgraded in between.
- The claim is a single conditional `updateMany`. Two concurrent approvals
  execute once.
- Deciding needs `publish:external` (ADMIN+). Requesting needs
  `content:manage`.
- UI: `/app/integrations/approvals` shows the exact payload before approval.

## 12. Agent tools (`agent/integration-tools.ts`)

`integrations.list_connections`, `integrations.get_capabilities` and
`wordpress.list_content` are READ tools. `integrations.propose_action`
**only creates a PENDING request** (`source = AGENT`). Every tool runs
`assertCapabilityUsable` first, and the org id comes from server context.
The Growth Agent's `org-context` evidence now lists each connection's state
and its usable capabilities.
