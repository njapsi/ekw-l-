# enterprise-identity.md — accounts, organizations, sessions, invitations, API keys

Decision record: ADR-0052. Companion docs: `docs/rbac.md`,
`docs/tenant-isolation.md`, `docs/audit-logging.md`, `docs/ai-governance.md`.

## 1. Authentication (audited, improved, not replaced)

The Phase 2 audit found the existing Auth.js v5 setup sound, so it was kept:

- **Providers:** magic link, email + password, Google, and a dev-only login.
- **Sessions:** JWT sessions (ADR-0011), 8 h rolling. Edge middleware checks
  only the signature. The authoritative check is `requireUser()` on the
  server.
- **Cookies:** `SameSite=Lax`, HTTP-only, `__Secure-` prefix on HTTPS.
- **CSRF:** Auth.js's own CSRF token protects its endpoints. Server Actions
  have Next.js origin checks.

Auth.js was not replaced, and there is no second authentication system.

**What Phase 2 changed:**

| Area                 | Before                                                                      | After                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-up              | **Set a password on any existing password-less account (account takeover)** | An existing account is never modified. The inbox owner gets a "set a password" link (`auth/signup.ts`).                                                                                   |
| Sessions             | Revocable only all-at-once (`sessionVersion`)                               | Server-side `UserSession` registry: sign out one device, or all others. 30-day absolute lifetime.                                                                                         |
| Password change      | Session only; other sessions survived                                       | Needs the current password unless the user signed in within the last 15 min. Revokes every other session.                                                                                 |
| Failed logins        | Not recorded                                                                | `AUTH_LOGIN_FAILED` security events. A CRITICAL `REPEATED_LOGIN_FAILURE` at 5 failures in 15 min. The existing per-address rate limit is the throttle, not a hard lockout (NIST 800-63B). |
| Rate limits          | Magic link and password login only                                          | Plus per-IP sign-up / reset / resend, password change, invitations, API-key creation and use, re-auth links, exports.                                                                     |
| Sensitive changes    | No re-authentication                                                        | Deletion, deactivation and ownership transfer need a sign-in within 15 min. Otherwise the user confirms via a fresh email sign-in link.                                                   |
| Account deactivation | None                                                                        | Sessions revoked and owned automations paused. Signing in again reactivates the account.                                                                                                  |

**Magic links:** Auth.js `VerificationToken`, single use, 15 minutes, stored
hashed, rate-limited to 5 per hour per address. Redirects are limited to
same-site paths by Auth.js.

## 2. User account

| Field                 | Source                                                                     |
| --------------------- | -------------------------------------------------------------------------- |
| Name, email, avatar   | `User`                                                                     |
| Email verification    | `User.emailVerified`                                                       |
| Account status        | `deletedAt` / `deletionScheduledAt` / `deactivatedAt` (new)                |
| Last login / activity | `lastLoginAt` / `lastActiveAt` (new; activity written at most every 5 min) |
| Time zone, locale     | `UserProfile`                                                              |
| Preferences           | `UserPreference`                                                           |
| Security              | `UserSession`, `SecurityEvent`, `UserMfaFactor` (new)                      |

## 3. Organizations

`Organization` gains `timezone` and `defaultLocale`. Users belong to many
organizations through `Membership`.

**The active organization:**

- It is named by an HTTP-only cookie, `ga_active_org`.
- It is verified against the database on every request.
- It never comes from request input.

**Switching** (`OrgSwitcher`):

1. Re-verifies membership on the server.
2. Navigates to the dashboard, so no page belonging to the previous
   organization stays open.
3. Remounts the whole app content area (`<main key={activeOrgId}>`), so no
   client-side state survives the switch.

Settings → Organization edits the name, slug, time zone and language. Logo
upload is **not implemented**: it needs object storage, which does not exist.

## 4. Sessions (`auth/sessions.ts`)

- **At sign-in.** The `jwt` callback creates a `UserSession` and stores its
  id (`sid`) and `authAt` in the JWT. The row records the auth method, a
  user-agent, and a **network prefix**, not the IP address: IPv4 is reduced
  to /24 and IPv6 to /48.
- **Device and IP capture.** The `/api/auth/[...nextauth]` route runs each
  request inside an `AsyncLocalStorage` scope, so the callback can see the
  device and IP.
- **Per-request check.** `requireUser()` → `validateSession()` rejects a
  token whose row is missing, revoked, expired (30-day absolute cap) or
  belongs to another user.
- **"Sign out this device"** marks the row revoked. The UI addresses
  sessions by a hashed handle, never the id.
