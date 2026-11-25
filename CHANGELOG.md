# Changelog

## 0.5.1 — 2026-11-26

AZPR is tested with OpenCode 2.4.1 instead of 2.3.2. OpenCode 2.3.1 to 2.4.1
were compared with 2.3.0, the last version whose interfaces had been studied
one by one, and what they change for AZPR is fixed here, together with
defects that were there on 2.3.0 too. The prompt files are those of 0.5.0,
no setting is new, and settings and saved reviews are used as they are. What
a private session is sent besides its prompt changed (see below), and no
review with a real model was run on this version.

**With OpenCode 2.4.0 or 2.4.1 and the terminal panel, upgrade**: the first
item below could post comments that nobody asked for.

OpenCode 2.4.x:

- **A release the terminal UI makes up no longer picks a step.** OpenCode
  2.4.0 and later end a mouse drag whose release they never saw (the pointer
  left the window with the button down, for instance) at the next press of
  the button, anywhere and any time later, with a release for the element
  that was pressed first. 0.5.0 took that for a click: a step that had been
  pressed and moved on a little was picked by a later click somewhere else.
  In a fixture, with the step **Post 3 comments…** and the next click where
  the question's "Yes" row appears, the three comments were posted. A release
  now counts as a click only within a second of the pointer's last movement
  with the button down; a button held still is a click for any time. The
  rows of the sessions and `close` follow the same rule. OpenCode 2.3.x makes
  no such release up.
- **A usage limit that a ChatGPT workspace's admin set is named and not
  retried.** OpenCode 2.4.0 reports it as a type of its own
  (`provider.chatgpt-workspace-limit`), which 0.5.0 did not know: a stage
  that hit it started a second session that failed the same way, and the
  receipt said only HTTP 429.
- **One of AZPR's commands that arrives as an ordinary prompt is stopped.**
  `opencode --prompt "/pr-review …"` can submit the text before the terminal
  UI has loaded the commands. With OpenCode 2.4.0 and 2.4.1 that happened in
  14 of 16 starts in a fixture (1 of 12 on 2.3.0 and 2.3.2), and in 10 of the
  14 the conversation ran on OpenCode's built-in free model, which would have
  been sent the PR URL and the context. AZPR now refuses a prompt of an
  ordinary conversation that begins with one of its commands, before any
  model gets it, and says so there. The terminal UI then reports a session
  that failed and may try again in new conversations, which stay empty.
  Start commands in the terminal UI once they are listed, or from a script
  with the command endpoint.
- Tested with OpenCode 2.4.1 (was 2.3.2); `/pr-check` warns on other
  versions. The terminal panel, the setup dialogs and the token field were
  exercised in the new design that 2.4.0 made the default and in the classic
  one.

Private sessions:

- **Local instructions stay out of private sessions.** OpenCode adds to every
  request what it collects for the conversation's directory: `AGENTS.md`
  (from 2.3.1 also `CLAUDE.md` and `~/.claude/CLAUDE.md`), the instruction
  files a configuration lists, and what MCP servers, references and skills
  say of themselves. All of it went to every reviewer, duplicate check,
  rating and comment planning session, although it describes the local
  directory and not the PR: with an instruction file of 54,000 characters,
  the system messages of a small review and its preview grew from 138,000 to
  625,000 characters. Private sessions now get AZPR's own instructions and
  OpenCode's date and environment, also with `claude-agent` models, to which
  OpenCode hands instructions another way. Your own conversations are not
  touched. A reviewer can still read local files on purpose, and the
  environment names the directory as before.
- **Reading a file beside a nested instruction file no longer fails the
  pass.** When a reviewer's native `read` reads a file of the local project
  in a directory that has an `AGENTS.md` of its own (from OpenCode 2.3.1 also
  a `CLAUDE.md`), OpenCode leaves that file in the session. 0.5.0 took it for
  someone else's message and failed the pass, and its retry too. Such a
  message is now kept from the model and ends no turn.
- **A reviewer's command that goes on in the background no longer fails its
  pass** (only with `shell` set to `ask` or `inherit`). From OpenCode 2.3.1 a
  command that outlasts its timeout, 120 seconds by default, is moved to the
  background, and OpenCode tells the session when it has ended. 0.5.0 took
  that notice for someone else's message: the pass failed, and its retry ran
  the command again. The notice of a command the session itself started is
  now part of the turn, once for each such command. A turn ends when its
  answer is given: a command that ends later wakes the session, which then
  gets no model request and no tool, and the answer stands.
- AZPR's tool definitions are no longer in the requests OpenCode builds for
  an ordinary conversation outside a turn (a summary, also the one it writes
  in the background, and a generation such as a side question): six
  definitions, 4,990 characters, that those sessions could never call.

Large inputs:

- **Rows that OpenCode's read returns whole.** A value too large for a prompt
  (a long PR description, the file list of a large PR, a large tool result)
  is handed to a model as a reference to pages, which it reads with OpenCode's
  native read. That tool cuts every line after 2,000 characters, and a row
  held up to 3,000 characters of text, so a model got about two thirds of
  what it read. Rows now fit, and pages of a saved review that do not are
  written again whenever it is used. Where that cannot be done (a full disk,
  for instance) the command says so instead of planning from cut rows. The
  instructions to the models did not change.

Receipts:

- A review's receipt lists the stages by their place in the pipeline (the
  passes in their order, the duplicate checks, the rating), also in its
  inactivity notice, and the report is in the last of them. Until now these
  followed the order in which OpenCode had created the sessions, which
  differed between runs of one review.

Documentation:

- Install an exact version: OpenCode 2.4.0 and later update an entry such as
  `…@latest` by themselves, which ends a review that is running. A plugin
  that is loaded before AZPR reloads AZPR when it changes; list AZPR first.
- Corrected: with `claude-agent` models a session's local process ends five
  minutes after the session's last turn, not when OpenCode exits, and
  OpenCode 2.4.0 and later end it when the session is deleted. Claude Code
  keeps a transcript of every such session under its own configuration
  directory, which deleting the OpenCode session does not remove.
- Corrected: OpenCode writes background summaries by default from 2.3.1 on,
  not from 2.3.2.
- The team guide names three opt-in experiments of OpenCode 2.4 that reach
  AZPR's sessions (`full_codemode`, `sqlite_fts`, `home_memory`).

