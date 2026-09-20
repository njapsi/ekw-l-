# audit-logging.md — the audit log and security events

Code: `packages/services/src/audit/` (product audit log) and
`packages/services/src/security/events.ts` (security events).
Decision record: ADR-0052.

## 1. Two streams, on purpose

| Stream          | Belongs to             | Answers                                                                                          | UI                                          |
| --------------- | ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `AuditLog`      | an organization        | "Who did what in this organization?"                                                             | Settings → Audit log (ADMIN+)               |
| `SecurityEvent` | a person (across orgs) | "What happened to my account's security?" Logins, failures, sessions, password, role escalations | Settings → Security (the person themselves) |

Both are written by functions that **never throw into the caller**: a failed
audit write is logged, and it never breaks the operation being audited.

## 2. Audit event

| Field                 | Column                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| Event ID              | `id`                                                                      |
| Organization          | `organizationId`                                                          |
| Actor                 | `actorId` + `actorType` (USER / AGENT / SYSTEM / PLATFORM_STAFF)          |
| Event type            | `action` (stored dotted name) → canonical type via `audit/catalog.ts`     |
| Resource              | `targetType` + `targetId`                                                 |
| Timestamp             | `createdAt`                                                               |
| Result                | `result`: SUCCESS / FAILURE / DENIED (new; old rows show SUCCESS)         |
| Request / correlation | `requestId` (new)                                                         |
| Agent run             | `agentRunId` (new)                                                        |
| IP / user agent       | `ip`, `userAgent` (where the caller supplies them)                        |
| Details               | `metadata`: secret-scrubbed at write time and again when read or exported |

**Canonical names.** Existing rows keep their stored names
(`integration.connected`). The catalog maps them to the enterprise names
from the brief (`INTEGRATION_CONNECTED`, `ROLE_CHANGED`, `SEO_CRAWL_STARTED`,
`AI_ACTION_APPROVED`, `API_KEY_CREATED`, …) and to a category. Unmapped
actions derive a name mechanically, so nothing is ever unlabelled.

**Events the brief lists that are not emitted.** Names exist in the catalog
for these, but nothing emits them yet:

- `AI_AGENT_STARTED` / `AI_AGENT_FAILED`: agent turns audit on completion
  only.
- `CONTENT_DELETED`: no content hard-delete exists; archive is used.

`AUTH_*` events are account-level. They are in `SecurityEvent` and in
`AuditLog` with no org, so they do not appear in an organization's log.

## 3. The audit UI

Settings → Audit log requires `audit.view` (ADMIN+):

- Free-text search across action, resource, actor name and email.
- Filters for event category, person, result and date range (UTC).
- Events grouped by day, newest first, 50 per page with cursor pagination.
- Each line reads "<actor> — <event label>" with resource, key metadata and
  request reference.
- VIEWER, MEMBER and MANAGER are refused, both by the page and by the
  service.

**CSV export** requires `audit.export` (ADMIN+):

- The same filters apply, and the export is capped at 10,000 rows (the
  `x-export-truncated` header is set when it is cut).
- It is rate-limited to 5 per 10 minutes per org.
- **Spreadsheet formula injection is neutralised.** Cells starting with
  `= + - @` or a tab are prefixed with `'`.

## 4. Security events

The types are listed in `SECURITY_EVENT_TYPES`:

- **Sign-in:** `AUTH_LOGIN` (WARNING when the network or device is new),
  `AUTH_LOGIN_FAILED`, `REPEATED_LOGIN_FAILURE` (CRITICAL, 5 in 15 min),
  `AUTH_LOGOUT`.
- **Sessions:** `SESSION_REVOKED`, `SESSIONS_REVOKED`.
- **Password:** `PASSWORD_CHANGED`, `PASSWORD_RESET_REQUESTED`.
- **Account:** `ACCOUNT_DEACTIVATED` / `ACCOUNT_REACTIVATED`,
  `ACCOUNT_DELETION_REQUESTED`.
- **Access:** `ROLE_ESCALATION`, `OWNER_TRANSFER`, `MEMBER_REMOVED`.
- **Keys and orgs:** `API_KEY_CREATED` / `API_KEY_REVOKED`,
  `ORG_DELETION_REQUESTED`.

**What is stored:**

- IPs are stored only as a network prefix (IPv4 /24, IPv6 /48).
- User agents are truncated to 300 characters.
- Metadata is secret-scrubbed.

**Not implemented:**

- There is no automated alerting on these events: no email or push on
  REPEATED_LOGIN_FAILURE. The events are the hook, and alert routing is
  follow-up work.
- `MFA_CHANGED` is reserved for when MFA exists.

## 5. What is never recorded

Passwords, application passwords, OAuth tokens, API-key secrets,
invitation tokens and session ids never appear in either stream.
`scrubSecrets` / `scrubContext` also redact anything token-shaped that
reaches metadata by accident.
