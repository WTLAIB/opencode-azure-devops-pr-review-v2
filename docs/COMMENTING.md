# Commenting

`/pr-comment` turns a COMPLETE review into PR comments in two steps: a model
plans the comments, then the runtime posts the saved plan itself.

```text
/pr-comment                     preview the latest review of this conversation
/pr-comment <review-id>         preview a specific review
/pr-comment --publish           post the saved preview (plan first if none)
/pr-comment <review-id> --publish
```

Only reviews started in the same conversation are accepted; commands from one
of the review's own sessions (for example the verifier session that shows the
report) route to that conversation. Reviews are persisted, so this also works
after an OpenCode restart. A preview is refreshed on every `/pr-comment`
without `--publish`; `--publish` reuses an existing preview exactly.

## What is posted

- **One summary thread** (no file anchor): a 🤖 AI/model disclosure, optional
  review notes (the change's purpose or what changed), an index of every
  confirmed finding with 🔴 high / 🟡 medium / 🔵 low labels, and optional
  details: confirmed findings without an inline comment and retained
  improvement suggestions from the final report.
- **Inline threads** for confirmed high and medium findings, on the right side
  of a changed file at the reviewed head. Titles start with `🔴 high:` or
  `🟡 medium:`; bodies use **📝 Summary**, **🔎 Evidence** and
  **💡 Suggested fix**, followed by the model attribution and a hidden marker.

Low findings, findings that cannot be anchored, and issues that an existing
discussion on the PR already covers are skipped with a local reason; skips are
listed in the preview and receipt. Findings of the same review never cover each
other: the verifier already merged duplicates, so each confirmed high or medium
finding gets its own comment unless one of those reasons applies.

## Planning

Planning uses the review's risk model in pages of at most four findings, plus
segments of the final report for the summary details. Before planning, the
runtime reads every live thread once and fetches the HEAD source of each
finding's file. Each page then receives, inline: the verified findings,
`sourceExcerpts` (numbered HEAD lines around each finding, the whole file when it
has at most 400 lines), `existingDiscussions` (live threads with path, line,
author and the start of the first comment), the report segment and a summary of
earlier pages. Most pages finish in one model request without tools; the
planner reads more only for lines outside an excerpt or a full comment body.
A page that needs more reading returns `CONTINUE` with its finished items and a
continuation note (tools are withdrawn after 12 requests or about 48,000
characters of tool output); a new session continues the page. Repeating a
checkpoint without progress stops planning.

Every page is validated item by item:

| Problem | Handling |
| --- | --- |
| Wrong severity label or case, missing title prefix, `<!--` in the body | Normalized automatically. |
| Repo-relative path (`src/a.ts`) | Normalized to `/src/a.ts`. |
| End line that does not match the quoted anchor | Derived from the anchor. |
| Anchor that exists at other lines in observed HEAD text | Moved to the unique matching lines. |
| Body over 1,200 characters, unknown path, missing anchor, ambiguous anchor, missing findings | Sent back as a correction turn; after `workflow.repairAttempts` the item is skipped (bodies up to 4,000 characters are accepted on the last pass). |
| A skip whose reason names another finding of this review | Sent back as a correction turn; on the last pass the skip stays, marked as not covered by the other finding. |
| Planner returns INCOMPLETE | Finished comments are kept; the rest are skipped with the planner's reason. |

A low finding never becomes an inline comment, and the verified severity always
wins over the planner's label.

## Publication

Publication is deterministic runtime code using the Azure DevOps REST API
(api-version 7.1; see [Azure DevOps access](AZURE_DEVOPS.md)):

1. Read the PR and its iterations. Refuse if it is not active (INCOMPLETE) or if
   its source commit differs from the reviewed head (STALE).
2. List every thread (one request returns all of them) and collect AZPR markers
   from live comments.
3. For each saved item: skip it when its marker exists (`ALREADY_PRESENT`),
   otherwise create it with the exact saved content and right-side coordinates
   (`POSTED`); Azure DevOps attaches the iteration context itself. Each result
   is saved immediately. A failed item does not stop the others (`FAILED`); a
   create whose outcome is unknown (timeout, a lost connection, or a stop or
   restart during the request) is `UNCERTAIN`. Writes are never retried
   automatically.
4. List the threads again: created and uncertain items whose marker is present
   become `VERIFIED`; an uncertain item without a marker stays `UNCERTAIN`,
   because Azure DevOps may still finish the request.

Before each create, the attempt is recorded under `attempts/` in the state
directory, per PR and marker and shared by every review of that PR. If that
record cannot be written, nothing more is sent and the item is `FAILED`. A
later publication, from this review or another review of the same PR:

- never sends an item again whose create returned a thread ID, even while the
  thread list does not show it yet (it is reported as `POSTED` or
  `UNVERIFIED` with that thread);
- does not send an item with an unknown outcome until its marker appears or 15
  minutes have passed since that attempt (`UNCERTAIN` until then);
- may send an item again whose create failed with a definite error.

Azure DevOps offers no way to confirm that an unknown create will never land.
After 15 minutes AZPR assumes it did not; a create the service completed even
later would appear twice.

One OpenCode process publishes one PR at a time. The record is not a lock
between processes: two separate OpenCode processes (for example a
`--standalone` instance next to the background service) that publish the same
PR at the same moment can both create an item. The TUI and desktop app use
the background service, so this needs a deliberately separate process.

The receipt status is `POSTED` when every item is verified or already present,
`PARTIALLY_POSTED` when some failed, and `FAILED` when none succeeded. Run the
same command again to finish: existing items are skipped by their markers.

### Markers

Each item ends with `<!-- azpr-comment:<32 hex> -->`:

- Inline: hash of PR identity, file path, whitespace-normalized anchor text and
  an ordinal for several comments on identical lines. No review ID or model
  wording, so a later review of unchanged code finds the earlier comment and
  does not post a duplicate. A different issue on exactly the same lines is
  treated as already discussed; it stays in the report and the summary index.
- Summary: hash of PR identity, reviewed head and the inline markers, so a new
  review of the same commit with the same comments does not post a second
  summary.

Deleting a thread or comment removes its marker; the next publish posts it again.

## Retention

Plans and publication ledgers are saved with the review under
`${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2/`. The newest 20 reviews are
kept; an evicted review cannot be commented on (run a new review).
