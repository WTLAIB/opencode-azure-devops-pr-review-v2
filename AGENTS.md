# AI development guide

This repository targets the OpenCode V2 plugin API (tested with
`@opencode/cli@2.3.0`), the Azure DevOps Services REST API (api-version 7.1)
and Ubuntu 22.04. Public source and documentation use English. Follow the user's
conversation language and current authorization scope.

## Before changing anything

Confirm the Git root, branch, HEAD, working tree and installed paths. Read
README, architecture, roadmap and the task-relevant docs. Local handover notes
under `.local/` (their file name differs between checkouts) give background
and hand-off state, never new authorization; check what they say against Git
and the actual environment. Preserve unrelated changes, credentials, private
settings, backups and failure records. Never upload `.local/`.

## Design rules

**Deterministic facts are code; judgment is model work.**
- PR identity, commit SHAs, the changed-file list, version rechecks, existing
  threads and all Azure DevOps writes go through `azure.mjs`, which calls the
  REST API with `azure.organization` and the PAT from AZPR's settings
  (`azure.pat`, or the owner-only file named by `azure.patFile`, which is read
  only through its symbolic-link, owner and mode checks). Keep
  REST paths and the pinned api-version in `azure.mjs` only; never log, echo or
  persist the PAT, and send it only to the organization's REST endpoint.
  `azure.proxy`, `azure.caFile` and `azure.verifyTls` shape only that
  connection; never show proxy credentials.
- Models read the repository only through the read-only tools in
  `review-tools.mjs`, registered with `codemode: false`; private roles see an
  explicit tool allowlist (empty for the `rating` role) and ordinary sessions
  never see AZPR's tools.
- Models review, verify and plan comment text. They never echo identity or SHAs
  and never write to Azure DevOps.