Known and not changed by this release (see the
[validation record](docs/VALIDATION.md#known-limitations)):

- A reviewer's answer that reaches the model's output limit fails its pass;
  the receipt names another message in the turn, not the limit.
- In the list that adjusts findings, typing an ID selects by OpenCode's fuzzy
  search: with ten or more findings, `F-1` selects `F-11`. Read the title of
  the dialog that opens before choosing.
- Page Up and Page Down close the token dialog of `/pr-setup`, as they close
  OpenCode's own dialogs; nothing is saved then.

## 0.5.0 — 2026-11-24

Every review now runs one pipeline: independent review passes, a duplicate
check and a severity rating, then comment planning as before. `/pr-review`,
`/pr-deep` and `/pr-quick` differ only in the models listed for them. The
verifier is gone, and so is the split into a functional and a risk reviewer.
This release changes how findings are produced, what reports and comments say
about them, and the layout of the settings file: the settings of 0.4.x are not
used until you confirm an update that `/pr-setup` shows first (see Upgrading).

Why: measured on ReviewBench's test set with two model strengths, a verifier
of the reviewers' own strength rejected 0 of 280 and 3 of 1,185 candidate
findings and added few of its own, for 30% and 54% of a review's cost; two
passes of one reviewer prompt found about as much as the functional and the
risk reviewer together. What is lost with the verifier is named there too:
its additions, and for the stronger model a rewrite that read better in about
one finding in eight. The runs, their judge (our own, not the benchmark's)
and their limits are in the [validation record](docs/VALIDATION.md).

Measured before the release with ReviewBench's own judge, against 0.4.6 with
GPT-6.2 Sol on 24 pull requests of its test set: two passes found about as
many reference issues (49.1% against 51.5%) at 58% of the cost, with 89.7% of
their findings judged valid against 93.2%; three passes matched 0.4.6 (51.2%,
93.2%) at 78% of the cost; four found more (54.8%, and 65.6% of the high and
medium ones against 60.6%) at about the same cost
([validation record](docs/VALIDATION.md#050-against-046-on-reviewbench-with-its-own-judge-2026-11-24)).

Reviews:

- **Passes instead of roles.** `models.<mode>.reviewers` lists one to four
  models (`provider/model` or `provider/model#variant`); each entry is one
  pass, and an entry may repeat. A pass is an independent reviewer session per
  shard that covers function and failure behaviour, reads beyond the diff and
  checks each of its findings against the source before it answers. Passes do
  not see each other's work, and all sessions of a review share
  `workflow.parallelSessions`.
- **No verifier.** Nothing checks a finding after its reviewer. The runtime
  checks what it can check without judging: every field is there, the
  location exists at the reviewed commit, and the session that reports a
  finding read that file. Findings that pass are `REPORTED`; the others are
  `NEEDS_INFO` and never commented on.
- **Finding IDs are `F-1`, `F-2`, … for the whole review**, numbered by place
  (HEAD before BASE, then path and lines) and then by pass. The IDs no longer
  say which reviewer found something, and they do not depend on which session
  finished first. A reviewer numbers its findings in a range of its shard
  (`F-1001`, …); where its text names one of its own findings, the text
  names that finding's review ID afterwards, or the finding it was merged
  into. Code in the text (a code span, a fenced block, an ID written between
  quotes) stays as written.
- **A duplicate check across sessions.** Where different reviewer sessions
  reported findings on one side of one file, a session of the first reviewer
  model compares them and merges repeated reports of one defect (the same root
  cause and the same correction). The same kind of mistake at several places
  stays several findings; one comment may still cover them, as since 0.4.6.
  The check never merges two findings of one session, also not through a
  third finding: the runtime refuses such a merge. A check that fails keeps
  every finding. The finding that stays records the reports it stands for.
- **A severity rating, on by default.** After the duplicate check, sessions
  without tools rate the reported findings from their text alone, without the
  level their reviewer gave them, so that the findings of different models
  stand on one scale. `models.<mode>.rater` is `""` (the first reviewer model
  rates), a model, or `false` (no rating; the reviewers' levels stay). The
  report shows the reviewer's own level where the rating changed it. In 0.4.x
  the rating ran only with a named rater.
- **`/pr-deep` and `/pr-quick` are the same review with other models.** An
  empty list leaves the mode off, which is the default for both; no mode falls
  back to another mode's models. Deep is for stronger models, a higher
  variant or more passes; quick is usually one pass of a fast model.
- **Coverage is two numbers** when a mode has several passes: the changed
  files reviewed in at least one pass, and those reviewed in every pass. A
  pass that fails costs depth, which the second number and a warning show; a
  file is unreviewed only when no pass reviewed it. A review is `COMPLETE`
  when at least one session gave a usable answer, `PARTIAL` when answers came
  but none was usable, and without a result when every session failed.

Reports, receipts and comments:

- A report states status, coverage and method separately, and says in its
  first lines that findings were checked by their reviewer and that no
  separate verification ran. A receipt's first line reads
  `COMPLETE; coverage complete; verification none` (with several passes:
  `coverage complete, 12/12 file(s) in every pass`; where not every changed
  file was reviewed, also how many were: `coverage incomplete, 11/12 file(s)
  reviewed, 10/12 in every pass`).
- Comments carry a new disclosure line: "Review method: findings checked by
  their reviewer against the source, no separate verification", followed by
  the models. Comments already on a pull request keep the line they were
  posted with, and AZPR recognises all three wordings as its own.
- Reviews saved by 0.4.x can still be shown, previewed and published. A
  review whose findings a verifier confirmed is planned with the wording of
  0.4.6 and its comments keep the old line.
- Comment planning, previews, adjustments, automatic comments and publication
  work as before, with the first reviewer model as the planner. A
  `/pr-comment --publish` that only posts a saved preview needs no model and
  does not read the model catalog.
- A correction turn that fails or gives no usable answer no longer costs a
  usable one, in any stage: the latest usable answer stands (a follow-up's,
  where it had one), and the items it would have repaired stay degraded. So
  does a follow-up whose context overflows on a shard of one file. A
  duplicate check that returns no list of merges counts as failed.

Settings (`version: 3`):

- New: `models.review.reviewers`, `models.deep.reviewers`,
  `models.quick.reviewers` (lists), and `models.<mode>.rater` for all three
  modes (`""`, a model, or `false`).
- Removed: `models.<mode>.functional`, `risk` and `verifier`,
  `models.quick.reviewer`, the documentation-only `models._help`, and
  `workflow.shardFindings`, which sized the verifier's batches.
- `/pr-check` shows each mode's passes and which model rates.

Upgrading from 0.4.x:

- The settings of 0.4.x (`version: 2`) are kept as they are and not used.
  Until they are updated, AZPR's commands only say that the settings need an
  update; no review and no Azure request starts.
- `/pr-setup` shows what the update changes before anything is written. In
  OpenCode's terminal UI it asks, in a list whose first row keeps the file.
  In other clients it prints the changes and the command that confirms them
  (`/pr-setup --migrate <word>`); the word belongs to the file as it was
  shown, so a file that changed meanwhile is shown again.
- The update turns the functional and the risk model of a mode into its two
  passes, in that order, and drops the verifier model. A quick reviewer
  becomes a list of one. A named rater stays. `/pr-deep` stays off when it
  was off, also when only some of its three models were set. Every other
  setting keeps its value. The update repairs nothing: a value 0.4.x could
  not use stays where it goes now, and so does a setting this version does
  not know, so that `/pr-setup` names it afterwards; a mode whose models
  already name `reviewers`, which 0.4.x refused, is kept as it is, and where
  it is written as this version writes a mode, the update shows the passes
  it then runs. A first setup's update is loaded at once; settings that are
  in use wait for a restart, as always.
- What changes without being asked for, and is named before you confirm: a
  mode without a rater now gets its findings rated by its first reviewer
  model (`"rater": false` turns that off), and with `afterReview` set to
  `publish` the comments of the new reviews are posted automatically although
  no verifier confirmed their findings.
- Source installations: `install.sh --replace` carries a version-2 settings
  file over byte for byte and says so (also one whose version reads `2.0`,
  as 0.4.x accepted); `/pr-setup` then updates it.

Setup:

- `--model M` on a first setup writes M twice for `/pr-review` and once for
  `/pr-quick`. `--review-model`, `--quick-model` and `--deep-model` take one
  model (the mode's usual passes: two, one and two), `M*N` for N passes, or
  entries separated by commas for different models; `off` turns quick or deep
  off.
- In the terminal UI a model row asks for one model and then for the passes:
  take what is shown, add a pass of the same or another model, or take the
  last one away. Picking the saved first model again starts from the saved
  passes.

Compatibility:

- Tested with OpenCode 2.3.2 (was 2.3.0); `/pr-check` warns on other versions.
- The private agents are now `azpr-<mode>-reviewer`, `-reviewerb`,
  `-reviewerc`, `-reviewerd`, `-dedupe`, `-rating`, `-comment-plan` and, for
  review and deep, `-comment-plan-verified`. The names of the 0.4.x roles
  stay reserved.

## 0.4.6 — 2026-11-21

One defect that a pull request makes at several places now gets one inline
comment that lists the other places, where each place had a thread of its own.
The reviewer and verifier instructions are those of 0.4.5, so a review finds
and verifies as before; the comment planner's instructions changed, and no
setting is new.

Comments:

- A mistake repeated in several places (the same wrong call in each handler,
  the same stale text in each copy) is one finding per place, since each place
  needs its own correction. Each of them used to get an inline thread with
  much the same text: twelve moved files with one inherited defect were twelve
  threads to read and resolve. The comment planner may now write one comment
  for such findings, at the place that shows the mistake most clearly.
- AZPR lists every other place under that comment, in a section
  `**📍 Also at** (the same defect; fix these places with it):` (in Chinese
  `**📍 其他位置**`): one row per other finding with its file, its lines and
  its ID. The rows are the findings' own locations, not text the planner
  wrote, and the list is plain: nothing is collapsed or linked, so its own
  markup holds nothing back in automatic publication (a file name is checked
  like any other text of the comment).
- Findings share a comment only when they have the same severity (high or
  medium), lie on different lines of files the pull request changes, and the
  planner says they are the same mistake with the same correction. Places
  that need different corrections keep their own comments, and when unsure
  the planner keeps findings apart. The preview shows a shared comment with
  all its findings and the planner's reason.
- A place is listed as its finding states it. The runtime therefore offers a
  finding only when the file has those lines at the reviewed commit and its
  name can stand in a list unchanged, and it accepts a shared comment only
  when its anchor touches the lines of exactly one of its findings, which is
  where the comment stands. A text that ends inside a code fence or a raw
  HTML block, which would take the list in, is sent back for correction.
- The review is unchanged: it still has one finding per place. Each keeps
  its row in the summary index, its ID, and can be left out or given another
  severity after a preview.
- A shared comment has a marker of its own, made of its file, the lines it
  quotes and the other places it lists. Publication skips it only when that
  marker is on the pull request, so `ALREADY_PRESENT` means that this very
  comment, with every place, is there. The markers of comments for one place
  are unchanged, and so is publication.
- Which findings may be such repeats is settled before the planning pages are
  made, and only when at least two of them have one severity and lie at
  different places. When all findings fit one page (at most four, within a
  page's text), that page is offered its findings of equal severity at
  different places. Otherwise, where two of them fit one page together, a
  grouping pass runs first: one more stage of the comment planner, usually
  one request, whose input is the findings that could share a page with
  another one of their severity, and which says which are one mistake at
  several places. A group then shares a
  page, which can hold more than four findings. A pass that fails costs only
  the grouping (a progress notice says so, and the comments are planned one
  per place), and a run that is stopped during it plans nothing more.
- Nothing posted is ever changed, and an item the PR already has is skipped
  as always. When a pull request with a shared comment is planned again, the
  planner is told which other places that thread says it covers, so they get
  no thread of their own; the list is read back only where AZPR wrote it, in
  the comment that opened the thread.
- A shared comment and a comment for one place are not put on the same
  quoted lines (a thread per place from an earlier version, say): when
  planning, the comment is sent back and the planner is asked for another
  place or to skip the finding as discussed, and a comment that still stands
  there is not planned, with the reason shown in the preview.

The README's benchmark section now says what each precision measures: the
share of comments on Martian's list of issues, next to the share of findings
that ReviewBench's judge rated valid.

## 0.4.5 — 2026-11-20

While a run is under way, the terminal panel offers to stop it. The reviewer,
verifier and comment-planning instructions are those of 0.4.4, and no setting
is new.

The terminal panel:

- A `STARTED` notice says how its run is stopped (`/pr-stop <run-id>`), but
  in the conversation, which a person who reads the panel does not watch, and
  with an ID to copy. While a run is under way (a review, a preview that is
  being planned, a publication, a check) the row at the panel's foot now
  offers **Stop this run…** (`s`), and nothing else.
- Stopping asks first, in a list whose first row is "No, let it run" and
  names the run. "Yes, stop it" sends `/pr-stop` with that run's ID to the
  session on screen, and AZPR takes it like a typed command; the run ends
  with its `CANCELLED` receipt, and requests that were already sent may still
  be billed.
- What is typed into such a question finds a row by the beginning of its
  title: `y` finds "Yes" and `n` "No". The key that opened the question,
  pressed once more than meant, is typed into it, and OpenCode's own search
  would find `s` in "Yes, stop it" alone and select it; now it leaves no row
  for Enter to take. The question before posting answers the same way.
- An answer is acted on only while the panel still shows that run as under
  way. If the run has ended, or the next run has started, while the question
  was open, nothing is sent and the panel says so; a step that reaches AZPR
  after its run has ended stops nothing, and no other run.
- That a run can be stopped comes from the runtime, like every other step: in
  the metadata of the run's `STARTED` notice, which no model reads (the run's
  ID). The text of that notice is unchanged, and progress notices and
  receipts are sent as before. A run that an earlier version started offers
  nothing; it is stopped by typing the command its notice shows.
- Where the panel has no report or preview to show, it said "No report or
  preview yet." also of a run that had ended, such as one that was stopped.
  Once the run has its receipt it now says "This run ended with no report or
  preview to show."
- A click on a step at the panel's foot could be lost (since 0.4.4). The
  steps were drawn anew whenever the panel worked its content out again,
  which every notice and every answer of the server causes, and OpenTUI finds
  what lies under the pointer in the frame it drew last: a press or a release
  that came before the next frame went nowhere. Each step now keeps its
  element, as the session rows do, and its highlight under the pointer.

Documentation:

- The recording at the top of the README and the pictures of the panel in
  the demonstration are new: a real review with the row at the panel's foot
  (the step that stops a run, then posting and adjusting), a review stopped
  from the panel, and the whole terminal in every frame. They showed the
  panel of 0.4.2.

## 0.4.4 — 2026-11-19

After a comment preview, the terminal panel lists what you can do next at its
foot, and picking one does it: post the comments, leave findings out or change
a level, reset that. A conversation used for a review is named after its PR,
and several texts of setup say more exactly what they mean. The reviewer,
verifier and comment-planning instructions are those of 0.4.3, and no setting
is new.

The terminal panel:

- A receipt ends with the commands for the next step, but the panel shows the
  document a receipt encloses, so those commands had to be found in the
  conversation and typed. After a comment preview the panel now lists them in
  one row at its foot, where reading ends: **Post N comments…**, **Adjust
  findings…**, and **Reset adjustments** once there are some. The row is on
  the panel's own ground under a line, stays in place while the text scrolls,
  is level with OpenCode's status bar, and wraps as whole items in a narrow
  panel. One of them is clicked, or picked with its key (`p`, `a`, `u`) while
  the panel has the keyboard; the keys are drawn dim while they would only
  type a letter into the prompt. A label that ends in `…` asks before
  anything is sent.
- Posting asks once more, in a list whose first row is "No, post nothing":
  a key pressed twice posts nothing.
- Adjusting opens the findings as a list with how each is published now.
  Pick one to leave it out or to choose its level; every change is applied
  with one command from the foot of the list (**apply**, `ctrl+s`), which
  stays in view however long the list is, or from the list's last row, and
  the preview is planned again.
- After a review that no preview follows by itself (`afterReview: none`, a
  review that was stopped, or one without findings to comment on) the row
  offers **Preview comments** (`c`) instead of posting, and the findings can
  be adjusted before that first preview.
- Each of them sends the `/pr-comment` command you would type, with the ID of
  the review the panel shows, to the session on screen; AZPR takes it like a
  typed command, so its checks, its `STARTED` notice and its receipt are the
  same. The panel sends nothing by itself and never a prompt. The steps are
  there only for the notice that happened last: once a run starts or another
  receipt arrives, they are gone.
- A click on one of them leaves the keyboard with the prompt: the host gives
  a panel the keyboard on a click, and a key of the panel would then act on
  what is typed next.
- Letting go of the mouse button at the end of a selection of text is no
  click. Text selected down the panel and let go over a session's row opened
  that session, and over `close` closed the panel (since 0.4.2); neither
  happens now, and a step at the panel's foot is not picked that way either.
  A step is picked by pressing and letting go of the left button on it:
  letting go after the pointer has left the step picks nothing.
- An answer is acted on only while the panel still shows what it was given
  for. If the preview is planned again, another session comes on screen or
  the panel is closed while a question is open, nothing is sent, and the
  panel says so: a preview is not posted unread.
- A panel knows only what its own conversation was told, and a command typed
  in a review's own session, or in another client, changes the review without
  a notice there. Each command the panel sends therefore ends with
  `--seen <word>`, which names the saved preview and the adjustments its step
  was offered for; AZPR refuses the command when they are others by now
  (`Review <id> is no longer as it was shown: …`), and `/pr-comment --show`
  shows the saved preview again with its steps. A command you type needs no
  such word and acts on the review as it is.
- What can be picked comes from the runtime, in the metadata of the notice
  that offers it (which no model reads), not from the text on screen: which
  review, whether its preview can be posted, and each finding with its level
  and whether it is left out. It goes with the document that notice encloses:
  under a report a preview is planned, never posted. The text of every other
  notice is unchanged. A review with more than 200 findings offers nothing
  to pick.
- A preview that is planned again is shown from its beginning, wherever the
  one before it was left, and the text that scrolls no longer touches the
  panel's header.
- A session whose model has answered is shown as `finished` until its run's
  receipt names its result (`complete`, `failed`). It was shown as `idle`,
  OpenCode's word for a session at rest, which read like a fault while the
  verifier was still working.

Comments:

- A run's receipt is written after its sessions were cleaned up, when another
  `/pr-comment` command may already have run. A preview that another command
  adjusted, planned again or posted in that moment was still shown in its
  run's receipt as the preview to post. Such a run now ends with a receipt of
  a status of its own, `REPLACED`, which shows nothing of that preview,
  offers nothing and does not make its review the current one; the other
  command's receipt is the one to read. The terminal panel takes it for the
  end of that run, not for what happened last.

Conversations:

- OpenCode names a conversation when its own model first runs there, which an
  AZPR command never makes it do, so a conversation used only for reviews
  stayed "New session" in the session list. A check or a review now names a
  conversation nobody named after the PR its URL names, for example
  `AZPR: PR #123 (repository)`. The PR's own title is not used.
- A name that is there stays. OpenCode has no rename that applies only to an
  unnamed conversation, and nothing ties a rename it reports to the call
  that made it, so AZPR's own name gives way wherever it can tell and also
  where it cannot: it follows the renames the host reports, and a name that
  a person or OpenCode's model gives in the same moment is written back
  where AZPR's write may have replaced it. One conversation is named by one
  watch at a time; the watch stays open for a few seconds after AZPR's
  write, is not closed while a write is under way, and is ended properly
  when the plugin is unloaded. A host that reports no renames gets no name
  from AZPR. With debug records on, `conversation-name.json` says how naming
  ended. What this cannot rule out (a person who gives a name and then
  exactly the words AZPR wrote, both in that moment, keeps the name given
  first) is said in `docs/ARCHITECTURE.md`, "Authorization and isolation".

Setup:

- Without usable settings, OpenCode's command list described every review
  command as "AZPR setup required; run /pr-setup", also in a project
  directory that only needed a restart because the settings had been saved
  from another one. It now says "AZPR is not ready here; run /pr-setup to see
  what it needs", which holds for both, and `/pr-setup` says which it is.
- The settings list says what each model is for (`for /pr-review`,
  `for /pr-quick`, `for /pr-deep`). The dialog of the deep model says what
  makes one: a model stronger than the review model, or the same model with a
  higher variant, which reasons longer; `/pr-setup --help`, the **Deep
  models** rows of `/pr-check` and the settings schema say the same.
- "Settings file" in the list, and `/pr-setup --help`, name the section of
  the README that describes every setting, with its address:
  [all settings and defaults](README.md#all-settings-and-defaults).

Documentation:

- The README shows the result and a recording first, then the first review,
  and keeps its reference part in sections that are named in one table;
  detail that is looked up, not read through, is folded. The settings
  reference is no longer folded.
- The quickstart shows a recording of the setup dialogs, and the README the
  list of settings.
- A source installation has one more file, `src/tui-actions.mjs`: 36 in all
  for manual copying.

## 0.4.3 — 2026-11-18

`/pr-setup` sets AZPR up in OpenCode's terminal UI: dialogs ask for the
organization, a proxy if the network needs one, the token and a model, check
the token with Azure DevOps and save it in a file only you can read; a first
setup needs no restart. Afterwards the same command lists the settings to
change. And after a review, the next thing you say in the same conversation
no longer costs one model request per AZPR notice. The reviewer, verifier and
comment-planning instructions are those of 0.4.2, and no setting is new.

Setup in the terminal UI:

- Until now a first setup meant creating the PAT file by hand in a terminal,
  typing a model ID into `/pr-setup`, editing JSON for a proxy, and
  restarting the OpenCode service. In OpenCode's terminal UI, `/pr-setup`
  without options now opens dialogs for it: the organization (its name, or
  the URL of a pull request), a proxy, the token, and a model picked from
  OpenCode's list.
- The proxy is asked before the token, because the token is checked over the
  network; Enter skips it. After a proxy, the CA certificate file of a
  company that inspects HTTPS is asked the same way.
- The token is typed or pasted into a field that shows only how many
  characters it holds. AZPR asks Azure DevOps once whether it works for the
  organization and says what was refused: the token, the organization, or
  the way there. When Azure DevOps cannot be reached, the proxy or the CA
  file can be set right there and the same token tried again; it can also be
  saved unchecked.
- The token is saved alone in a file only you can read (mode 600), in one
  step: a file made for it, `${XDG_CONFIG_HOME:-~/.config}/azpr/pat-<organization>`
  (with a number where that name is taken), which the settings then name;
  or, for a new token of the same organization, the token file the settings
  name already. Setup overwrites no other file: the default PAT file of
  setup with options, `azpr/pat`, may be the PAT file of several settings
  files, so the dialogs only read it. The token is in no conversation,
  notice or log.
- With settings in place, `/pr-setup` lists them with their values:
  organization, token, proxy, CA certificate file, the review, quick and deep
  models, output language, what follows a review, the report in the
  conversation, progress notices, the review panel and debug records. A
  change is saved at once. Posting comments without a preview asks once
  more, with "no" first. The command palette has the list too ("AZPR:
  settings").
- A saved token belongs to the organization it was checked for: it is never
  sent to another one, and another organization in the list asks for a token
  of its own, which is checked and saved together with it, in a new file
  beside the first. The earlier token's file is left as it is, and AZPR says
  where it is.
- When AZPR has no usable settings, the terminal UI says so once after it
  starts and names `/pr-setup`.
- The dialogs only ask: the plugin's server part checks every answer, writes
  the two files, and is the only part that contacts Azure DevOps. Other
  clients, such as the desktop app, do not load the dialogs; there
  `/pr-setup` prints its instructions as before.

Setup, in every client:

- A first setup is loaded at once, with the dialogs and with options: the
  review commands work without a restart of the OpenCode service, in the
  project directory where setup ran. Another project directory that the same
  OpenCode service had already opened without settings still needs the
  restart, and its review commands say so. A change to settings that are in
  use takes effect after a restart as before, and `/pr-setup` says so.
- `/pr-setup` takes options that change one setting each in existing
  settings, without `--replace`: `--proxy`, `--ca-file`, `--review-model`,
  `--quick-model`, `--deep-model`, `--language`, `--after-review`, `--report`,
  `--progress`, `--panel` and `--debug`. They can be combined, also with the
  options of a first setup (`--proxy` behind a company proxy, for example).
  `/pr-setup --help` lists them.
- A source installation has one more file, `src/tui-setup.mjs`: 35 in all
  for manual copying.

Notices and the conversation's model:

- AZPR's notices (`STARTED`, `PROGRESS`, the receipts) wait in the
  conversation's inbox and start no response of its model. Until now, when
  you then prompted that conversation, OpenCode 2.3.0 answered your prompt
  and after it gave each waiting notice a turn of the conversation's model:
  a review with its comment preview leaves about eight notices, so about
  eight more requests, each carrying the whole conversation, and the model
  replied to each notice. The notices are now left in the inbox the way
  OpenCode leaves its own notices about background shells, and the
  conversation's model reads all of them together with your prompt, in one
  request. In the terminal fixture, a prompt after 16 notices made 17
  requests of the conversation's model before and makes 1 now.
- A notice that arrives while the conversation's model is working is handed
  to it at its next step, or in one request right after its answer; before,
  each such notice took a request of its own after the answer.
- The notices themselves, the panel and the report session are as in 0.4.2,
  and a conversation used only for AZPR's commands still costs no request of
  its model. The text of the notices still enters the conversation's context
  once, when its model next runs.

## 0.4.2 — 2026-11-17

A panel in OpenCode's terminal UI shows the report and the comment preview
rendered instead of as Markdown source, and lists the sessions of the review
so that you can open one. A PR that was completed or abandoned takes comments
like an active one, and a new version writes the settings it brings into your
settings file. The reviewer, verifier and comment-planning instructions are
those of 0.4.1. One setting is new: `terminalPanel`.

Terminal panel (OpenCode's terminal UI only):

- OpenCode shows what a plugin tells a conversation as plain text, so a report
  or a comment preview appeared as Markdown source. A panel beside the
  conversation now shows the newest one rendered: headings, emphasis, lists,
  code and tables. A check's table is shown there too.
- The panel lists the sessions of the review with their state while they run,
  and afterwards those that still exist, first the one that holds the report.
  A click opens the session in a tab. Until now a reviewer session had to be
  picked from OpenCode's session list.
- It opens by itself when a review or a comment run starts and when a report
  or preview arrives, in the conversation on screen, and leaves the keyboard
  with the prompt. `/pr-panel`, its only command, shows and hides it.
- New setting `terminalPanel`: `auto` (the default) as above; `manual` opens
  the panel only with `/pr-panel`. The panel reads no settings file, so the
  runtime sends this setting along with its notices, as metadata no model
  sees; with the default nothing is added to them.
- A click inside the panel gives it the keyboard: the arrow keys or `j` and
  `k`, Page Up and Page Down, Home and End scroll, and Escape or `q` closes it.
- In a terminal with fewer than 108 columns, where OpenCode shows a panel in
  place of the conversation, it does not open by itself and says that
  something is ready; `/pr-panel` shows it full screen.
- The panel only reads: AZPR's notices in the conversation, the report queued
  to the review's session, and which sessions belong to the run. It sends no
  prompt, starts nothing and posts nothing.
- A report or preview that a notice encloses is shown exactly as it was
  written, also when it quotes the tag that ends the notice's block. For
  that, text which already holds the escaped form of that tag
  (`&lt;/azpr_report_data&gt;`, `&lt;/azpr_comment_data&gt;`) is now enclosed
  with one more `&amp;`; the tag itself is written as before.
- Other OpenCode clients, such as the desktop app, do not load the panel and
  show AZPR's notices as before.

Comments on a PR that is no longer active:

- `/pr-comment --publish` refused a PR that was completed or abandoned
  (`INCOMPLETE`, "The PR is completed; nothing was posted"), so a PR merged
  before its review was commented on could be reviewed but not commented on.
  The PR's status no longer stops a publication, typed or automatic: such a
  PR takes the comments like an active one, and the receipt names the status
  (`Publication (VERIFIED=3); the PR is completed:`). A changed source commit
  is still refused (`STALE`), and nothing is posted twice.
- `/pr-check` no longer reports `NOT_READY` for such a PR: its `PR metadata`
  row is a WARNING that names the status.

Settings:

- A version that brings a new setting now writes it into your settings file,
  at its default, when OpenCode first loads that version. Until now only a
  source installation added new settings; a settings file of the native
  package kept what `/pr-setup` once wrote, and a new setting had to be
  looked up and typed in. The defaults written are the ones that applied
  anyway, so nothing changes in how AZPR behaves. Your values and their
  order stay, the file is written with two-space indentation and readable by
  its owner only (mode 600), and `/pr-check` lists what was added (a
  `Settings` row).
- The file is replaced as `/pr-setup` replaces it: atomically, owner-only and
  only when it is a regular file of your own in a directory no one else can
  write to. What you save in an editor at that moment is kept. A settings
  file that is a symbolic link, invalid or switched off (`enabled: false`) is
  left as it is; where settings are missing and could not be added, the
  `Settings` row of `/pr-check` is a WARNING that names them and the reason.
- A setup lock that a process left behind is now named: the message says
  which file to delete when no setup is running.
- `/pr-setup` writes every setting from the start, those it does not ask for
  at their defaults.
- Going back to an earlier version after 0.4.2 completed the file needs one
  edit: remove `terminalPanel`, which earlier versions refuse as an unknown
  setting.

Package:

- The package has a second entry, `./tui`, which OpenCode's terminal UI loads
  by itself when the plugin is active. Installing and upgrading are as before;
  the package still has no dependency and runs nothing at installation.
- OpenCode 2.3.0 does not compile the JSX of a package it installed (restored
  in OpenTUI 0.9.0, which OpenCode has not shipped yet), so the package
  carries the compiled view next to its source. Building it needs a
  development dependency in the repository only.
- A source installation copies two more files, `tui-model.mjs` and `tui.js`;
  the manual-copy list in the README has 34 files.

Documentation:

- The README's 15-second recording is a real review on OpenCode 2.3.0 with
  the panel beside the conversation; the
  [demonstration page](docs/DEMO.md#the-terminal-panel) says how it was made.
  The recording of adjusting findings before publishing stays on that page.
- The recording tools write a GIF with Pillow alone where no FFmpeg is
  installed, and the recording guide says what to look for in a cast before
  publishing frames of the panel.

## 0.4.1 — 2026-11-16

AZPR is tested with OpenCode 2.3.0 instead of 2.2.4, and two things that went
wrong on 2.3.0 are fixed. The same release also passed its host fixtures on
OpenCode 2.2.4, where `/pr-check` shows the OpenCode WARNING row. The
reviewer and verifier instructions are those of 0.4.0, and no setting is new.

OpenCode 2.3.0:

- A review no longer wakes your conversation's own model. OpenCode 2.3.0
  hands every answer of a child session to its parent and lets the parent's
  model respond to it. AZPR's private sessions were children of the
  conversation, so on 2.3.0 that model, with its edit and shell tools,
  received the reviewers' raw output and AZPR's notices and answered each
  one: 7 of the 12 model requests of a 2-file review in the test fixture.
  Private sessions are now sessions of their own, created where the
  conversation is. What the reviewers, the verifier and the comment planner
  are sent did not change.
- A model stream that breaks off mid-answer no longer fails the stage.
  OpenCode 2.3.0 retries the interrupted step by itself instead of asking the
  model to continue. AZPR did not recognise that and ran the stage again in a
  new session, and a second interruption failed it. It now takes the retried
  step's answer; the receipt counts such steps as `step-retries`.
- The inactivity watchdog, the retry of a provider 503, the refused background
  summary and the context-overflow split work on 2.3.0 as before.

Private sessions in the session list:

- OpenCode lists a session without a parent like a conversation, so AZPR's
  private sessions now appear next to your conversations, titled
  `[AZPR <id>] …`; a plugin cannot archive them. When a review ends, AZPR
  therefore deletes its sessions at once, except the one that holds the report
  or draft, which the receipt names. A comment run keeps none: its receipt
  carries the preview or the publication result. Until now a completed review
  kept all of its sessions until it was evicted. The kept session is deleted
  with its review, as before (the newest 20 are kept).
- A review's receipt says how many sessions were deleted (`Session notice`).
- While `debug.enabled` is on, every session is still kept until the review
  is evicted, so each review adds all of its sessions to the list. Turn debug
  off for everyday use; `deletePrivateSessions: false` keeps everything too.
- A review that an OpenCode restart interrupts leaves its sessions in the
  list: AZPR had not recorded them yet. Delete those yourself.
- A session whose deletion failed or timed out stays on record: it is
  deleted with its review, or, when no review keeps it, tried again after
  every later run and closed to AZPR commands meanwhile. Such a session used
  to be forgotten. A command typed in a session that is being deleted is
  refused. A session OpenCode creates only after its stage was cancelled is
  deleted when it arrives.
- A new review cannot be started from a saved review's own session, also after
  an OpenCode restart; until now only the running process refused that.
- Each private session carries `metadata.azpr` with its run, role and
  conversation (and, for a comment run, the review), so tools that list
  sessions can tell AZPR's sessions from conversations without reading titles.

Tools:

- A reviewer's tool call that OpenCode stops ends at once instead of when its
  Azure DevOps request returns. The request only that call waits for (a folder
  listing of one level, the PR's threads) is aborted; a file, a recursive
  listing or the repository archive, which the run's other sessions may be
  waiting for too, is still read to the end and kept for them.

Documentation:

- A model entry that lets the provider choose the model for each session,
  such as GitHub Copilot's Auto in OpenCode 2.2.7 and later, cannot be an AZPR
  model: AZPR refuses a request on another model than the configured one, and
  `/pr-check` does not detect such an entry.
- While a provider's host cannot be reached, OpenCode 2.3.0 retries the
  request for up to an hour. AZPR allows those retries, so a review waits
  instead of failing; `/pr-stop` ends it.

## 0.4.0 — 2026-11-14

Two defaults change. They apply where a settings file does not name the
setting, as in the file `/pr-setup` writes; a file that names it, as one
installed with `install.sh` does, keeps its values.

- A comment preview now follows every COMPLETE review: `afterReview` is
  `preview` for each mode (it was `none`). The preview is planned with a model
  and posts nothing. Add `--no-comment` after the PR URL for a review without
  one, or set `afterReview` to `none`. Publication is still never a default.
- `workflow.parallelSessions` is 8 (was 4) and `azure.concurrency` is 6 (was
  3). They matter for a PR of more than one shard. Lower `parallelSessions`
  when your provider limits the request rate, or with OpenCode's claude-agent
  provider on a machine with little memory.

Commands:

- No `/pr-comment` command needs a review ID any more: `--exclude`,
  `--severity` and `--reset` act on the conversation's current review, as
  `--publish` and `--show` already did. The current review is the one that was
  completed or used there last, so naming a review by its ID once makes it the
  current one; in one of a review's own sessions it is that review.
- The start notice and the receipt of every comment run name the review and
  its PR, for example `Acted on review 1a2b3c4d (/pr-review) of PR #123 in
  project/repository`.
- A preview's receipt ends with the commands for the next step, without the
  review ID and with that review's finding IDs. Each adjustment list replaces
  the saved one, so an example keeps the adjustments already saved.
- New `/pr-comment --list`: the reviews saved for the conversation, with their
  IDs, PRs and state. No model or Azure DevOps request.
- Every command answers `--help` (or `-h`) with its usage and examples,
  without a model or Azure DevOps request.
- Command descriptions start with what the command is for and point to
  `--help`: OpenCode's command list shows one line of a description and cuts
  what does not fit.
- A review's receipt lists the comment commands without the ID first and keeps
  the ID form for acting on that review later.

Reports:

- A review that ran without content search says so. When the repository
  archive is larger than `azure.archiveMegabytes` allows, or is one AZPR cannot
  read (ZIP64, encrypted, damaged), `azpr_search_code` answers that search is
  unavailable; until now only the models saw that. The report's limitations
  and the receipt (`Content search notice`) state that sessions could find and
  read files but not search their contents, and name the setting's value where
  a larger one would help. The debug record's `result.json` lists the reasons
  under `searchUnavailable`.
- A verifier that confirms a finding whose suggestion is only a placeholder
  ("N/A", "No correction needed.") is asked in the same session to state the
  correction or to reject the finding. Left as it is after the correction
  turns, the finding is NEEDS_INFO: it stays in the report and gets no comment.

Documentation:

- The README's examples show several finding IDs in one list
  (`--exclude F-1,R-2`), and the `afterReview` row of the settings table has
  one value per line.
- The roadmap no longer lists three changes as planned that the work on 0.3.7
  examined and dropped, and says why. The README states what a smaller model
  in `models.review` costs in issues found.
- The instructions for reviewers and verifiers are unchanged, and an
  installation has the same set of files as 0.3.7. See
  [validation](docs/VALIDATION.md#040-release-candidate-acceptance-2026-11-14).

## 0.3.7 — 2026-11-12

- A change that breaks something that worked before is at least medium: an
  input, configuration or call that the base commit handled and that now fails
  or gives a wrong result, however rarely it is used. Documented steps that
  worked before the change and fail after it count as such a regression, even
  though the failure shows at once, and a question about intent is medium
  instead of low when the behavior stops something that worked. An easy fix
  and an effect the reviewer could not confirm are no longer reasons for a
  lower severity.
- The verifier no longer sees the reviewer's severity: candidates reach it
  without one, and it sets each finding's level from what it verified.
- New optional setting `models.review.rater` / `models.deep.rater`: a model
  for a **severity rating**. After verification, a session without tools reads
  the confirmed findings as they will be reported, 25 at a time, and sets each
  one's final severity; a finding it does not rate keeps the verifier's. Left
  out or empty, no rating runs and the verifier's severity is final. It is
  meant for a rater stronger than the reviewers' model.
- A finding states one defect. A second defect a reviewer notices on the way
  becomes its own finding instead of a clause in another one's evidence, and a
  merge in verification no longer drops a defect that only the merged finding
  named.
- Before asking whether the author meant a behavior, a reviewer looks for a
  statement of that intent in the tests, the comments and documents beside the
  code, the PR description and the commit messages.
- Before answering, a reviewer makes the read that would settle a suspicion.
- NEEDS_INFO is for behavior the verifier could not establish. A verified
  behavior that only the author, or a specification outside the repository, can
  call intended is confirmed as a question to the author instead.
- The reviewer rules above apply in every review mode. `/pr-quick` keeps its
  flow: no verifier, no rating, and the reviewer's severity.
- A source installation copies one more file, `src/prompts/rating.md` (32
  files). Upgrading with `install.sh --replace` adds the empty `rater` settings
  and changes nothing else in `settings.json`.
- The changes were run with `/pr-deep` and `/pr-review` on the ReviewBench test
  set before release, and ReviewBench's judging pipeline scored the Claude
  Opus 5.5 run; see
  [validation](docs/VALIDATION.md#severity-from-verified-harm-2026-11-11-and-12).

## 0.3.6 — 2026-11-10

- Reviewers file a correctness or security defect on lines the PR adds or
  moves even when the base commit had the same code elsewhere, such as a
  function moved to a new file, and say in the finding that the PR carries it
  over.
- A possible intention no longer keeps a defect out of the findings. Behavior
  that is wrong only if the author did not mean it, with nothing in the code,
  tests, documentation or PR text showing whether they did, is a low finding
  whose summary asks whether the author meant it, so the question also reaches
  the summary index, and whose suggested fix asks them to confirm or document
  the intent.
  Neither a possible intention nor identical base code is a reason for the
  verifier to reject a finding. Both reviewer rules apply in every review mode;
  `/pr-quick` has no verifier.
- Both changes were measured before and after with `/pr-deep` on Martian's
  Code Review Bench, which the wording was written from, and on the
  ReviewBench test set, which was not used to write it; see
  [validation](docs/VALIDATION.md#defects-in-moved-code-and-unknown-intent-2026-11-09).

## 0.3.5 — 2026-11-04

- A finding's severity says how much it matters to fix it before the change
  merges: high must be fixed before merging, medium should be fixed in this
  change and low can wait. Reviewers judge it from the harm their evidence
  shows and how often realistic use reaches it, not from their confidence, the
  size of the fix or the kind of issue. High is for realistic use that leaves a
  core function or what the change is for not working, or that causes a
  security breach, lost, corrupted or exposed data, or silently wrong results.
  A rare trigger lowers a finding's severity instead of keeping it out of the
  findings.
- Concrete gaps are rated by their effect instead of usually low: a document or
  example by what following it does, shipped configuration like code, and a
  missing or ineffective test low unless the test is what the change delivers.
  A missing test that hides a defect in the change is reported as that defect,
  with its own severity, and the test is named in its suggested fix.
- The verifier sets each confirmed finding's severity from the harm and trigger
  it verified and may raise or lower the reviewer's, giving the reason.
  `/pr-quick` uses the same scale. Publication is unchanged: high and medium
  findings get inline comments, and low ones stay in the summary index.
- The reviewer instructions state each shared rule once, and the shared tool
  guidance leaves what each tool returns to the tools' own descriptions.
- In a self-judged comparison on the public ReviewBench test set, `/pr-deep`
  with gpt-6.1-sol labeled many more of the issues the judges rated high as
  high, with about the same share of its high labels rated high by the judges,
  and labeled fewer findings that deserve an inline comment as low. What
  reviews found and the share of findings judged valid stayed within the
  variation between runs of the same instructions; `/pr-review` with
  gpt-6-luna stayed within its larger variation. The
  [validation record](docs/VALIDATION.md) describes the method and its limits.

## 0.3.4 — 2026-11-02

- Reviewers file concrete gaps as findings, usually low: a changed or added
  behavior that no test would catch where the project already tests comparable
  code, a test that cannot fail or checks the wrong thing, a comment, document,
  example, schema or configuration that now contradicts the code, and
  duplicated, dead, misleading or inconsistent code the change introduces.
  Design trade-offs and general advice without a specific defect or location
  stay in the report and the summary's improvement suggestions. Low findings
  stay in the summary index, as before.
- A mistake repeated in places that each need their own correction, such as
  parallel routes or handlers that make the same wrong call, is one finding per
  place, each at its own lines with the sibling places in its evidence, and
  reviewers check their other assigned files for the same mistake. Identical
  copies of one file among one reviewer's assigned files count as one place;
  copies that a large PR's shards give to different reviewers can each produce
  a finding. One wrong piece of shared code stays one finding at that code.
  `/pr-quick` follows the same rule.
- In a self-judged before-and-after comparison on the public ReviewBench test
  set, `/pr-deep` with gpt-6.1-sol matched more of the high- and
  medium-severity reference issues, including high ones, with more findings,
  mostly low, and somewhat longer reviews; the share of findings judged valid
  stayed about the same. `/pr-review` with gpt-6-luna matched slightly more,
  within the variation between runs. The
  [validation record](docs/VALIDATION.md) describes the method and its limits.

## 0.3.3 — 2026-10-31

- AZPR is tested with OpenCode 2.2.4 instead of 2.1.4. The runtime needed no
  change: on both hosts the same review sends byte-identical model requests.
  Upgrading OpenCode migrates its database irreversibly; stop the service and
  back up `opencode.db` first.
- `/pr-check` names the OpenCode version in a row of its own and warns when it
  is not the tested one; reviews still run. Receipts no longer end with a
  host notice.
- A used-up usage or spend limit stops the stage at once: AZPR refuses
  OpenCode's retries and starts no new session, and the receipt names the
  limit. This covers OpenCode 2.2.3's ChatGPT and OpenCode Go usage limits and
  OpenCode's spend limits besides the provider quota and the free-model limit;
  before, a used-up ChatGPT limit was retried as a rate limit.
- AZPR subscribes only to the session events that show a review progressing;
  OpenCode 2.2.0 and later deliver no others.
- On OpenCode 2.2.4, `NO_PROXY` always lists `127.0.0.1`, `localhost` and
  `::1`, and Bun honours `NO_PROXY` even for `azure.proxy`. Azure DevOps is
  unaffected; the company-network guide now says to keep `dev.azure.com` out of
  `NO_PROXY` when it must use the proxy. Test-only Azure DevOps base URLs may
  use any 127.0.0.0/8 address, so the proxy scenario can still be tested.
- The host smoke test adds a foreign MCP server behind CodeMode and an image
  model, and checks that private reviewers see neither those tools nor image
  generation while ordinary sessions keep them.

## 0.3.2 — 2026-10-30

- The README starts with actual Azure DevOps output: an inline comment with its
  code context and, in an expandable section, the complete PR summary from the
  same review. The first-review steps come before the 15-second recording, and
  a documentation table points to the guide for each task. The demo records how
  the screenshots were captured and edited, and lists the pictured comment
  bodies as text.
- Receipts say that COMPLETE means no source-commit change was detected. A
  final version recheck that fails adds a warning and leaves the review
  COMPLETE; publication still rechecks the PR before posting.
- The npm package contains only the runtime, README, changelog and license:
  32 files and about 170 KB instead of 76 files and 1.35 MB. Documentation,
  media, installers, the settings example and schema and the repository guides
  remain in the repository and the source archive; npmjs.com shows the
  README's links and images from GitHub.
- The README and architecture guide list the commands that answer without a
  background run, the README and commenting guide state that repeating the
  saved adjustments plans nothing, and the architecture guide counts AZPR's
  six tools.

## 0.3.1 — 2026-10-27

- Installation and upgrades are documented as they behave on OpenCode 2.1.4:
  `opencode plugin add` loads the plugin into a running service without a
  restart, and adding a second version leaves the first one running. The
  README's new Upgrading section adds the new version and removes the
  previous one only when the download succeeded. Saved settings still need a
  restart, and every message that asks for one names `opencode service restart`.
- `/pr-check` names the installation that answered and warns when another
  AZPR entry is configured but not running, such as a second version that
  OpenCode lists as a duplicate plugin ID. User names, passwords and query
  strings in package specifications are masked.
- `/pr-setup` takes the organization from a PR or organization URL and,
  without `--pat-file`, uses `${XDG_CONFIG_HOME:-~/.config}/azpr/pat` (or, with
  `--replace`, the PAT file already set); its receipt names both.
- The quickstart runs the terminal steps first and needs one restart. The team
  guide separates package downloads, model providers and Azure DevOps on
  company networks, and the Azure DevOps guide names the actual settings
  locations. Two links in the validation history now point at the version
  that still had their sections.

## 0.3.0 — 2026-10-26

- Choose what reaches the PR after reading a preview:
  `/pr-comment <review-id> --exclude F-1,F-2` leaves findings out, and
  `--severity F-3=low` changes their publication severity. Each option replaces
  its own saved list (`none` clears it); `--reset` clears both. The model plans
  a new preview without rerunning the review, and the original findings and
  report stay unchanged. A severity change does not verify a finding again.
- `/pr-comment [review-id] --show` displays the saved preview without calling
  a model or Azure DevOps. Excluding every finding plans and posts nothing.
- Adjustments and the invalidation of the earlier preview are saved together.
  A failed save reports failure and changes nothing; a new preview whose save
  fails is dropped. A review adjusted once, including one reset since, can be
  published only from a saved preview planned after its latest adjustment.
  Once publication starts, adjustments and re-planning are refused.
- The final preview is checked for excluded finding IDs, including summary
  rows rendered from retained findings. An unresolved reference holds
  publication. Existing PR comments are never edited; for an adjusted review,
  the receipt names those whose text differs from the new preview, including
  comments that appear only when AZPR reads the threads back.
- The README leads with control over published comments and a real OpenCode
  2.1.4 recording of adjusting findings and publishing; the first-review
  example and quickstart cover adjustments, the new preview and publication.
  The npm package, Git installation and source archive advance to 0.3.0. The
  package description mentions adjusting previews, and the npm package now
  includes the code of conduct that its README and contributing guide link to.
- CI actions are pinned by commit and updated with Dependabot. Validation
  starts with a summary and records the known limits of the review evidence.

## 0.2.3 — 2026-10-24

- The tested host is OpenCode CLI 2.1.4. OpenCode 2.1.3 and later embed Bun
  1.4.4, which reports a proxy that refuses the CONNECT tunnel as an
  `ERR_PROXY_TUNNEL` error instead of returning the proxy's answer. AZPR maps
  it to the earlier messages and retry rules: a missing proxy password is again
  explained as HTTP 407 without retries, and a refused tunnel never leaves a
  comment write uncertain.
- Azure DevOps calls keep the configured `azure.callTimeoutSeconds`. The
  runtime's fetch gave up on a silent request after about six minutes by
  itself, so a longer setting ended early with a retried network error.
- With OpenCode's opt-in `experimental.background_compaction`, a refused
  background summary no longer turns a later failure into a context-overflow
  split. A permanent error such as HTTP 401 stops the stage without new
  sessions, and a failed follow-up keeps the answer it followed.
- The README states that AZPR is an independent community project, not built
  by or affiliated with the OpenCode team.
- A fifth exact-host fixture covers background compaction followed by a
  permanent failure; CI runs it.

## 0.2.2 — 2026-10-23

- The README leads with reviewing Azure DevOps PRs from a URL without a local
  checkout, then explains source lookup, model choices, verification, comment
  control and corporate connection settings with their limits.
- The README and quickstart use the same first-review workflow:
  `/pr-review <PR URL> --preview`. Quick review remains an explicit lighter
  alternative, with model-request and cost guidance.
- Compatibility explicitly excludes OpenCode 1.x without implying a separate
  maintained AZPR product line. Detailed references remain folded with visible
  navigation targets, and the archive-limit link points to the relevant guide.
- The Azure Code Search description correctly distinguishes indexed branches
  from AZPR's searches at a selected commit.
- The npm package description reflects the URL-based workflow, and the
  `opencode-v2` keyword identifies its plugin API target.
- No runtime, prompt, settings or installation behavior change.

## 0.2.1 — 2026-10-23

- AZPR is published to the npm registry as `opencode-azure-devops-pr-review`:
  `opencode plugin add opencode-azure-devops-pr-review@0.2.1`. The versioned
  Git package and the source archive remain available with the same runtime,
  and npm and Git installations read the same external settings.
- The README shows CI, npm, license and tested-host badges. Installation and
  upgrade instructions cover the npm package, the Git package and moving from
  Git to npm.
- `tests/host-v2-smoke.mjs --native --package SPEC` runs the native fixture
  against a published package after a release.
- The repository adopts the Contributor Covenant 2.1 as its code of conduct,
  with an address for reports.
- No runtime, prompt or settings change.

## 0.2.0 — 2026-10-23

- `afterReview` sets, per mode (`quick`, `review`, `deep`), what follows a
  COMPLETE review: `none` (default, as before), `preview` or `publish`. The
  step runs as a separate comment command with its own run ID, `STARTED`
  notice and receipt, and `/pr-stop` stops it. A review without findings to
  comment on gets one notice and no planning or model request; a busy
  conversation or PR skips the step and names the command to run; a review
  stopped while its report is delivered stays COMPLETE but starts no step.
- One flag right after the PR URL of `/pr-review`, `/pr-deep` or `/pr-quick`
  (`--preview`, `--publish` or `--no-comment`) overrides `afterReview` for that
  run. Other option-like text there is refused, so a mistyped flag never falls
  back to the setting; `/pr-check` takes no flag.
- Automatic publication posts item by item. A comment whose text has an
  `@<…>` mention, an image, HTML that embeds content, runs a script or hides
  text (attributes read as a browser reads a tag), or a
  `javascript:`, `vbscript:`, `data:` or `file://` link (mentions and script
  links also when written with escapes or character references, script links
  also with a tab or line break inside) waits in the
  saved preview for a person, and the receipt names it; the other items are
  posted. Ordinary links, markup in examples and literal code (fenced code
  blocks and code spans, where the Markdown can be read only one way) are
  posted; mentions are checked in code too. A quick
  review's comments are posted with their "not independently verified"
  disclosure, also a high-severity finding or incomplete coverage (named in
  the summary); the verification hint is advisory. When every finding is
  already discussed on the PR, nothing new is posted (`NOTHING_TO_POST`), so
  re-reviewing an unchanged PR does not add a summary each time.
- The automatic-publication HTML checks read long tag-like text in linear
  time, avoiding repeated scans that could delay the plugin on large comments.
- `/pr-check` shows the `afterReview` of each mode and, for modes that publish
  automatically, who posts.
- `/pr-setup` and the blocked review commands name the settings problem found
  at load, without any setting value; an unknown settings key is named only
  when it looks like a setting name.

## 0.1.0 — 2026-10-22

First public release.

- Azure DevOps Services PR reviews in OpenCode V2, using repository content at
  exact commits and runtime-owned REST access.
- Quick reviews with one reviewer per shard, and review/deep modes with
  functional and risk reviewers followed by independent verification. Deep runs
  the same review with the stronger models of `models.deep`; `/pr-check` says
  when they are unset or repeat the review models.
- Bounded shards, context-overflow splitting, correction turns, transient
  retries (never for a used-up provider quota or free-model limit),
  cancellation and visible coverage gaps.
- Comment previews, explicit publication, stable duplicate markers and
  read-back of posted comments. Quick comments disclose that they were not
  independently verified. A comment someone deletes on the PR is reported as
  `DELETED` and not posted again.
- Two comment-planning pages at a time, with deterministic page-order assembly.
- Persistent private reports and publication records, plus Azure proxy and
  additional CA configuration.
- The PAT can live alone in an owner-only file (`azure.patFile`), so
  `settings.json` holds no secret; Code (Read) and Pull Request Threads
  (Read & write) are confirmed to cover every call AZPR makes.
- Native installation through OpenCode's Git package manager, with configuration
  outside the package cache and an explicit `options.settingsFile` override.
- `/pr-setup` validates one model and an existing PAT file and saves owner-only
  settings without a model or Azure request. Existing source installations and
  advanced settings remain supported.
- A first-review quickstart, real recorded demonstration, compatibility table,
  team data-handling guide, contribution guide and private vulnerability reporting.

The tested target is OpenCode CLI 2.1.2 on Ubuntu 22.04, with Azure DevOps
Services REST API 7.1. See [validation](docs/VALIDATION.md) for the distinction
between offline tests, host fixtures and live runs, including remaining gaps.
