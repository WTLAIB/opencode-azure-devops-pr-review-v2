# Commenting

`/pr-comment` turns a COMPLETE review into PR comments in two steps: a model
plans the comments, then the runtime posts the saved plan itself.

```text
/pr-comment                     preview the current review of this conversation
/pr-comment --publish           post the saved preview (plan first if none)
/pr-comment --list              the reviews saved for this conversation, with their IDs
/pr-comment <review-id>         preview a specific review
/pr-comment <review-id> --publish
/pr-comment --help              every option, with examples
```

No command needs a review ID. Without one it acts on the conversation's
**current review**: the one that was completed or used by a `/pr-comment`
command there last, which is the one you looked at last. Naming a review by
its ID makes it the current one, also with `--show` or with adjustments that
change nothing, and a review or a comment run makes its review the current
one when its receipt arrives, the automatic preview after a review included.
The choice is saved with the review when it is made, also when commands
overlap, so it holds after a restart; if it cannot be saved, the answer says so. In a review's own session (the one
that shows the report, or any of its sessions while debug keeps them all) a
command without an ID means that review. So that a command without an ID can be checked at a glance, the
`STARTED` notice and the receipt of every comment run name the review and its
PR (`Acted on review 1a2b3c4d (/pr-review) of PR #123 in
project/repository`), and a preview ends with the commands for the next step,
written with that review's finding IDs. `--list` and `--help` use no model
and make no Azure DevOps request.

In OpenCode's terminal UI the same next steps are one row at the foot of the
[terminal panel](../README.md#terminal-panel): **Post N comments…**, **Adjust
findings…** and **Reset adjustments**, and **Preview comments** after a
review that no preview follows by itself. One of them is clicked, or picked
with its key while the panel has the keyboard, and sends the command described
here for the review the panel shows, with that review's ID, so the rules below
hold for it unchanged. Posting asks once more, with "No, post nothing" first;
adjusting lists the findings, lets you choose for each whether it is left out
or which level it is published at, and applies all of it with one command.
What is offered comes from the runtime with the notice (which review, whether
its preview can be posted, each finding and how it is adjusted), not from the
text on screen, and it is acted on only while the panel still shows that
notice: an answer to a question that was open while the preview was planned
again sends nothing.

A panel shows what its own conversation was told. A command typed in a
review's own session, or in another client, can plan the preview again or
adjust the findings without that conversation hearing of it. Every command
the panel sends therefore ends with `--seen <word>`: the word names the
review's saved preview and adjustments as they were when the step was
offered, and the runtime refuses the command, before anything is planned,
saved or posted, when they are others by now (`Review <id> is no longer as it
was shown: …`). `/pr-comment --show` shows the saved preview again, with its
steps. A command you type names no preview and acts on the review as it is.

Commands for one pull request run one after another, but a run's receipt
arrives after its sessions were cleaned up, when the next command may already
have run. A preview that another `/pr-comment` command adjusted, planned again
or posted in that moment is no longer what would be posted: its run ends with
the status `REPLACED` (`[AZPR <run>] REPLACED; source review=<id>`), shows
nothing of it, offers nothing and leaves the conversation's current review as
it is. The other command's receipt is the one to read, in the session it was
typed in; `/pr-comment --show` shows the saved preview anywhere.

Only reviews started in the same conversation are accepted; commands from one
of the review's own sessions route to that conversation. Reviews are
persisted, so this also works after an OpenCode restart. A preview is
refreshed on every `/pr-comment` without `--publish`; `--publish` reuses an
existing preview exactly.

## Automatic comments after a review

`afterReview` (per mode: `preview`, the default, `none` or `publish`) or a
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
   name runs to a space, slash or `>` (spaces are ASCII whitespace only, so a
   no-break space does not end a value), and every `<` may start a tag, since
   a renderer may show an earlier one as text), HTML that hides text (a comment
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
   (`held back every item`). Every comment is posted with the disclosure of
   its review's method (findings checked by their reviewer, no separate
   verification; the summary also names incomplete coverage), a high-severity
   finding included. When the plan has no inline comment and the planner
   skipped every finding as `existing-thread` with a thread the runtime found
   live before planning, typically AZPR's own comment from an earlier run,
   there is nothing new to post: status `NOTHING_TO_POST`, `Automatic
   publication found nothing new to post: …`, and the plan is saved (the
   summary's marker follows the inline comments, so posting would add a
   second summary for the same findings each time an unchanged PR is reviewed
   again). `/pr-comment <id> --publish`, like every command you type, applies
   none of these safeguards: it posts every item of the saved preview, and
   items already posted are `ALREADY_PRESENT`.

