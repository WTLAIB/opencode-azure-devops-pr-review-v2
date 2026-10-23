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

## Automatic comments after a review

`afterReview` (per mode: `none`, the default, `preview` or `publish`) or a
flag right after the PR URL of a review command (`--preview`, `--publish`,
`--no-comment`, which wins for that run) starts the same planning and
publication after a review:

1. Only a COMPLETE review hands on; STALE, PARTIAL, INCOMPLETE, CANCELLED and
   TIMED_OUT reviews never do, and nothing starts while the plugin unloads. A
   `/pr-stop`, timeout or unload that arrives while a finished review's report
   is still being delivered keeps the review COMPLETE (it can still be
   commented on by hand) but starts no step; its receipt says `Automatic
   comments are off for this review (stopped: …)`.
   The review's `STARTED` notice and its receipt's PR comments section say
   which step follows (and why: the setting or the flag).
2. After the review's receipt, a review without findings to comment on gets
   one notice, `Automatic preview skipped` or `Automatic publication
   skipped`: nothing is planned or posted and no model runs. A manual
   `/pr-comment` still previews a summary-only comment.
3. Otherwise a separate comment run starts with its own run ID, `STARTED`
   notice (`automatic preview after review <id> completed`) and receipt
   (`Started automatically after review <id> completed`). `/pr-stop` stops it
   like any run. When another AZPR command holds the conversation or the PR,
   the step is skipped with a notice that names the `/pr-comment` command to
   run when that command has finished.
4. Automatic publication posts each item that no safeguard holds back. An
   item, the summary or an inline comment, waits in the saved preview for a
   person when its text contains an Azure DevOps mention (`@<…>`), an image
   (`![`), HTML that embeds content or runs a script (tags such as `img`,
   `iframe`, `object`, `embed`, `video`, `audio`, `svg`, `script`, `style`,
   `link`, `meta` or `base`; attributes such as `on…=`, `src=`, `srcset=`,
   `style=`, `background=` or `poster=`, read as a browser reads a tag: a
   quoted value may hold `<` and `>`, a slash separates attributes, a tag
   name runs to a space, slash or `>`, and every `<` may start a tag, since a
   renderer may show an earlier one as text), HTML that hides text (a comment
   other than AZPR's marker, a declaration `<!…>`, a processing instruction
   `<?…>` or `</` without a tag name, which a browser turns into a comment),
   or a `javascript:`, `vbscript:`, `data:` or `file://` link. Script
   links and mentions also count when written with backslash escapes or
   character references, such as `javascript\:` or `java&#115;cript:`, which
   CommonMark decodes; a numeric reference also with any number of digits or
   without a semicolon, as a browser decodes it in raw HTML. A script link
   also counts with a tab or line break inside, written or as a reference
   (`java&#9;script:`, `java&Tab;script:`), since a browser drops those from
   a URL. These checks are literal and prefer a false alarm.
   Ordinary web and mail links (`https://`, protocol-relative destinations,
   `mailto:`, email autolinks, reference definitions) and markup that neither
   loads content nor runs a script, such as `<input name="id">` in an
   example, generics such as `List<String>` or decorators such as
   `@property`, are posted.

   Literal code renders as text, so the checks except mentions (which Azure
   DevOps may resolve anywhere) skip the content of a fenced code block and
   of a code span. They skip it only where the reading is certain: a fence
   that starts in column 0 outside a table, before any line that could start
   an HTML block and before any fence that is indented or inside a quote or
   list; and a code span whose backticks pair on one line, with no pipe
   inside and no link destination, HTML tag with quotes, math or bare address
   before it in the paragraph that could take a backtick (a renderer that
   links `https://…` may take a backslash or backtick along), in a paragraph
   that ends before such a line (the line may continue the paragraph, and
   markdown-it then reads earlier backticks differently). Otherwise the
   text is checked as written, so `![` in such code still holds back. Fuzzing
   against commonmark.js and markdown-it found nothing skipped that renders
   as markup (see [validation](VALIDATION.md)).

   The receipt says `Automatic
   publication held back N item(s) for a person: …` with each item and why;
   when every item is held, nothing is posted and the status is `PREVIEW`
   (`held back every item`). A quick review's findings are posted with its
   disclosure (`quick review, not independently verified`; the summary also
   names incomplete coverage), also a high-severity finding: its verification
   hint is advisory. When the plan has no inline comment and the planner
   skipped every finding as `existing-thread` with a thread the runtime found
   live before planning, typically AZPR's own comment from an earlier run,
   there is nothing new to post: status `NOTHING_TO_POST`, `Automatic
   publication found nothing new to post: …`, and the plan is saved (the
   summary's marker follows the inline comments, so posting would add a
   second summary for the same findings each time an unchanged PR is reviewed
   again). `/pr-comment <id> --publish`, like every command you type, applies
   none of these safeguards: it posts every item of the saved preview, and
   items already posted are `ALREADY_PRESENT`.

