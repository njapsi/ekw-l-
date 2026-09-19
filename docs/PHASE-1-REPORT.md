# Phase 1 — Real Integrations, OAuth, Connection Center & API Reliability: completion report

Decision records: ADR-0050, ADR-0051. Reference docs: `docs/INTEGRATIONS.md`,
`docs/WORDPRESS-INTEGRATION.md`.

## 1. What was built

| Part  | Deliverable                                                                                    | Where                                           |
| ----- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1     | Unified contract: 8 states, 5 capability levels, descriptors, diagnostics                      | `integrations/contract.ts`                      |
| 2–5   | YouTube / TikTok / Search Console / Website under the contract; the existing clients unchanged | `integrations/center.ts`                        |
| 6–7   | WordPress connector (auth, capabilities, sync, draft, approval-gated update/publish)           | `wordpress/*`                                   |
| 8     | Connection Center UI                                                                           | `/app/integrations`, `/wordpress`, `/approvals` |
| 9     | Diagnostics + real connection test                                                             | `contract.ts` `diagnoseConnection`, `probe.ts`  |
| 10    | API resilience: retry, `Retry-After`, breaker, timeout                                         | `integrations/resilience.ts`                    |
| 11    | Sync framework: ledger, single-flight, schedule, backoff                                       | `sync/*`, worker `integrations` queue           |
| 12    | Token lifecycle: refresh-ahead, reauth notices, WordPress re-validation, key rotation          | `integrations/lifecycle.ts`, `crypto/tokens.ts` |
| 13    | AI tool exposure behind a capability guard                                                     | `agent/integration-tools.ts`, `org-context`     |
| 14    | Permission model _enforced_ through the approval queue                                         | `approvals/`                                    |
| 15–18 | Tests, security review, docs                                                                   | below                                           |

## 2. Database

- Migration `20260921120000_integration_platform`, additive only:
  `wordpress_sites`, `wordpress_content`, `integration_sync_runs`,
  `integration_action_requests`, plus 4 enums. There are no changes to
  existing tables and no `DROP`.
- The hand-written SQL was diffed statement-by-statement against
  `prisma migrate diff` output: identical.

## 3. Security review of the new surface

- **SSRF.** The WordPress URL is the only new user-supplied fetch target. It
  goes through resolve → validate → pin, redirects are refused, only HTTPS is
  allowed, and no user-info is accepted in the URL. Tests prove a private
  address is never contacted.
- **Credentials.** Application passwords are AES-256-GCM-sealed, never
  returned to the browser, and excluded from every read model (a test asserts
  no ciphertext in tool output). They are scrubbed and revoked upstream on
  disconnect.
- **External writes.** Update and publish run only through
  `decideActionRequest` (ADMIN+ `publish:external`), with permissions
  re-checked at execution time and an exactly-once claim.
- **Agents.** Agents can only _propose_ (PENDING). No agent tool writes to an
  external system.
- **Tenant isolation.** Every new tenant query is scoped by `organizationId`.
  The two platform sweeps (sync, lifecycle) are cross-tenant by design and
  re-scope every write to the row's own org. `check-tenant-scope.mjs` passes.
- **Hostile site content.** Untrusted content cannot crash a sync (the
  out-of-range entity case is tested).

## 4. Tests

`packages/services`: **843 tests pass** (686 before Phase 1).

| Area                                             | Tests |
| ------------------------------------------------ | ----- |
| Contract (states, capabilities, diagnostics)     | 35    |
| Center                                           | 17    |
| Probe                                            | 7     |
| Resilience                                       | 17    |
| WordPress (real client against a fake WP server) | 30    |
| Approvals                                        | 16    |
| Sync                                             | 14    |
| Lifecycle                                        | 7     |
| Agent tools                                      | 11    |
| Key rotation                                     | 3     |

Worker tests pass. Lint and typecheck pass on 14/14 packages. The web
production build passes.

## 5. Not verified / remaining risks

- **No live verification yet.** Nothing was clicked through against a real
  database or a real WordPress site from this machine (no local
  Postgres/Docker). The migration must be applied to staging and the flow
  verified there.
- **Scheduled syncs spend provider quota daily.** Watch the YouTube quota
  after deploying.
- **Breakers are per process.** Web and worker each track their own
  breaker.
- **TikTok publishing** still uses its own approval flow, not the unified
  queue.
- **WordPress content scope.** Categories, tags, media, custom post types and
  SEO-plugin metadata are out of scope.
