# CONTENT-REPURPOSING.md

Status: **implemented (operator's "Phase 8")**. Code:
`packages/services/src/content`, `apps/web/app/(app)/app/content`, and the
`content-pipeline` worker queue.

Turn one piece of source content into a full set of platform-specific
deliverables. The engine **never publishes** — it produces editable, versioned
drafts and tracks their status through approval and scheduling; the user posts
the content themselves.

---

## 1. The pipeline

```
SOURCE CONTENT        RepurposeProject: a synced YouTube video, a video URL +
       │              pasted text, a pasted transcript, or manual content.
       ▼
CONTENT ANALYSIS      analyze.ts → one generateObject → ContentAnalysis
       │              (summary, content type, tone, topics).
       ▼
KEY IDEAS             the reusable substance; each key idea may carry a
       │              **verbatim** sourceQuote.
       ▼
CONTENT ANGLES        distinct framings, each citing the key-idea ids it uses.
       ▼
PLATFORM-SPECIFIC     generate.ts → one generateObject per type → a
CONTENT               ContentAsset + ContentAssetVersion (v1), status DRAFT.
       ▼
APPROVAL              approveAsset: DRAFT → APPROVED.
       ▼
PUBLISH / SCHEDULE    scheduleAsset (APPROVED → SCHEDULED, future date only);
                      markAssetPublished (→ PUBLISHED) is a **status marker** —
                      the engine performs no external action.
```

`RepurposeProject.status`: `DRAFT → ANALYZING → ANALYZED → GENERATING → READY`
(`ARCHIVED` on delete).

---

## 2. The 13 deliverable types

| Type                    | Schema                                                    | Platform   | Set? |
| ----------------------- | --------------------------------------------------------- | ---------- | ---- |
| `YT_TITLE_ALTERNATIVES` | `{ options[] }`                                           | youtube    | no   |
| `YT_DESCRIPTION`        | `{ body }`                                                | youtube    | no   |
| `YT_CHAPTERS`           | `{ chapters[] }`                                          | youtube    | no   |
| `SHORTS_IDEA`           | `{ title, hook, beats[], onScreenText[] }`                | youtube    | yes  |
| `TIKTOK_IDEA`           | `{ title, concept, hook, beats[] }`                       | tiktok     | yes  |
| `TIKTOK_CAPTION`        | `{ caption, hashtags[] }`                                 | tiktok     | yes  |
| `HOOK`                  | `{ options[], format }`                                   | generic    | no   |
| `SCRIPT`                | `{ format, hook, script, callToAction? }`                 | generic    | yes  |
| `SOCIAL_POST`           | `{ platform, body, hashtags[] }`                          | social     | yes  |
| `BLOG_IDEA`             | `{ workingTitle, angle, targetReader, keyPoints[] }`      | blog       | yes  |
| `SEO_ARTICLE_OUTLINE`   | `{ workingTitle, targetQuery, searchIntent, sections[] }` | blog       | yes  |
| `FAQ`                   | `{ items[] }`                                             | blog       | no   |
| `NEWSLETTER_IDEA`       | `{ subjectLines[], angle, outline[] }`                    | newsletter | yes  |

"Set" types generate up to `MULTI_COUNT` (3) distinct assets, one per content
angle. Each schema output is turned into an editable text `body` (what the user
edits) plus a `structured` JSON (for a rich view) by `render.ts`.

---

## 3. Editing + versioning

- Every `ContentAsset` has a **linear history** of immutable
  `ContentAssetVersion` rows; `currentVersionId` points at the live one.
  `editedById = null` marks an AI-generated version, a set id marks a human edit.
- **Edit** (`editAsset`) appends a new version and — because an edit invalidates
  a prior approval — resets the asset to `DRAFT` (clearing approval / schedule /
  publish fields).
- **Regenerate** (`regenerateAsset`) re-runs the model for that one type
  (optionally with user instructions) and appends a version.
- **Revert** (`revertAsset`) appends a _copy_ of an earlier version (history is
  never rewritten) and resets to `DRAFT`.

---

## 4. Status tracking + audit

`ContentAssetStatus`: `DRAFT · APPROVED · SCHEDULED · PUBLISHED · FAILED`.

| Transition                     | Function             | Guard                                          |
| ------------------------------ | -------------------- | ---------------------------------------------- |
| DRAFT → APPROVED               | `approveAsset`       | only from DRAFT                                |
| APPROVED → SCHEDULED           | `scheduleAsset`      | must be APPROVED/SCHEDULED; time in the future |
| SCHEDULED → APPROVED           | `unscheduleAsset`    | —                                              |
| APPROVED/SCHEDULED → PUBLISHED | `markAssetPublished` | **status marker only — no external call**      |
| any → FAILED                   | `markAssetFailed`    | records `failureReason`                        |
| FAILED/PUBLISHED → DRAFT       | `resetAssetToDraft`  | —                                              |
| (edit / revert / regenerate)   | —                    | → DRAFT                                        |

Every project and asset action writes an `AuditLog` row (`content.project.*`,
`content.assets.generated`, `content.asset.{edited,approved,scheduled,
unscheduled,published_marked,failed,reset_to_draft,reverted,regenerated,due}`).

The `content-pipeline` worker's `sweep.scheduled` job finds `SCHEDULED` assets
whose time has passed and writes a `content.asset.due` audit row so the user is
prompted — **it does not publish** (master instruction: "Do not automatically
publish").

---

## 5. Grounding (creative content)

Generation is inherently creative, so grounding is lighter than the analytics
agents:

- `sourceQuote` fields in the analysis must be verbatim spans of the source;
  a non-matching quote is **dropped** (not a failure).
- Guarantee phrasing ("guarantees you will go viral", "guaranteed views/revenue/
  ranking") in the analysis or a generated item → fall back to a deterministic
  template for that piece.
- The model may otherwise paraphrase, write hooks, and propose angles freely.
- Every generated item cites the `keyIdeaIds` it builds on.

Without an AI provider every stage has a deterministic path (mechanical summary +
templated deliverables).

---

## 6. Documented limitations (do not fake)

- **No transcript scraping or transcription.** A video URL is metadata only —
  the user must paste the transcript / description for a good analysis. This is
  a scope + policy choice (ADR-0023).
- **No auto-publish.** `markAssetPublished` records that _you_ published the
  content; the engine never calls a platform API. For TikTok, the gated
  Content Posting flow lives at `/app/tiktok/publishing`.
- **Scheduling is intent + a date.** There is no scheduler wired to the sweep
  job in this build; a due asset is surfaced, not posted.
- Large source bodies are stored inline (`@db.Text`, capped at 200k chars);
  object-storage offload is deferred.