Publication then follows the usual rules below (PR active, unchanged head,
markers, read-back). Automatic publication posts as the PAT owner, like
`/pr-comment --publish`.

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
listed in the preview and receipt. Each planner skip names one cause
(`low-severity`, `no-inline-location`, `existing-thread` with its `threadId`,
`cannot-anchor` or `too-long`), and the runtime checks what the cause states:
the severity, whether the location can carry an inline comment, that the
thread is live, and that the finding's lines were not in the page's source
excerpts. Whether a finding deserves a comment stays the planner's call. Findings of the same review never cover each
other: the verifier already merged duplicates, so each confirmed high or medium
finding gets its own comment unless one of those reasons applies.

### Quick reviews

A `/pr-quick` review is commented on with the same planner, preview,
publication and markers, so its comments have the same layout. Its REPORTED
findings take the place of confirmed ones; they were not independently
verified, which the disclosure line says in both the summary and every inline
comment, for example `AI-generated review; not human review or approval.
Review method: quick review, not independently verified. Models: …` (in zh-TW
`AI 審查，非人工審查或核准。審查方式：快速審查，未經獨立驗證。模型：…`). When the
review's coverage was incomplete, the summary's disclosure line adds
`coverage incomplete (…)` with the number of unreviewed changed files when it
is known and fixed short reasons otherwise; reviewer text never goes there.

Inline comments of a quick review are stricter: the finding's location must be
on a changed file at HEAD (a BASE location or unchanged code stays in the
summary index), and the planner's anchor must be found in the HEAD source the
runtime read. The quick reviewer's model plans the comments.

Without a verifier, two shards of a quick review can report one defect, for
example when a shard's tests lead its reviewer into another shard's changed
file. The runtime offers the planner such findings as `mergeCandidates`:
inline-eligible high or medium findings of different review sessions (recorded
by the runtime, not derived from IDs) with the same severity on overlapping
lines of one HEAD file, kept on one planning page (a group that does not fit a
page is not offered). The planner may then write one comment with `findingIds`
and a `mergeReason`, only when the findings state the same root cause with
compatible triggers and the same correction, and otherwise comments on each.
The runtime accepts a combination only if every member is in one listed group,
the members come from different sessions, share one severity and at least one
line, and the anchor lies within the shared lines; otherwise it asks for a
correction, and after the last one keeps the valid single comments and skips
the rest with a reason (they stay in the summary index; it never splits one
text into several). The summary index gives an accepted combination one row
with all its IDs, and the counts follow the rows; the review keeps every
finding. The runtime cannot tell a well-formed but wrong combination of two
different defects, so the prompt says to keep findings apart when unsure. No
dedicated duplicate stage runs, although planning pages, corrections or
continuations can still add sessions and model requests.

## Planning

Planning uses the review's risk model (the quick reviewer's model for a quick review) in pages of at most four findings, plus
segments of the final report for the summary details. Before planning, the
runtime reads every live thread once and fetches the HEAD source of each
finding's file. Each page then receives, inline: the verified findings,
`sourceExcerpts` (numbered HEAD lines around each finding, the whole file when it
has at most 400 lines), `existingDiscussions` (live threads with path, line,
author and the start of the first comment) and the report segment. The
changed-file list and the review's dispositions are inline
when they are small; on a large PR a page gets only those of its own findings
(plus what merged into them) and references to the complete lists, which the
runtime still uses for its own checks. Most pages finish in one model request without tools; the
planner reads more only for lines outside an excerpt or a full comment body.
A page that needs more reading returns `CONTINUE` with its finished items and a
continuation note (tools are withdrawn after 12 requests or about 48,000
characters of tool output); a new session continues the page. A page gets at
most three continuation sessions. When a checkpoint repeats an earlier one
without progress (same open findings, reads and notes), or the fourth session
still returns `CONTINUE`, the page ends there: its finished comments are kept,
its open findings are skipped with that reason and stay in the summary index,
and the other pages and publication go on. A PROGRESS notice names the page.