- **"Sign out all other sessions"**:
  1. Revokes every other row.
  2. Bumps `sessionVersion`, which also ends tokens issued before session
     tracking existed.
  3. Re-issues the current token so this browser stays signed in.
- **Suspicious-session hook.** A login from a network prefix or device not
  seen in the user's last 20 sessions is recorded as a WARNING-level
  `AUTH_LOGIN` with `newNetwork` / `newDevice` flags.
- **Location.** It is shown as a network range only. There is no GeoIP
  database, and the UI says so rather than inventing a city.

## 5. Invitations (`organizations/members.ts`)

- **The token.** A 256-bit random token; only its SHA-256 is stored. It
  expires after 7 days and is sent by email when a transport is configured
  (otherwise the link is shown to the inviter).
- **One live invitation per address.** Re-inviting rotates the token, so the
  old link dies.
- **Actions:**
  - **Resend** rotates the token (capped at 5 sends).
  - **Revoke** is available to anyone with `member.invite`.
  - **Accept** happens on a POST from the invitation page. Opening the link
    changes nothing (mail scanners open links too).
- **Checks at acceptance:**
  - The token is valid, not expired and not revoked.
  - **The email matches.**
  - The organization is not being deleted.
  - **The inviter is still entitled to grant the role.**
  - The accept is a single-use conditional claim (concurrent accepts create
    one membership).
- **No enumeration.** Every invalid state produces the same generic message.

## 6. API keys (`apikeys/`)

- **Format.** `ga_<12-hex prefix>_<256-bit secret>`. The secret is shown
  once. Only SHA-256(secret) is stored, and it is compared in constant time.
- **Scopes.** `agent:read agent:run analytics:read content:read content:write
seo:read seo:write integrations:read integrations:manage`.
  - A key can never exceed its creator's permissions.
  - **Every request re-checks that the creator is still an active member
    whose role still grants each scope.** A demoted or removed creator
    neuters their keys.
- **Lifecycle.** Keys have a name, creation date, last-used time (written at
  most once a minute), expiry (30 d / 90 d / 1 y / never) and revocation.
  An org can have at most 25 active keys.
- **Endpoints.** `/api/v1/*` authenticates only by `Authorization: Bearer`.
  It never reads the session cookie, and a key never works on `/app` or
  Server Actions. The rate limit is 120 requests/min per key. Every failure
  (unknown, revoked or expired key) returns the same `401`.
  - `GET /api/v1/whoami`
  - `GET /api/v1/connections`

## 7. Service-to-service separation (Part 19)

| Credential type                                        | Where it lives                                         | Reachable from the browser?                  |
| ------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------- |
| User session                                           | Encrypted JWT cookie + `UserSession` row               | Cookie only, HTTP-only                       |
| API key                                                | Caller; SHA-256 in `api_keys`                          | Never stored client-side by us               |
| Provider OAuth / WordPress                             | AES-256-GCM in the DB (`ENCRYPTION_KEY`)               | No                                           |
| DB / Redis / provider client secrets / `METRICS_TOKEN` | Server environment only                                | No; only `NEXT_PUBLIC_*` reaches the browser |
| Agent tool authorization                               | Capability guard + governance, org from server context | n/a                                          |

## 8. MFA (Part 14): data model only, **not active**

`UserMfaFactor` (TOTP / WebAuthn / recovery codes, with sealed-secret columns
and a unique WebAuthn credential id) exists, **but nothing enrolls or checks
a factor.** Settings → Security says "Coming soon" and states plainly that
the account is protected by password or email link only.

The planned order is passkeys (WebAuthn, phishing-resistant) first, then
TOTP, which is manually entered and therefore _not_ phishing-resistant per
NIST SP 800-63B-4, then recovery codes. The implementation must use a
maintained WebAuthn library, not a hand-rolled one.

## 9. Account & organization deletion, export (Parts 29–30)

- **Organization deletion** (OWNER, typed name, sign-in within 15 min):
  - The org is hidden immediately.
  - Automations and scheduled syncs stop, because the scheduler skips
    deletion-scheduled orgs. Previously they kept running (Phase 2 finding).
  - Pending approvals are cancelled.
  - A paid plan is set to cancel at period end. If that fails, the owner
    gets a CRITICAL notification.
  - At purge, OAuth tokens and WordPress app passwords are revoked at the
    provider _before_ rows are deleted.
- **Account deletion.** Sign-in within 15 min required. Every session is
  revoked. Organizations where the user is the sole owner go with it, and
  the UI lists them before the user confirms.
- **Exports:**
  - The organization export (ADMIN+) excludes every credential and secret
    hash. It was extended to cover the Phase 1–2 tables.
  - The **personal export** contains only the person's own data.