Publication then follows the usual rules below (unchanged head, markers,
read-back). Automatic publication posts as the PAT owner, like
`/pr-comment --publish`.

## What is posted

- **One summary thread** (no file anchor): a 🤖 AI/model disclosure, optional
  review notes (the change's purpose or what changed), an index of every
  finding the review can publish with 🔴 high / 🟡 medium / 🔵 low labels, and
  optional details: findings without an inline comment and retained
  improvement suggestions from the report.
- **Inline threads** for high and medium findings, on the right side
  of a changed file at the reviewed head. Titles start with `🔴 high:` or
  `🟡 medium:`; bodies use **📝 Summary**, **🔎 Evidence** and
  **💡 Suggested fix**, followed by the disclosure line (the review's method
  and its models) and a hidden marker.

Low findings, findings that cannot be anchored, and issues that an existing
discussion on the PR already covers are skipped with a local reason; skips are
listed in the preview and receipt. Each planner skip names one cause
(`low-severity`, `no-inline-location`, `existing-thread` with its `threadId`,
`cannot-anchor` or `too-long`), and the runtime checks what the cause states:
the severity, whether the location can carry an inline comment, that the
thread is live, and that the finding's lines were not in the page's source
excerpts. Whether a finding deserves a comment stays the planner's call. Findings of the same review never cover each
other: duplicates were merged before planning, so each high or medium
finding gets its own comment unless one of those reasons applies, or it shares
a comment with the other places of the same defect
([below](#one-defect-at-several-places)).

### The disclosure line

Every comment says how its review was made. The summary starts with this
line, and every inline comment ends with it:

```text
AI-generated review; not human review or approval. Review method: findings checked by their reviewer against the source, no separate verification. Models: …
```

In zh-TW it reads:

```text
AI 審查，非人工審查或核准。審查方式：發現由審查者依原始碼自行查證，沒有另外的驗證。模型：…
```

The models are those of the review's stages and of
comment planning. When the review's coverage was incomplete, the summary's
line adds `coverage incomplete (…)` with the number of unreviewed changed
files when it is known and fixed short reasons otherwise; reviewer text never
goes there.

The findings are the review's REPORTED ones. Each was checked by its reviewer
against the source and by the runtime for form and source; nothing verified
it afterwards, and no comment says otherwise. An inline comment needs a
finding whose location is on a changed file at HEAD (a BASE location or
unchanged code stays in the summary index), and the planner's anchor must be
found in the HEAD source the runtime read, in that finding's own file: a
quote of another file is another place, and the planner is asked to correct
it.

### Reviews saved by 0.4.x

A review that 0.4.x saved can still be previewed, adjusted and published. Its
comments say what was true of the pipeline that made it:

- **A `/pr-review` or `/pr-deep` of 0.4.x**, whose findings a verifier
  confirmed. Its comments are planned from the confirmed findings and the
  verifier's additions, with the planner instructions of 0.4.6, and carry the
  line 0.4.x wrote: `AI-generated review; not human review or approval.
  Models: …`. Its finding IDs are those of its report (`F-1`, `R-2`, `V-1`).
- **A `/pr-quick` of 0.4.x.** Its comments are planned from its REPORTED
  findings (`Q-1`, `Q-1001`, …) and carry `Review method: quick review, not
  independently verified`.
- **A record of no known kind** (it does not say how its findings were
  produced in a way this version knows) can be listed and shown. It is never
  planned, adjusted or published; `/pr-comment` says so and asks for a new
  review.

A quick review of 0.4.x merged no duplicates, so two of its shards can have
reported one defect, for
example when a shard's tests led its reviewer into another shard's changed
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
different defects, so the prompt says to keep findings apart when unsure.

A review of 0.5.0 is offered no such candidates. Its duplicate check already
compared what different sessions reported in one file, and what that kept
apart stays apart in comment planning.

### One defect at several places

One mistake is often made at several places of a pull request: the same wrong
call in each of three handlers, the same stale sentence in each copy of a
file. Each place needs its own correction, so each is a finding of its own,
and before 0.4.6 each got its own inline thread. Such findings may now share
one:

- **One comment at one place.** The planner writes a single comment, anchored
  at the place that shows the mistake most clearly, in words that hold for
  every place.
- **Every other place is listed under it.** AZPR adds a section
  `**📍 Also at** (the same defect; fix these places with it):` (in Chinese
  `**📍 其他位置**`) with one row per other finding: its file and lines, and
  its ID. The rows are the findings' own locations, not text the planner
  wrote. It is a plain list, never collapsed.
- **Only for the same defect.** The findings have the same severity (high or
  medium), lie on different lines of files the pull request changes, and need
  the same correction. Findings that only resemble each other, that follow
  from one another, or whose places need different corrections keep their own
  comments. When unsure, the planner keeps them apart.
- **Only places that exist as written.** A place is listed as its finding
  states it, so the runtime offers a finding only when the file, as it reads
  it at the reviewed commit, has those lines (a file the pull request deletes
  has none), and when the file's name can stand in a list unchanged (no
  control character, no end of an HTML comment). Any other finding keeps its
  own comment.
- **The review keeps every finding.** Each place stays a row of the summary
  index with its own ID, and each can be excluded or given another severity
  after a preview like any finding.

Which findings may be such repeats is settled before the planning pages are
made, so that a group is on one page. Nothing is added unless at least two
such findings have one severity and lie at different places:

- When all findings fit one page (at most four, and within a page's text),
  that page is offered its findings of equal severity at different places
  (`repeatCandidates`).
- Otherwise one **grouping pass** runs first, provided that two such findings
  fit one page together (a group shares a page): a session of the comment
  planner that gets only the findings that fit a page together with another
  one of their severity at a different place, inline (ID, severity,
  location, summary, suggestion, and the evidence unless the list is then
  longer than 60,000 characters), and says which of them are one mistake at
  several places. A finding without such a partner (the only one of its
  severity, or one longer than a page) is not part of the pass. The runtime checks each group it proposes (two or more of
  those findings, one severity, different lines, a finding in one group at
  most), asks for a correction like for a page, and then drops a group that
  is still wrong. The pass has one answer and no continuation. A group shares
  a page, which can then hold more than four findings; a group larger than a
  page's text is planned in parts of two or more findings. A list that is too
  long even without the evidence is not grouped: a `PROGRESS` notice says so,
  and planning goes on without grouping.

The page's planner still decides whether a group gets one comment. The
runtime accepts it only when every finding it names is in one listed group,
they share a severity, lie on different lines that the changed files have at
the reviewed commit, and the anchor touches the lines of exactly one of them;
that finding is where the comment stands. An anchor that reaches from one
finding's lines into another's names no place, and the runtime does not
choose one. A refused combination goes back for correction and then falls
back to single comments and reasoned skips. A page
that continues in another session is still offered what is open of a group,
while two or more of its findings are. The preview shows such a comment with
all its findings and the planner's reason (`Combined: …`).

The list follows the planner's text after a blank line, so that text must not
end inside a block that would take the list in. As CommonMark reads blocks,
two kinds go on over a blank line: a code fence without its closing fence,
and raw HTML that waits for its own end (`<pre>`, `<script>`, `<style>`,
`<textarea>`, `<?…`, `<!…`, a CDATA section). A text that leaves one of them
open is sent back with its name, like any other refused combination. The
runtime reads the lines for this and nothing else: a fence inside a list item
or a quote ends with it, and a fence line after it stands on its own. What a
browser makes of an inline tag that the planner left unclosed is not a block
and is not checked; automatic publication holds scripts, embedded content and
hidden text as for every comment.

A grouping pass that fails, for instance on a provider error, costs only the
grouping: a `PROGRESS` notice says so, and planning goes on without it.
The pass is one more stage of the comment planner's model: usually one
request, since its input holds the findings and it needs no tool, though it
has the planner's read-only tools and correction turns like a page. Its
session is listed and deleted like a page's. The runtime cannot tell a
well-formed but wrong combination of two different defects, so the prompt
says to keep findings apart when unsure, and each finding's own summary stays
in the index either way.

Azure DevOps, like the other code hosts, cannot anchor one thread at several
places, and one thread cannot show which of its places were fixed; that is why
the other places are written out in full. When the pull request is planned
again later, the runtime reads that list back and tells the planner which
places the thread says it covers (`alsoAt` in `existingDiscussions`), so that
the other places are seen as discussed and get no thread of their own. This
only informs the planner, as the start of a thread's text does: nothing is
posted or skipped because of it. The list is read only where the runtime
wrote it: in the comment that opened a thread on a file, which carries AZPR's
marker, under the list's own heading, in rows of a place and a finding ID,
and followed by nothing but the attribution and the comment's two markers. A
comment that someone continued after its list no longer says what it lists,
a reply that quotes such a comment says nothing about its thread, and a
planner's text that writes that heading itself is sent back.

**Markers: when is a comment already on the pull request?** Every inline
comment ends with a hidden marker made of its file and the lines it quotes
(not their numbers, so that it survives lines moving). Publication skips a
comment whose marker the pull request already has, which is what makes
posting safe to repeat. A comment for several places is more than its place,
so its marker is made of the file, the quoted lines **and the other places
it lists**. Publication skips it only when that marker is on the pull
request: the comment found is then this very comment, with every place. A
comment for the place alone, or one that lists other places, is another
comment and does not stand for it. So a receipt never has to work out from a
posted text which findings a comment covers: `ALREADY_PRESENT` for a shared
comment means that this comment, with these places, is there.

It follows that a shared comment and a comment for one place do not find
each other by marker, and one could be posted next to the other on the same
lines. Planning avoids that, with the comments the pull request had when
planning began. A shared comment carries a second hidden marker, made of its
file and quoted lines only, which says "a comment for several places stands
here" and which nothing but this rule reads:

- A **shared comment** on quoted lines that already carry a comment of
  AZPR's (for one place or for several) is sent back, unless the pull
  request has this very comment. The planner, which is told not to choose
  such a place, is asked to anchor it at another of its places or to leave
  that finding out (a finding that an existing thread covers is skipped as
  discussed). "This very comment" is a shared comment with the same file,
  quoted lines and other places: the count that tells two defects at the
  same places apart is given only when the pages are assembled, so the
  second of two such comments passes too, and is posted next to what is
  there.
- A **comment for one place** on quoted lines that carry a shared comment is
  sent back too, unless a comment for one place is there as well (which it
  then finds by its marker, as always). The planner is asked to skip the
  finding as discussed, or to quote other lines.

A comment that still stands there after the correction turns is not planned:
the shared one is dropped like any refused combination, the single one is
skipped, and the preview gives the reason. When the threads could not be
read before planning, or a comment appears between a preview and its
publication, nothing is refused and the comment is posted next to the one
that is there: one more thread, never a finding counted as posted that is
not.

As for every comment, a marker does not hold line numbers: the same lines of
text elsewhere in the same file share it, and comments that quote the same
lines are told apart by their order in the plan. And the other places are
compared as written (a file and its lines), so a shared comment whose other
places moved is another comment than the one posted before.

## Planning

Planning uses the first reviewer model of the review's mode (a review whose
mode is off by now, with an empty `reviewers` list, is not planned until that
list names a model; posting a saved preview needs no model). It works in pages of at most four findings
(more only where one defect at several places keeps its findings together, see above), plus
segments of the review's report for the summary details. Before planning, the
runtime reads every live thread once and fetches the HEAD source of each
finding's file. Each page then receives, inline: the findings,
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

When a page fails, no further page or continuation session starts and no page
is asked for a correction any more: a stage that is already running finishes
the turn it is in, and its answer is taken as it is. (A page whose own session
failed in a way that is tried again still gets its new session; only a failure
that is final counts.) The command reports the failure of the lowest failed
page (INCOMPLETE) as before; no preview is kept. `/pr-stop` cancels every
running page.

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

A low finding never becomes an inline comment, and the finding's severity always
wins over the planner's label.

## Adjusting findings after a preview

After reading a preview, a person can leave findings out of publication or
change their severity, and plan the preview again:

```text
/pr-comment --exclude F-1,F-2                     leave F-1 and F-2 out
/pr-comment --severity F-3=low,F-4=medium         publish F-3 as low and F-4 as medium
/pr-comment --exclude F-1,F-2 --severity F-3=low  both in one command
/pr-comment --reset                               undo every adjustment
/pr-comment --show                                the saved preview again, without a model
/pr-comment <review-id> --exclude F-1             the same for a review named by its ID
```

- The review ID is optional, as for every `/pr-comment` command: without one
  the adjustment applies to the conversation's current review, and the
  receipt names it. Every review has its own F-1, so a finding ID that the
  current review does not have refuses the command and names that review.
  IDs are those of the review report and the preview (`f1` reads as F-1). Only findings the review can publish
  are accepted: its reported findings (for a review saved by 0.4.x, the
  confirmed and verifier-added ones, or a quick review's reported ones). A
  merged duplicate names the finding it was
  merged into; any other ID refuses the whole command and changes nothing.
- Each list is complete and replaces the saved one (`none` empties it): after
  `--exclude F-1`, a later `--exclude F-2` excludes only F-2 and restores F-1,
  so name both (`--exclude F-1,F-2`) to keep both out; the receipt lists what
  was excluded and restored. The other list is kept, except that excluding a
  finding drops its severity change and a severity for an excluded finding
  restores it. A finding named in both lists is refused, and a severity equal
  to the review's is no change. `--reset` clears both. A command that leaves
  both saved lists as they are changes nothing: AZPR answers at once, plans
  nothing and keeps the saved preview.
- A changed severity changes how a finding is published (its title, whether it
  can get an inline comment, the summary counts); it does not check the
  finding again or change its evidence, trigger or impact. When the finding
  itself is wrong, exclude it.
- Each change plans the preview again with a model, unless it excludes every
  finding (see below). The planner receives the adjusted findings (without the
  excluded ones, with the new severities) and an `adjustments` field that
  states them; the summary index and its counts follow them. A finding set to
  low stays in the summary only, and a raised one becomes eligible for an
  inline comment (it still needs a location that can carry one and no live
  thread that covers it). The other comments are written again, so their
  wording may change: read the whole preview before publishing. The review
  itself, its findings and its report are not changed.
- An excluded finding is never assigned to a page, so it gets no comment of its
  own. Any published text that names the ID of an excluded finding (the body of
  any inline comment, combined ones included, the summary note or
  `summaryDetails`) gets a correction turn; after the last one the comment is
  skipped (its finding stays in the summary index) and the note or details are
  dropped. The assembled preview is checked as well: a summary row is the
  review's own text for its finding, so when a kept finding's summary names an
  excluded one, the preview says which row and publication is held until you
  exclude that finding as well or restore the excluded one. A reference
  without the ID cannot be detected; the preview shows it.
- Excluding every finding plans nothing and posts nothing: the result is
  `NOTHING_TO_POST`, not the summary of a review without defects.
  `--exclude none` brings the findings back.
- Adjustments are saved with the review, with the time of each change, survive
  a restart and apply to a later `/pr-comment` until `--reset`. The
  preview and the receipt list them; nothing posted to the PR mentions them.
- A review that was adjusted, also one reset since, is posted only from a
  preview planned after its latest adjustment: every adjustment discards the
  earlier preview in the same save, and `--publish` never plans and posts such
  a review in one step (for example after a failed new preview, or a restart
  while it was planned). An adjustment that cannot be saved changes nothing and
  the receipt says so; a new preview that cannot be saved is dropped and has
  to be planned again.
- Once publication of an adjusted preview has started (an item was sent, may
  have landed or was found on the PR), the review is neither adjusted nor
  planned again: `--publish` retries the same preview and `--show` shows it;
  run a new review to change what is posted.
- Adjustments shape only what a publication adds; AZPR never changes or
  replaces a posted comment. An item the PR already has (the same marker, from
  an earlier publication; inline markers follow the anchored lines, not the
  commit) is skipped as for any review and keeps its earlier text. For an
  adjusted review the receipt names those items whose text differs from the
  preview (also when a comment appears only as publication reads the threads
  back), marks the summary and the comments whose severity you changed, and
  counts the other AZPR comments on the PR, where a finding you excluded may
  still be visible; edit them on the PR if they should change.
- `--show` prints the saved preview, with its adjustments, without a model or
  an Azure DevOps request.

Without these options `/pr-comment` works as before: the planner's input and
system prompt, the saved review and the receipts are unchanged.

## Publication

Publication is deterministic runtime code using the Azure DevOps REST API
(api-version 7.1; see [Azure DevOps access](AZURE_DEVOPS.md)):

1. Read the PR and its iterations. Refuse if its source commit differs from
   the reviewed head (STALE). The PR's status stops nothing: a completed or
   abandoned PR, such as one merged before its review was commented on, takes
   the comments like an active one, and the receipt names that status
   (`Publication (…); the PR is completed:`).
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
- A comment for one defect at several places: hash of PR identity, file
  path, normalized anchor text, the other places it lists, and an ordinal
  for two such comments that are alike in all of these (two defects at the
  same places). Before it stands a second marker, of the file path and
  anchor text only, which planning reads and publication does not (see
  [one defect at several places](#one-defect-at-several-places)).
- Summary: hash of PR identity, reviewed head and the inline markers (for a
  comment at several places, its own), so a new review of the same commit
  with the same comments does not post a second summary.

A combined comment is one inline item, known by one marker: one that combines
the findings of a 0.4.x quick review on the same lines by the marker of those
lines, one for several places by its own. The publication ledger
records all finding IDs of a combined comment (`findingIds`), and ledgers and
plans saved before that field existed are read as before.

Only an identical complete marker counts as already present. Neither the
review mode, the finding IDs nor the disclosure text is part of a marker, so a
review published after another review of the same head finds that review's
comments, whatever mode or version made them: an inline comment on the same
anchor with the same ordinal is `ALREADY_PRESENT` (it keeps the disclosure
line it was posted with; AZPR never edits it), a
second issue on that anchor has ordinal 1 and is posted, and the summary is
posted again only when the set of inline markers differs. A pull request can
therefore carry comments with different disclosure lines, such as those of a
0.4.x review beside those of a later one.

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