Two pages are planned at a time (one at a time when `workflow.parallelSessions`
is 1); a page's continuation sessions follow each other in its own lane, and the
PROGRESS notices and session titles name the page. No page depends on another
page's result:

- Only the first page may write the summary's review note. A note from any
  other page is dropped without a correction turn; when the first page writes
  none, the summary is posted without review notes.
- A page's anchor checks see the HEAD source the runtime fetched for its own
  and earlier pages' findings, exactly as when pages ran one at a time.
- A checkpoint counts only the page's own work: its details and the tool
  results the runtime recorded for its sessions.
- Pages are joined in page order, so the comments, their markers and the
  ordinals of comments on identical lines do not depend on which page finishes
  first.

When a page fails, no further page or continuation session starts, the stages
already running finish (including their correction turns and retries), and the
command reports the failure of the lowest failed page (INCOMPLETE) as before;
no preview is kept. `/pr-stop` cancels every running page.

Every page is validated item by item:

| Problem | Handling |
| --- | --- |
| Wrong severity label or case, missing title prefix, `<!--` in the body | Normalized automatically. |
| Repo-relative path (`src/a.ts`) | Normalized to `/src/a.ts`. |
| End line that does not match the quoted anchor | Derived from the anchor. |
| Anchor that exists at other lines in observed HEAD text | Moved to the unique matching lines. |
| Body over 1,200 characters, unknown path, missing anchor, ambiguous anchor, missing findings | Sent back as a correction turn; after `workflow.repairAttempts` the item is skipped (bodies up to 4,000 characters are accepted on the last pass). |
| A skip whose reason names another finding of this review | Sent back as a correction turn; on the last pass the skip stays, marked as not covered by the other finding. |
| A skip without a cause, or whose cause does not hold (a medium finding called low, an inline location called missing, a thread that is not live, `cannot-anchor` while the page's excerpts show the finding's lines) | Sent back as a correction turn; on the last pass the skip stays with what the runtime found. |
| Planner returns INCOMPLETE | Finished comments are kept; the rest are skipped with the planner's reason. |
| A summary note from a page other than the first | Dropped (`drop-unallowed-summary`), without a correction turn; the page's details are kept. |

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
   because Azure DevOps may still finish the request. A created item whose
   recorded thread is listed with its comment deleted is `DELETED`; one whose
   marker is simply not found is `UNVERIFIED`.

Before each create, the attempt is recorded under `attempts/` in the state
directory, per PR and marker and shared by every review of that PR; an item
found on the PR is recorded with its thread as well. If that record cannot be
written before a create, nothing more is sent and the item is `FAILED`. A
later publication, from this review or another review of the same PR:

- never sends an item again whose create returned a thread ID, even while the
  thread list does not show it yet (it is reported as `POSTED` or
  `UNVERIFIED` with that thread) and even after someone deleted the comment
  (`DELETED`);
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

The receipt status is `POSTED` when every item is verified, already present or
deleted on the PR, `PARTIALLY_POSTED` when some failed, and `FAILED` when none
succeeded. Run the same command again to finish: existing items are skipped by
their markers.

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

A combined comment is one inline item with one marker; the publication
ledger records all its finding IDs (`findingIds`), and ledgers and plans saved
before that field existed are read as before.

Only an identical complete marker counts as already present. Neither the
review mode, the finding IDs nor the disclosure text is part of a marker, so a
`/pr-review` published after a `/pr-quick` of the same head finds the quick
comments: an inline comment on the same anchor with the same ordinal is
`ALREADY_PRESENT` (it keeps its quick disclosure; AZPR never edits it), a
second issue on that anchor has ordinal 1 and is posted, and the summary is
posted again only when the set of inline markers differs. A later review
therefore does not guarantee a summary that says it was verified.

A comment someone deletes on the PR stays deleted. Azure DevOps keeps listing
its thread, flagged deleted and without the comment's text, so the marker is
gone; AZPR recognizes the thread by the ID it recorded (from its create, or
from an earlier publication that found the comment) and reports the item as
`DELETED` instead of posting it again, also for a later review whose item has
the same marker. The record, and with it this protection, lasts 90 days from
when AZPR created or first found the comment; a comment deleted before this
machine's AZPR recorded it can be posted again.

## Retention

Plans and publication ledgers are saved with the review under
`${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2/`. The newest 20 reviews are
kept; an evicted review cannot be commented on (run a new review).
