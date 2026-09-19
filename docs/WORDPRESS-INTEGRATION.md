# WORDPRESS-INTEGRATION.md

Growth Agent connects to a self-hosted WordPress site (WordPress 5.6+) through
the **core REST API** (`wp/v2`) using an **Application Password**. This is a
WordPress core feature, so no plugin is needed. Code: `packages/services/src/wordpress/`.
Decision record: ADR-0051.

## 1. Connecting

1. In WordPress: **Users → Profile → Application Passwords**. Enter a name
   (e.g. "Growth Agent") and click **Add**. Copy the 24-character password.
2. In Growth Agent: **Connections → WordPress → Connect**. Enter the site
   address, the WordPress username and the application password.

Before anything is stored, Growth Agent:

- requires `https://` (Basic auth over plain HTTP exposes the password);
- fetches the public REST index and requires the `wp/v2` namespace;
- calls `users/me?context=edit` with the credential. A 401 stores nothing
  and says so.

The password is sealed with AES-256-GCM (`ENCRYPTION_KEY`) and never sent
back to the browser. An operator needs only `ENCRYPTION_KEY`. There is no app
registration and no client secret.

## 2. Capabilities

WordPress capabilities are **detected**, not assumed from the role name. They
are the "scopes" that `resolveCapabilities` checks.

| Growth Agent capability  | Level   | WordPress capability needed             | Approval |
| ------------------------ | ------- | --------------------------------------- | -------- |
| `wordpress.get_site`     | READ    | `read`                                  | no       |
| `wordpress.get_posts`    | READ    | `read` (drafts need `edit_posts`)       | no       |
| `wordpress.get_pages`    | READ    | `read`                                  | no       |
| `wordpress.create_draft` | DRAFT   | `edit_posts` / `edit_pages`             | no       |
| `wordpress.update_post`  | WRITE   | `edit_posts` (+ `edit_published_posts`) | **yes**  |
| `wordpress.publish`      | PUBLISH | `publish_posts` / `publish_pages`       | **yes**  |

- A draft is never public and can be undone, so it runs directly. The client
  asks for `status: "draft"` and fails loudly if WordPress returns anything
  else.
- Update and publish run **only** through the approval queue
  (`docs/INTEGRATIONS.md` §11). No Server Action or agent tool calls them
  directly.
- Publishing is idempotent: an already-published item returns success. Only
  `draft` or `pending` items can be published. Private or trashed items are
  refused.
- **No delete capability exists.** Growth Agent cannot delete WordPress
  content.

## 3. Security

- **SSRF.** Every request goes through the crawler's `assertSafeUrl`. Private,
  link-local and metadata ranges are blocked, and mixed public/private DNS
  answers are refused. The socket is pinned to the validated IP (undici
  `connect.lookup`), so DNS rebinding cannot redirect it. Hard rule 7 is
  satisfied: the user-supplied URL is fetched only after these checks, and
  only structured, validated JSON is returned.
- **Redirects are never followed.** Following one would forward the Basic-auth
  header. The user is told which address to use instead.
- **Retries.** Only GET is retried. A POST is never retried, because an
  ambiguous failure could create a second draft.
- **Response handling.** Responses are capped at 5 MB, and a body that is not
  JSON is an explicit error. This usually means a security plugin or cache is
  intercepting `/wp-json`.
- **Permalinks.** Requests use `?rest_route=`, so they work regardless of the
  site's permalink setting.
- **Circuit breaker.** One breaker per host, so one broken site cannot block
  others.
- **Untrusted content.** Site content is untrusted. Titles and excerpts are
  decoded and stripped to plain text, and an out-of-range character entity
  cannot crash a sync. Agent callers must `wrapUntrusted` it.

## 4. Sync

`syncWordPressContent` mirrors posts and pages (100 per page, at most 10 pages
per type, newest-modified first) into `WordPressContent`:

- Drafts are read only when the user has `edit_posts`.
- Deletions are applied only after a _complete_ pagination. A truncated sync
  (more than 1,000 items) never removes rows. The sync result reports that it
  was truncated.
- The schedule runs every 12 h (`docs/INTEGRATIONS.md` §9).

## 5. Lifecycle

- Application passwords do not expire and cannot be refreshed. A 401 (revoked
  in wp-admin) marks the site `EXPIRED`, surfaced as **REAUTH_REQUIRED**. The
  worker re-validates each site daily and notifies whoever connected it.
- **Disconnect** first tries to revoke the application password on the site
  (`application-passwords/introspect` then `DELETE`, WordPress 5.9+). It then
  scrubs the stored credential and deletes the cached content. If upstream
  revocation fails, the UI says so and tells the user to delete it in
  wp-admin.
- A site counts toward the plan's `CONNECTED_ACCOUNTS` limit. Reconnecting the
  same site does not use a new slot.

## 6. Known limitations

- **Content scope.** Only core `posts` and `pages` are supported. Custom post
  types, categories, tags, media, SEO-plugin metadata (Yoast / Rank Math) and
  comments are not supported.
- **Sites without application passwords.** Sites that disable Application
  Passwords (some hosts and security plugins do) cannot be connected. The
  error says so.
- **WordPress.com.** Hosted WordPress.com sites use their own OAuth API and
  are not supported. Jetpack-connected self-hosted sites work normally.
- **One site per org.** One site per organization is shown in the UI. The
  data model supports several.