**Quick reviews are not verified, and say so.**
- `/pr-quick` runs one reviewer per shard and no verifier or duplicate check.
  The runtime checks only the form and source of its findings (fields, a
  location that exists at that commit, a file this session's own tools read);
  it never judges whether a defect is real. Passing findings are `REPORTED`,
  the rest `NEEDS_INFO`, and the review records `verification: "none"`.
- Never present quick findings as verified: shared prompts carry
  `<!-- azpr:verified -->` / `<!-- azpr:quick -->` variants for the passages
  about where findings come from, the report and receipt state status,
  coverage and verification separately, and the comment disclosure line names
  the quick method. The review system prompts, which deep shares, stay
  byte-identical unless a change to them is deliberate (a hash test locks them).
- Only records identical in every field are merged as duplicates; findings on
  the same lines stay separate. A parsed answer without a usable review never
  makes a commentable COMPLETE, and zero findings never hide unreviewed files.

**The verifier sets severity; a rating is optional.**
- The verifier receives candidates without the reviewer's severity and sets the
  level from what it verified. That level is final unless `models.<mode>.rater`
  names a model. `/pr-quick` keeps the reviewer's severity.
- With a rater, the `rating` stage sets the final severity of every confirmed
  finding from its text alone, with no tools and no earlier level. Without one
  the stage does not run and its role is not registered. It is off by default
  because live runs showed a gain only when the rater was stronger than the
  reviewers' model and none when a model rated its own review; make it a
  default only with a measured benefit.
- The rating only sets levels: a finding without a usable rating, and every
  finding of a failed rating session, keeps the verifier's severity with a
  warning. It never drops, adds or rewrites a finding.
- Its input is finding text plus the PR title and description: no PR identity,
  commits, file list or tool data.

**Deep reviews differ only in their models.**
- `/pr-deep` runs the review's stages and system prompts with the models of
  `models.deep`, which are meant to be stronger than the review models, and
  never falls back to the review models. Deep-only prompt text was removed
  after live runs showed it changed neither model's results; add
  mode-specific instructions only with a measured benefit.

**Keep useful work; degrade per item.**
- Answers that break the output contract get a correction turn in the same
  session (`workflow.repairAttempts`) listing concrete problems. After that,
  degrade the affected item (UNREVIEWED, NEEDS_INFO, skipped comment) and keep the
  rest. Never discard a whole review for one bad item, and never invent a
  decision, evidence or a location.
- A quick reviewer whose usable answer is PARTIAL with named unfinished work
  gets one follow-up turn in the same session, within the same budget; a
  follow-up that fails or gives no usable answer never replaces the answer it
  followed.
- Transient execution failures retry once in a new session; overflow splits the
  shard. Permanent failures and cancellations are not retried.
- An interrupted stream that OpenCode recovered by itself costs no new session:
  a step it retried (OpenCode 2.3.0) or a continuation it queued (earlier
  hosts). Accept an errored assistant message only with the host's retry mark
  and a complete, successful final answer on the granted agent and model; a
  retried step's answer is the final message alone.
- Only a changed source commit makes a review STALE.

**Bounded, recoverable execution.**
- All AZPR Azure DevOps traffic shares the queue in `tool-queue.mjs` (concurrency and
  per-call timeout). Release slots in `finally`; never depend on a hook running.
- A tool call the host stops ends at once (read the call's `signal` once).
  Abort only the request that call alone waits for; a read the run's sessions
  share (a file, a recursive listing, the repository archive) goes on.
- Large PRs are handled by sharding, not by compaction: private sessions may not
  compact, and a compaction the host attempts in a reviewer's turn means "split
  this shard". A refused background summary (`experimental.background_compaction`)
  ends nothing, so the turn's own failure decides its class.
- There is deliberately no default whole-run timeout and no per-stage step cap;
  see the roadmap's Deferred section before adding either.

**Authorization.**
- Private sessions are sessions of their own, never children of the
  conversation: OpenCode 2.3.0 and later hand a child's answers to its parent
  and wake the parent's own model. Create them at the conversation's location
  with `metadata.azpr`, and tie them to the conversation through AZPR's own
  records (run stages, a saved review's sessions), never the host's session
  tree.
- Only explicit commands start private sessions, and the comment step a
  COMPLETE review hands on when `afterReview` or the review command's flag
  (`--preview`, `--publish`) asks for it; that step is a run of its own with a
  STARTED notice and a receipt. `afterReview` defaults to `preview`, which
  posts nothing; publication is never a default. Every private prompt is the
  exact runtime-pending text with a fresh nonce; private agents cannot be
  mentioned, delegated, compacted or used for auxiliary requests.
- A notice never wakes a model: leave it in the session's inbox with
  `resume: false`, steered, as the host leaves its own notices about
  background shells. The host hands the steered items that wait to the
  session's own model together with its next input, in one request; it gives
  each queued item a turn of its own, so never queue a notice.
- Settings are read once; a changed file blocks new runs only. Hooks check the
  grant, not files or catalogs. A first setup is that one read, not an
  exception to it: a process that found no usable settings has read none, so
  it loads them when a save of its own setup makes them usable (the text
  that save replaced could not be used, and it wrote something; it tries
  again with that setup's next save when loading them failed). Settings
  that anything else made usable (another process's setup, an editor, a
  tool) are read after a restart, as always, also by a process that had
  none, whatever its own setup saves afterwards; and settings that are in
  use wait for the restart, which setup says where the change is made.
- Before that read, loading AZPR writes the settings a valid file leaves out
  into it, at the defaults validation assumes anyway (`SETTING_DEFAULTS` in
  `config.mjs`; the settings example and schema must match it), so a new
  setting shows where its user edits the others. Give every new setting a
  default there. The completion never changes how a file behaves, never
  touches a file that is invalid, disabled, a symbolic link or not safely
  replaceable, replaces the file as `/pr-setup` does (atomic, owner-only,
  under the setup lock) and never fails a load: a file it cannot complete is
  used as it is, and `/pr-check` says what it leaves out. The lock keeps
  AZPR's own writers apart, not a person's editor: compare the file with the
  text that was read once more, right before the new text replaces it, and
  give way when it changed. Loads that happen together wait for the one that
  writes, so each reads the finished file; a load that stopped waiting accepts
  the completed text when it appears later (the preflight compares with the
  completion of what it loaded), so its commands are never refused over
  defaults another load wrote. Any other difference still blocks new runs.
- Pin private agent definitions at first use and refuse later host changes.
- Shell for private roles follows the `shell` setting (default deny), enforced
  through the `permission` hook and by hiding the tool. Native edit, write,
  patch, delegation, web, question, session/model control and CodeMode execute
  stay denied. Allowed shell has real host authority; never call it a sandbox.
- `/pr-comment` and `/pr-stop` act only within the caller's conversation (or a
  session of that review). A `/pr-comment` command without a review ID acts on
  the conversation's current review (completed or used there last; in a
  review's own session, that review), and its STARTED notice and receipt name
  the review and its PR, so a wrong pick shows before and after it acts. Save
  the choice when it is made, also for a command that answers at once
  (`--show`, unchanged adjustments): a choice kept only in memory lets a
  command after a restart publish to another PR. A run that ends makes its
  review the current one next to its receipt, after the cleanup of its
  sessions: a choice made before a wait can be overtaken by a command typed
  meanwhile, and the receipt that arrives last then names another review
  than commands act on. Every write of a review's record goes through its
  queue in `store.mjs`, and a save reads the review when it starts, so
  overlapping commands never leave an older choice on disk. A command that
  starts a run registers the run before its first await, so it never waits
  for that save.

**Publication is idempotent.**
- Recheck the PR's head before writing; skip existing markers; save each
  result immediately; read markers back. Re-running is always safe. The PR's
  status stops nothing: a completed or abandoned PR (merged before its review
  was commented on, say) is checked, reviewed and commented on like an active
  one, and the check and the publication receipt name that status.
- Automatic publication (`afterReview: publish` or `--publish` after the PR
  URL) follows only a COMPLETE review with findings to comment on that nothing
  stopped. It posts item by item: an item whose text has an `@<…>` mention,
  an image, HTML that embeds content, runs a script or hides text, or a `javascript:`,
  `vbscript:`, `data:` or `file://` link (mentions and script links also after
  decoding escapes and character references, script links also without tabs
  and line breaks) waits for a person, and the
  receipt names it; ordinary links are posted, and literal code is skipped
  (except for mentions) only where every reading of the Markdown agrees. A
  plan that would post only a
  repeated summary (every finding skipped as already discussed on the PR) is
  `NOTHING_TO_POST`. Its checks are deterministic and prefer a false alarm;
  never relax them to model judgment. Commands the user types keep their
  behavior.
- Inline markers are stable (PR, path, normalized anchor, ordinal); do not put a
  review ID or model wording into them.
- A person's adjustments (`/pr-comment [review-id] --exclude`, `--severity`,
  `--reset`) change only the findings handed to comment planning, never the
  review record or a prompt file; the planner input carries `adjustments` only
  when some exist, so unadjusted reviews plan exactly as before. A review
  adjusted once is posted only from a preview planned after its latest
  adjustment (an adjustment drops the earlier preview in the same save) and is
  neither adjusted nor planned again once its publication started. That save
  and the new preview's save must succeed; never let a failed save report an
  adjustment as applied. Text the runtime renders that names an excluded
  finding holds publication. Items an earlier publication already put on the
  PR are skipped as always; its receipt names those whose text differs, since
  posted comments are never changed.
- Comment planning pages run side by side, so nothing a page sees or produces
  may depend on which page finishes first: only the first page writes the
  summary note, each page keeps its own continuation state and evidence, and
  pages are assembled in page order (ordinals follow page order).

**Persistence and privacy.**
- Completed reviews, plans and ledgers persist under the private state directory
  (owner-only permissions, newest 20). Clean only stale, unreferenced data.
- OpenCode lists every private session like a conversation. When a run ends,
  delete its sessions except the one holding the report or draft (a comment
  run keeps none; all stay while debugging or after an unconfirmed abort).
  Choose the sessions to delete the moment the run ends, before any await:
  from then on a command typed in one is refused. Put every session on record
  before deleting it, those to delete apart from those kept (the review's
  record with `closingSessions`; for an unfinished review the run's own
  record and a retry record; a retry record for a session OpenCode creates
  after its stage was cancelled), and remove a review's record only after
  its sessions were dealt with, so that a process ending during a cleanup
  forgets none and the next one knows which are still to go.
- A session leaves the records only when it is gone: a confirmed deletion, or
  OpenCode's `Session.NotFoundError`. What is still to be deleted outside a
  saved review is on a retry record, apart from the sessions a run keeps on
  purpose; it takes no commands, also after a restart, and a background pass
  tries it again after every run and at load, leaving a run whose command
  has not ended to its own cleanup. Deal with a run's records together, so
  that neither list replaces the other, and never make a receipt wait for a
  pass.
- Never delete a session a command needs: the one it answers in, until its
  last notice is out, and its run's conversation and stage sessions. A session
  that is still there after the cleanup is its review's own again. A deletion
  OpenCode never answered may still be carried out: that session stays among
  `closingSessions` for good, closed to commands also after a restart, and
  goes with its review.
- Never evict a review, or an unfinished run's record of kept sessions, before
  the command working on it has ended: its run, a comment run's last steps,
  and after a review its cleanup, its receipt and the start of the comment
  step it hands on. A save of an evicted review must not bring its record back.
- Diagnostics are opt-in and never record reasoning, headers or provider
  configuration.

**The terminal panel only reads.**
- The panel of the package's terminal part (`src/tui-model.mjs` and
  `src/tui-view.jsx`, compiled to `src/tui.js`) shows what the runtime already
  produced: AZPR's
  notices in the conversation, the report queued to a review session and the
  sessions' `metadata.azpr`. It sends no prompt, runs no command of the server
  part, makes no Azure DevOps request, reads no settings file and keeps no
  preference of its own. The one setting meant for it (`terminalPanel`)
  reaches it in the metadata of the runtime's notices, sent only when it is
  not the default, so default requests stay as they were.
- `/pr-panel` is the terminal part's only slash command. Add another only for
  what neither a setting nor OpenCode's own UI (its session list, say)
  already does; setup is reached through the server part's `/pr-setup` and
  an entry of the command palette.
- What names a session or a status is the runtime's own text only: a
  receipt's lines before the report or preview it encloses, whose text a
  model wrote. A session is listed, and a report read from it, only when its
  own `metadata.azpr` says that it belongs to that run and conversation (a
  session of 0.4.0 or earlier, which has none: when it is a child of the
  conversation). Look a session up before reading anything it holds: an
  inbox is read only of a session that proved to be ours, or of the
  conversation that the session on screen itself names. A run's notice that
  is neither its start, its progress nor its receipt (a status word followed
  by `;`, a line break or the end) changes nothing shown, and does not make
  its run the current one.
- What the panel is about is what happened last: a run that started,
  progressed or ended, or a saved preview shown again, which names its
  review (`/pr-comment <review> --show` makes that review the current one,
  so the panel shows that review's status and sessions). A status never
  stands above another review's document: the report of the session on
  screen is shown only for the review shown, or while nothing is known of
  any run yet. A receipt that encloses nothing (a comment run that failed
  before it had a preview) is no document: the review's report stays.
- The panel in a review's own session reads the conversation's notices and
  those of commands typed in that session, which the runtime answers there.
  The host has another session's notices only while it is on screen or in a
  tab: read them from the server, the inbox first and then the delivered
  messages (a notice is delivered once its conversation's model runs, and
  one delivered between the two reads must be in one of them), and keep with
  the answer what arrives while it is under way. From the moment a session's
  notices are asked for, every notice the host reports for it is kept,
  whatever becomes of the requests; what the inbox answered is kept when the
  messages cannot be read; a session is not let go, however many others are
  read meanwhile, while a read of it is under way, and such a session takes
  no place among the ones read last, so that what was read stays held while
  other reads wait; one lookup of a session, or its wait for the next
  attempt, exists at a time however often the panel asks. What was asked before a reconnection is dropped when it answers. This reading lives in
  `createReader` (`tui-model.mjs`), not in the view, so that its order and
  its races are tested with delayed answers; keep it there.
- The Markdown shown is the Markdown saved: only the cells of the summary
  table are decoded, each character escaped so that it stays literal as on
  the PR, and only AZPR's marker lines are left out. Both only where the
  runtime wrote them (a marker alone between blank lines; a table that
  begins after a blank line with the summary's header and delimiter row),
  never inside code, fenced or in a span over several lines. A preview on
  screen must be the preview that publication posts.
- A notice ends its block at the block's closing tag, so the runtime writes
  that tag inside the block in an escaped form (`enclose` in
  `attribution.mjs`), and the panel takes exactly that off again (`disclose`
  in `tui-model.mjs`). The two are each other's inverse for any text,
  including text that already holds the escaped form: change them together,
  and write every block through `enclose`.
- A session counts as deleted only when the server said so, and then it is
  gone whatever the host still holds of it and whatever answers later, until
  the server reconnects; a request that failed is tried again.
- A step the panel takes a moment after it mounted (handing the keyboard
  back, withdrawing) acts only while that panel is still the one open in
  that session, and no timer outlives the panel.
- The text of notices and receipts is therefore an interface. Change it
  together with `tui-model.mjs`, whose tests run against `renderReceipt` and
  against the notices of a whole run.
- `src/tui.js` is generated: edit `tui-view.jsx`, run `npm run build:tui` and
  commit both. OpenCode 2.3.0 compiles no JSX of an installed package, so the
  package ships the compiled file; keep it free of JSX and importing only what
  the host provides (`@opentui/solid`, `@opentui/core`, `solid-js`). The
  compiler stays a development dependency at an exact version: the package
  has no dependency, no lifecycle script and no build at installation.
- A panel that opens by itself never keeps the keyboard, never takes a screen
  too narrow for two panes and never replaces another plugin's panel; where it
  cannot open like that, it says that something is ready.
- The host drops the data of sessions that are neither on screen nor in a tab:
  read another session's inbox from the server, not from the host's cache.

**Setup has one writer; its dialogs only ask.**
- `/pr-setup` is the one way to set AZPR up: with options, or in the terminal
  UI with dialogs, which open when the command's notice arrives marked
  `metadata.azpr.setup` in the session on screen. Both end in `setup.mjs`,
  which checks every value, is the only writer of the settings file and the
  token file, and is the only one to ask Azure DevOps whether a token works.
- What setup can set is one table (`ROWS` in `setup.mjs`): a row reads, shows,
  accepts and writes its value, and its option of `/pr-setup` and its dialog
  are the same row. Give a setting people change a row; leave the rest to the
  settings file. `shell` and `azure.verifyTls` get none.
- The dialogs (`src/tui-setup.mjs`, which imports nothing so that its order
  is tested with scripted answers, and the token field in `tui-view.jsx`) use
  the host's own dialogs and hand every answer to the server part over the
  plugin's RPC. They read and write no file, contact neither Azure DevOps nor
  a model, run no command and store nothing.
- A token is typed into AZPR's own field, which takes keys and pastes itself
  and draws only bullets and a count: the host's text prompt shows what is
  typed. The terminal part passes it on once and keeps it nowhere, not in a
  toast, a dialog text, a log or a store. The server part writes it to the
  token file in one step, owner-only, and empties `azure.pat`. Settings name
  that file and settings can be wrong: an existing file is replaced only when
  it is a regular file of the user's own that is empty or holds one token.
- A saved token is sent only for the organization it was saved for, like
  every other use of the PAT, and only the way the saved settings send it:
  a check for another organization, or through a proxy or with a CA file
  that the call names, needs a token that was entered with it (a proxy and
  a CA file of the caller's choosing could read a token).
- Organization and token change in one step, the write of the settings
  file. A save names the organization its token was checked for, which must
  still be the one in the settings; a token of the same organization
  replaces the token file the settings name, and the token of another
  organization gets a file of its own beside it (`pat-<organization>`),
  which the settings name in the same write. The RPC changes the
  organization of settings that have a saved token only together with a
  token of the new one. Never write the token of one organization into the
  file the settings name for another: whoever reads the settings and then
  the file they name must have a pair that belongs together, also during a
  save and after one that failed. The earlier token's file is left to its
  person, who is told where it is. (The options of `/pr-setup` keep their
  behaviour: there the person keeps the PAT file.)
- Several server parts share one settings file (one per project directory,
  and other processes). The token file and the settings that name it are
  therefore written under the setup lock, the token first, after the
  settings were compared once more under the lock with what the answers were
  checked against; a save that finds the lock held writes neither.
- The dialogs of one setup talk to one server part: the place is fixed when
  they open, since the session on screen can change while they are open.
- What setup reports as waiting for a restart is the loaded runtime's own
  answer (`settingsDrift` in `runtime.mjs`, the rule of its preflight), so
  that the two never disagree; do not compare texts in `setup.mjs`.
- A process without usable settings registers commands that only say so.
  They are AZPR's own: never register one under a name that another plugin
  has taken meanwhile, since adding a command replaces the one of that name.
  A plugin can take a name at any moment, so list the commands again right
  before registering them.
- The RPC never throws and never quotes a refused value: its schemas are
  loose, the server part checks every answer itself, and what it returns
  holds neither the token nor a proxy's user name and password (a proxy that
  comes back as it was shown stands for the saved one).
- A token is checked before it is saved: one request through `azure.mjs`
  (`access`), not repeated, since a person waits. It runs in a queue of
  setup's own with one slot, because it must work before settings, and so
  the runtime and its queue, exist. A check that fails says what was
  refused; the token can still be saved unchecked.
- Ask first for what can make a later step fail, and let it be skipped: the
  proxy before the token is checked, the CA file after a proxy. Offer them
  again when the check cannot reach Azure DevOps.
- A dangerous value is confirmed in a list whose first row keeps the current
  setting, never with the host's confirm dialog, whose default is to confirm.
- OpenCode 2.3.0 announces commands that change after a plugin was loaded
  without their location, and its clients ignore that event: when a first
  setup is loaded the server part publishes the RPC event `loaded`, and the
  terminal part reads the commands again.

**Compatibility.** Host response shapes and constants belong in `host.mjs`.
Detect capabilities; do not assume them. The terminal part runs in the TUI's
process: it checks the TUI plugin API it uses at setup and reads theme tokens
through fallbacks.

## Verification and delivery

Run `npm ci` once, then `npm run check` and `npm test`; `npm run check` compiles the
terminal panel's source and fails when `src/tui.js` differs. For changes touching hooks, sessions, tools, Azure access or
publication, also run `node tests/host-v2-smoke.mjs <opencode binary>` (fresh and
`--replace`), `node tests/host-v2-comment-scale.mjs <opencode binary>` and
`node tests/host-v2-background-compaction.mjs <opencode binary>`, the last two
also with `--cleanup`. The fixtures keep debug on to read its records, and
debug keeps every private session: only the `--cleanup` runs, with debug off,
exercise the deletion of a run's sessions on a real host.
For package entry points, first-run setup or settings-path changes, also run
`node tests/host-v2-smoke.mjs <opencode binary> --native`; this installs the
packed artifact through OpenCode's plugin manager in an isolated profile.
For changes touching the terminal part, or the text of notices and receipts,
also run `node tests/host-v2-tui-panel.mjs <opencode binary>` and the same with
`--native`; for changes touching setup, the terminal part or the settings
path, also `node tests/host-v2-tui-setup.mjs <opencode binary>` and the same
with `--native`. They drive the real terminal UI in `tmux`, which they need.
Installer tests must preserve unrelated files and private settings, reject
conflicts and test rollback and archival uninstall. Keep the README manual-copy
list exact.

Fake-service fixtures and live Azure/model runs establish different claims;
record exact versions, environment and limitations in `docs/VALIDATION.md`, and
move superseded validation pages to `docs/VALIDATION_HISTORY.md` instead of
rewriting earlier results.

Do not start live models, publish PR comments, change personal settings,
upgrade installed tools or publish a repository or package without authorization
for that action. Authorization applies to the current request only.
