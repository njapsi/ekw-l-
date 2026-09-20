# tenant-isolation.md — how organizations are kept apart

Decision records: ADR-0035 (RLS deferred), ADR-0052 (Phase 2). Test
evidence: `security/tenant-isolation*.integration.test.ts` plus the unit
suites named below.

## 1. The model

The **organization** is the tenant. Every tenant-owned row carries an
`organizationId` foreign key with `ON DELETE CASCADE`, or hangs off a parent
row that does. Two exceptions are by design:

- **Person-owned data** is scoped by `userId`, not by org: `UserProfile`,
  `UserPreference`, `UserSession`, `SecurityEvent` and `UserMfaFactor`. A
  person spans organizations. Their account data is theirs, not any org's.
- **`AuditLog.organizationId` is nullable.** Account-level events
  (`auth.sign_in`, …) have no org. The org audit view shows only
  `organizationId = current org`.

| Area                                    | Tenant key                                                       |
| --------------------------------------- | ---------------------------------------------------------------- |
| Integrations (OAuth, WordPress)         | `OAuthConnection.organizationId`, `WordPressSite.organizationId` |
| YouTube / TikTok / Search Console data  | `organizationId` on every table                                  |
| Websites, crawls, pages, links, issues  | `organizationId` on every table                                  |
| Content, reports, tasks, notifications  | `organizationId`                                                 |
| AI conversations, memory, agent runs    | `organizationId` (conversations also by `userId`)                |
| Automations, runs, sync runs, approvals | `organizationId`                                                 |
| Billing, usage, entitlements            | `organizationId`                                                 |
| API keys, AI governance policy          | `organizationId`                                                 |
| Audit log                               | `organizationId` (nullable for account events)                   |
| Uploaded files                          | none exist (no object storage)                                   |

## 2. Enforcement layers

1. **The organization comes from the server.** The active org is a cookie
   the server verifies against a live membership row on every request
   (`requireActiveOrg`). IDs in request bodies are never trusted for scope.
   Neither is a role or permission sent by the client.
2. **Every query is scoped.** Service functions take `organizationId` from
   the caller's verified context and filter by it. A resource id from
   another org therefore resolves to "not found", not "forbidden": no
   existence oracle. Examples: `requireWordPressSite`, `requireConnection`,
   `getAutomation`, approvals, sync `owns()`, API-key revoke, invitation
   revoke.
3. **A CI lint.** `scripts/check-tenant-scope.mjs` fails the build on a
   tenant-table `findMany` / `updateMany` / `deleteMany` / `count` with no
   `organizationId` nearby. Deliberate platform sweeps carry a
   `// tenant-scope-ok: <reason>` note: the scheduler, token lifecycle,
   key-rotation re-seal, and deactivation of a user's own automations.
4. **Background jobs** re-derive authorization at execution time
   (`security/job-auth.ts`). The org must exist and not be in its deletion
   grace period. For user-initiated jobs, the actor must still be an active
   member whose role grants the job's permission. The payload carries ids,
   never roles.
5. **Agent tools** take `organizationId` from server context. Tool input
   cannot name an org. Every tool runs the capability guard first.
6. **API keys** carry their org. A request can never select another one.

## 3. Row Level Security (Part 21): evaluated, still deferred

**Decision: not enabled in this phase** (ADR-0035, re-confirmed in
ADR-0052). Reasons:

- **It would cut across the app's own sweeps.** The app connects as a single
  role. RLS needs a per-request `SET app.org_id` inside a transaction around
  every query, but the Prisma client here uses PgBouncer transaction pooling
  (Supabase), and the platform sweeps (schedulers, lifecycle, purge) are
  cross-tenant by design and would need a bypass role. Getting either wrong
  silently returns _no_ rows (outage) or _all_ rows (the failure RLS exists
  to prevent).
- **It can't be verified here.** "Do not enable RLS blindly" (Part 21). This
  environment can run migrations against a real Postgres only in an isolated
  schema on staging. A policy set spanning 70+ tables needs its own phase
  with dedicated tests, including background workers and joins.

What exists instead is the four application layers above, plus the
integration suites, which now actually run. See §4.

## 4. Test evidence

- **Phase 1 + 2 cross-tenant integration**
  (`tenant-isolation-phase2.integration.test.ts`, real PostgreSQL). In each
  case below, org A tries to act on org B:
  - resolve B's WordPress site;
  - request an approval against B's connection;
  - sync B's connection;
  - read B's audit log;
  - change roles in or remove members of B, directly or by passing B's user
    through A's org;
  - resolve an API key to B, or revoke A's key from B;
  - change B's governance policy;
  - run a background job as a member of B;
  - see B's WordPress through agent tools;
  - sign out B's sessions;
  - include B's data in a personal export.
- **Earlier suite** (`tenant-isolation.integration.test.ts`): reports,
  automations, conversations and Search Console properties.
- **Unit suites** on real query semantics (in-memory Prisma stand-in):
  `members.test.ts`, `apikeys.test.ts`, `sessions.test.ts`,
  `job-auth.test.ts`, `audit.test.ts`, `approvals.test.ts`,
  `integration-tools.test.ts`, `sync.test.ts`.

**Phase 2 finding: the integration suites had never run.** Every
`*.integration.test.ts` decided "is the database reachable?" inside
`beforeAll`. But `maybe()` (which picks `it` or `it.skip`) is evaluated when
tests are _defined_, before `beforeAll` runs, so every test was skipped even
in CI with a real Postgres. The probe now runs at module load (top-level
`await`). See `docs/PHASE-2-REPORT.md` for their first real run.
