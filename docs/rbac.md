# rbac.md — roles and permissions

Source of truth: `packages/services/src/rbac/permissions.ts`. Decision record:
ADR-0052.

## 1. How a request is authorized

```
USER → SESSION → ORGANIZATION MEMBERSHIP → ROLE → PERMISSION → RESOURCE → ACTION
```

1. **User.** `requireUser()` checks four things: the JWT is valid; the user
   exists and is not deleted or deactivated; `sessionVersion` matches; and
   the session's `UserSession` row is neither revoked nor past its absolute
   lifetime.
2. **Membership.** `requireActiveOrg()` loads the membership row for the
   active org from the database, on every request. The role comes from that
   row, never from the JWT or the request body.
3. **Permission.** `authorize(actor, permission)` checks the role against
   `ROLE_PERMISSIONS`. A suspended membership is denied everything.
4. **Resource.** Every service query is scoped by `organizationId`
   (`docs/tenant-isolation.md`). A resource from another org resolves to
   "not found".
5. **Action.** For external actions, the capability model and the approval
   queue apply on top (`docs/ai-governance.md`, `docs/INTEGRATIONS.md` §11).

Hiding a button in the UI is never the check. Every Server Action, route
handler, service function and worker job re-checks on the server.

## 2. Roles

| Role    | In one line                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| OWNER   | Everything, including billing, security, ownership transfer and deletion.                                                                |
| ADMIN   | Runs the organization: members, integrations, AI configuration, approvals, API keys, audit. Views billing only.                          |
| MANAGER | Operational lead: agents, content, SEO, automations (incl. delete), report export. No members, billing, security or publishing approval. |
| MEMBER  | Uses the agent, creates content and drafts, runs analyses, creates and updates automations.                                              |
| VIEWER  | Read-only.                                                                                                                               |

The roles are strictly cumulative: each role holds everything the role below
it holds. A test enforces this.

## 3. Permission matrix

| Permission                                       | Owner | Admin | Manager | Member | Viewer |
| ------------------------------------------------ | :---: | :---: | :-----: | :----: | :----: |
| organization.view, member.view, \*.view (read)   |   ✓   |   ✓   |    ✓    |   ✓    |   ✓    |
| agent.run, content.create/edit, seo.analyze      |   ✓   |   ✓   |    ✓    |   ✓    |        |
| report.create, monetization.manage               |   ✓   |   ✓   |    ✓    |   ✓    |        |
| automation.create, automation.update             |   ✓   |   ✓   |    ✓    |   ✓    |        |
| automation.delete, seo.modify, report.export     |   ✓   |   ✓   |    ✓    |        |        |
| youtube.manage, tiktok.manage                    |   ✓   |   ✓   |    ✓    |        |        |
| recommendation.approve                           |   ✓   |   ✓   |    ✓    |        |        |
| organization.update, settings.manage             |   ✓   |   ✓   |         |        |        |
| member.invite, member.remove, member.update_role |   ✓   |   ✓   |         |        |        |
| integration.connect/disconnect/manage            |   ✓   |   ✓   |         |        |        |
| content.publish (decide approvals)               |   ✓   |   ✓   |         |        |        |
| agent.configure (AI governance), agent.approve   |   ✓   |   ✓   |         |        |        |
| audit.view, audit.export                         |   ✓   |   ✓   |         |        |        |
| api_key.view/create/revoke                       |   ✓   |   ✓   |         |        |        |
| report.share, billing.view                       |   ✓   |   ✓   |         |        |        |
| billing.manage, security.manage                  |   ✓   |       |         |        |        |
| organization.delete, ownership.transfer          |   ✓   |       |         |        |        |

The full list is `PERMISSIONS` in `permissions.ts`. The organization settings
page renders the matrix from the same table.

## 4. Backward compatibility

The coarse pre-Phase-2 action names (`integration:manage`, `crawl:run`, …)
are still accepted. They are aliases resolved through
`LEGACY_ACTION_PERMISSION`, so about 70 existing call sites did not change.
The test `permissions.test.ts › backward compatibility` pins every existing
role (VIEWER / MEMBER / ADMIN / OWNER) to exactly its old action set:
nobody gained or lost access by the upgrade. MANAGER is new. Nobody holds it
until someone is assigned it.

## 5. Escalation rules (`checkRoleChange`)

- Changing roles needs `member.update_role` (ADMIN+).
- Granting or removing **OWNER** is OWNER-only.
- Nobody assigns a role above their own, or changes someone who outranks
  them.
- Nobody changes their own role, except an OWNER stepping down.
- The last OWNER cannot be demoted, removed, or leave.
- **Ownership transfer** is OWNER-only and requires a sign-in within the
  last 15 minutes. The target becomes OWNER and the former owner becomes
  ADMIN, in one transaction.
- **Invitations:**
  - An inviter can grant only roles up to their own. OWNER is never
    invitable.
  - At acceptance, the inviter must still hold that right. A demoted or
    removed inviter's links stop working.
- **Removal:** `member.remove`. Only an OWNER removes an OWNER.

Denied role changes are written to the audit log with `result = DENIED`.
Raising someone to ADMIN or OWNER records a `ROLE_ESCALATION` /
`OWNER_TRANSFER` security event for that person.

## 6. Adding a permission

Add it to `PERMISSIONS` and to the right role lists in `permissions.ts`, then
check it at the server-side choke point (`requirePermission` in a Server
Action, or `authorize` in a service). Never compare role names at a call
site.
