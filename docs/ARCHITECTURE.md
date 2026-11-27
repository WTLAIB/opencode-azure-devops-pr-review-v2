# Architecture

AZPR is an OpenCode V2 plugin distributed as an npm package, a native Git
package or a source archive. Model work runs in private,
role-bound sessions of their own; deterministic facts and every Azure DevOps write are
runtime code that calls the Azure DevOps Services REST API (api-version 7.1)
with the organization and PAT from AZPR's own settings (or the owner-only file
named by `azure.patFile`). Reviewers read the
repository through AZPR's own read-only tools, which use the same client.

## Components

| File | Responsibility |
| --- | --- |
| `src/plugin.js` | V2 plugin definition and setup entry. |
| `src/setup.mjs` | Native package bootstrap, external settings selection, the completion of the settings file at load, and [setup](#setup): the `/pr-setup` command, the RPC of the terminal UI's dialogs, the access check, the only writers of the settings file and the token file, the update of a settings file of 0.4.x that a person confirms, and the loading of a first setup. |
| `src/runtime.mjs` | Registration, hooks, grants, workflows, stage attempts (repair turns and retries), notices, cancellation and lifecycle. |
| `src/host.mjs` | OpenCode compatibility layer: response-shape normalization, capability detection and host constants. |
| `src/config.mjs` | Settings validation and defaults (`SETTING_DEFAULTS`), what a settings file of 0.4.x becomes (`migrateSettings`), roles (one reviewer role per position of a mode's model list), native tool rules, shared prompt policies, the two wordings of the comment prompts and agent compilation. |
| `src/session.mjs` | Session create/admit/wait/correlate, host stream continuations and retried steps, failure classification, interrupt and synthetic notices. |
| `src/tool-queue.mjs` | Bounded Azure DevOps concurrency with per-call timeouts that abort the request, shared by reviewer tools and runtime calls. |
| `src/azure.mjs` | PR URL parsing, the REST client (PR, iterations, changes, items, threads, thread creation, and setup's access check), error classification, retries, the per-run file cache and snapshot construction. The only place with REST paths and the api-version. |
| `src/review-tools.mjs` | The reviewers' read-only tools (`azpr_read_diff`, `azpr_read_file`, `azpr_search_code`, `azpr_find_files`, `azpr_list_files`, `azpr_pr_threads`): definitions, argument validation and bounded output. |
| `src/diff.mjs` | Line diffs (Myers) with both line numbers, more context before a change than after, the enclosing block's start, and folding of repeated changes. |
| `src/search.mjs` | Content search: reads the repository zip of one commit once per run (stored or deflated entries; bounded inflation; ZIP64 and encrypted archives refused), keeps its text files in memory and finds literal text, bounded per file and in total. An archive it cannot search is remembered for the run, which states the limit in the review's warnings and the receipt. |
| `src/review-work.mjs` | The review of every mode: sharded reviewer passes, overflow splitting, the checks of each finding's location and source, the review's finding IDs, the duplicate check across reviewer sessions, the severity rating and the final version recheck. |
| `src/output.mjs` | Strict model JSON extraction, the acceptance of reviewer, duplicate-check and rating answers with per-item degradation, and repair prompts. |
| `src/comments.mjs` | How a saved review's findings were produced (`reviewMethod`) and which of them may be published, comment-plan validation, title/anchor normalization, stable markers, plan assembly and the safeguards of automatic publication. |
| `src/comment-work.mjs` | Comment planning pages and deterministic, idempotent publication. |
| `src/comment-data.mjs` | Private content-addressed data files for large inputs and observed source. |
| `src/store.mjs` | Persistent reviews (each with the reviewer sessions it still keeps; a review's record goes only after its sessions were dealt with), data cleanup, fallback receipt files and the session records: the sessions an unfinished run keeps on purpose, due beyond the review limit, and apart from them the sessions that should be gone and could not be deleted, due at every pass; the per-review queue that keeps writes of one record from overlapping. |
| `src/attribution.mjs` | Deterministic reports, provenance, receipts and ledgers. |
| `src/diagnostics.mjs` | Optional private diagnostic files (bounded by `debug.keepRuns`) and stage timing. |
| `src/prompts/` | Shared review rules, role prompts and comment policy. |
| `src/tui-model.mjs` | What the [terminal panel](#terminal-panel) shows, worked out from AZPR's notices, the queued report and `metadata.azpr`; no host import. |
| `src/tui-setup.mjs` | What [setup](#setup) asks in the terminal UI and in which order, and the definition of the RPC it calls (which `setup.mjs` registers); no import. |
| `src/tui-actions.mjs` | What can be picked at the foot of the terminal panel after a review or a preview: the dialogs that ask first, and the `/pr-comment` command each step sends; no import. |
| `src/tui-view.jsx` | The terminal panel's view, the token field of setup, and the wiring of both to OpenCode's TUI plugin API; source only. |
| `src/tui.js` | The compiled view that OpenCode's terminal UI loads; generated by `scripts/build-tui.mjs`. |

## Commands and workflows

The package's `server.js` exports the plugin definition. Native installations
keep configuration outside the package cache, at an explicit absolute
`options.settingsFile` or `${XDG_CONFIG_HOME:-~/.config}/azpr/settings.json`.
Source installations retain their adjacent settings file. `/pr-setup` provides
guidance before settings exist and is the one way to set AZPR up (see
[setup](#setup)): with options it validates one model and an existing private
PAT file, or changes one setting per option, and writes settings only on the
explicit command. Without `--pat-file` it uses the PAT file already set (with
`--replace`) or `${XDG_CONFIG_HOME:-~/.config}/azpr/pat`, and `--organization`
also accepts a PR or organization URL. The command makes no model or Azure
request. A first setup is loaded at once, since nothing was loaded before it;
any later change takes effect after a restart, and the loaded runtime and its
active grants do not change in place. While settings are missing or
unusable, the review commands answer `SETUP REQUIRED` and name the problem
found at load (no file yet, an unreadable file's error code, invalid JSON, a
validation error or an unusable PAT file), never a setting value; an unknown
key is named only when it looks like a setting name. A settings file of AZPR
0.4.x is another case, whatever else it holds: the review commands answer
`SETTINGS UPDATE REQUIRED`, and `/pr-setup` shows its update, which comes
before any repair (see [setup](#setup)).

**Settings a version brings.** Every setting with a default is in
`SETTING_DEFAULTS` (`config.mjs`), which the settings example and the schema
match (a test compares them). When OpenCode loads AZPR and the settings file
is valid and enabled, `setup.mjs` writes the settings the file leaves out
into it, at those defaults, before the runtime reads the file for good.
Validation assumes the same defaults for a missing setting, so the completed
file behaves as the file did; values, their order and unrelated names stay.
The file is replaced as `/pr-setup` replaces it: a temporary owner-only file
renamed over it, under the setup lock, only when it is a regular file of the
user's own, without hard links, in a directory no other user can write to.
The lock keeps AZPR's own writers apart, not a person's editor, so the file
is compared with the text that was read once more after the new text is
ready, right before the rename: a save made meanwhile is kept, and the
completion starts again from it. A file switched off meanwhile is left as
saved, and a file of AZPR 0.4.x (`version: 2`), which is no valid file of this
version, is left byte for byte. A file that cannot be completed is used as it is and never fails the
load; `/pr-check` then names what it leaves out and why, and otherwise lists
what was added.

AZPR can be loaded more than once at the same time (several OpenCode
processes, or several project instances), and the runtime later compares the
file with the text it read. A load that finds another one writing therefore
waits for it, up to three seconds, and reads the result; one that opened the
file just before it was replaced reads the file that is there now. A lock
older than thirty seconds was left behind by a process that ended, and
nothing waits for it; its message names the lock file to delete. A load that
stopped waiting has read the file as it was. When the other load finishes
later, the preflight finds a file that differs from the loaded text only by
the defaults written in (it compares with the completion of what it loaded)
and accepts it, so commands are not refused over AZPR's own completion; any
other difference blocks new runs as before. A source installation's settings
are completed by the installer as before (`scripts/merge-settings.py`), from
the same example; a version-2 file is carried over exactly as it is.

`ctx.command.transform` registers `/pr-check`, `/pr-review`, `/pr-deep`,
`/pr-quick`, `/pr-stop` and `/pr-comment`. A command that starts a workflow (a
check, a review, comment planning, an adjustment or a publication) validates its
arguments, registers a run with its origin lock (and a PR lock for comments),
queues a `STARTED` notice and returns; the workflow continues in the background.
`/pr-stop`, `/pr-comment --show`, `/pr-comment --list`, `--help` of any
command, an adjustment that changes nothing and a refused command answer at
once without a run, as does `/pr-setup`. OpenCode's command list shows one
line of a command's description and cuts the rest, so each description starts
with what the command is for and the options are in `--help`. The final
receipt is queued to the invoking conversation with up to three attempts and is
written to `receipts/` in the state directory if the conversation cannot be
reached.
`PROGRESS` notices report phases (snapshot, session counts, the duplicate
check, the severity rating, planning pages, posting).

A notice starts no model response: it is left in the conversation's inbox
with `resume: false`, where it waits while the conversation is idle, also
across a restart of OpenCode. It is left there steered (`delivery: 'steer'`),
as OpenCode's own notices about background shells are, because of what
happens when the conversation's own model runs next. OpenCode hands that
model every steered item that waits together with the input that woke it, in
one request; it gives each queued item a turn of its own, so a review's
notices would cost one request per notice, each carrying the whole
conversation, the next time a person prompts there. A notice that arrives
while the conversation's model is working reaches it at its next step, or in
one further request when its last step was already under way.

A review command takes at most one flag right after the PR URL (`--preview`,
`--publish`, `--no-comment`); it sets `afterReview` for that run (the setting
is `preview` for every mode unless the settings say otherwise), and other
option-like text there is refused before any request. When the resulting step
is `preview` or `publish`, a COMPLETE review hands on after its receipt is
queued: without publishable findings one notice says so and nothing is planned;
otherwise the runtime starts the comment workflow of `/pr-comment` as a new run
with its own run ID, `STARTED` notice and receipt, under the same origin and
PR locks (a held lock skips the step with a notice naming the command to run).
A stop, timeout or unload while a finished review's report is delivered keeps
the review COMPLETE but hands on nothing.
Automatic publication posts the items no safeguard holds back (`publishPlan`
with `only`): an item whose saved text has an `@<…>` mention, a `javascript:`,
`vbscript:`, `data:` or `file://` link (both also checked after decoding
backslash escapes and character references, script links also without tabs and
line breaks, which a browser drops from a URL), an image, or HTML that embeds
content, runs a script (attributes read from every `<` the way a browser reads
a tag, `hasActiveAttribute`) or hides text waits in the saved plan, and the
receipt names it. Only mentions are checked inside literal code (`withoutCode`
blanks fenced code and code spans where every CommonMark reading agrees, and
leaves the rest of the text checked). A plan without inline comments whose
findings the planner all skipped as `existing-thread` with threads read live
before planning posts nothing (`NOTHING_TO_POST`; only a repeated summary would
be posted). A comment run hands on nothing; non-COMPLETE reviews and an
unloading plugin start nothing.

Each workflow first runs one **preflight**: `settings.json`, and the PAT file
when `azure.patFile` is set, must be unchanged since load, reserved commands must still be ours, the private agents of the
command's profile are pinned and the models the command uses must exist
(and offer the variant when a model is set as
`provider/model#variant`): every reviewer model, which must support tools, and
a named rater, which needs none. A comment run that plans needs the first
reviewer model of the review's mode; one that only posts a saved preview
checks no model and needs no enabled mode. Pinning and the model check are per profile, so a
problem with the quick (or deep) roles or models blocks only the commands that
use them; `/pr-check` lists each mode's passes and which model rates, reports
configured quick and deep models as warnings and says
when the deep models are unset or repeat the review models. A review command
of a mode whose list is empty is refused (`/pr-deep is off:
models.deep.reviewers names no model. …`); no mode falls back to another
mode's models. Review commands refuse a PR
URL whose organization differs from `azure.organization` before any request.
After preflight, hooks never re-read settings or catalogs.

### Review

`/pr-review`, `/pr-deep` and `/pr-quick` run one pipeline, `runReview` in
`review-work.mjs`, with the same stages and system prompts. A mode is its
models: the list `models.<mode>.reviewers` (one to four entries, which may
repeat) and `models.<mode>.rater`. An empty list leaves `/pr-deep` or
`/pr-quick` off. No stage verifies a finding: a reviewer checks its own
findings against the source, and the runtime checks their form and source,
never whether a defect is real.

1. **Snapshot** — the PR (identity, status, title, description, repository and
   project IDs), its iterations and every page of the latest iteration's
   changes (2,000 per request). Head is the latest iteration's source commit;
   base is its common commit (merge base), the comparison Azure DevOps shows,
   falling back to the target tip with a warning when Azure reports none. A
   lagging merge or multiple merge bases are reported as warnings. The PR's
   commit messages (newest 100, each shortened to 600 characters) go to the
   reviewers as the author's claims about each change; the comment planner
   does not get them. A complete change list without files ends the command
   before any session (INCOMPLETE, nothing to review); a partial one asks the
   reviewers to find the remaining paths.
2. **Reviewer passes** — changed files are sorted and cut into shards of
   `workflow.shardFiles`. Each entry of the mode's list is one pass: for every
   shard, a private session with that entry's model reviews the assigned
   files. Pass i runs with the role of position i (`azpr-<mode>-reviewer`,
   `-reviewerb`, `-reviewerc`, `-reviewerd`), since a private agent is pinned
   to one model; all of them have one system prompt (`common.md` and
   `review.md`). A pass receives what any other pass receives: nothing says
   which pass it is or what another one found. Every pass of every shard shares one pool of up to
   `workflow.parallelSessions` sessions. Each answer numbers its own findings
   in its shard's range (`F-1001` for the first shard, `F-2001` for the
   second, the same for every pass); the review's IDs are given later (step
   5), and where an answer's text names one of its own findings, that
   finding's review ID takes the place of the answer's: once the merges are
   settled, the ID of the finding that stays (fenced blocks, code spans and
   IDs written between quotes stay as written; an ID the parser had to give
   is no reference). A reviewer has two
   focuses, functional correctness and failure behaviour, which order its
   attention and are not a filter: it files every concrete defect it finds as
   a finding, and `report` carries exclusions, advice, open questions and
   limitations only. No stage checks a finding after its reviewer, so the
   reviewer checks each one against source it read in its own session before
   it answers; a concern it could not confirm from source goes to `report`
   as an open question. Severity follows the harm the evidence shows
   and how often realistic use reaches it: high must be fixed before merging,
   medium should be fixed in this change and low can wait; a rare trigger
   lowers the severity instead of keeping a defect out, but a change that
   breaks something BASE handled is at least medium, and neither an easy fix
   nor an effect the reviewer could not confirm lowers a level. Lines the PR adds or
   moves are in scope even when BASE had the same code (the finding says the PR
   carries it over), and behavior that is wrong only if the author did not mean
   it, with nothing showing whether they did, is a low finding whose summary
   and suggestion ask about the intent; neither a possible intention nor
   identical BASE code keeps a defect out of the findings. A
   reviewer looks for a statement of the intent (tests, nearby comments and
   documents, the PR description, commit messages) before asking about it. A
   finding states one defect: a second one the reviewer notices is filed on its
   own.
   Concrete gaps the change leaves (an untested change where the project
   already tests comparable code, a test that cannot fail, documentation or
   configuration that now contradicts the code, duplicated or dead code the
   change adds) are findings too, rated by their effect: a missing test is low
   unless the test is what the change delivers, and documented steps that
   worked in BASE and fail in HEAD are a regression (medium) even though the
   failure shows itself at once. A mistake repeated in places
   that each need their own fix is one finding per place. Identical copies of
   one file count as one place within one reviewer's assigned files; shards are
   cut by path, so copies in different shards can each produce a finding, and
   the duplicate check compares only findings in the same file.
3. **Overflow** — private sessions may not compact. A compaction the host
   attempts in a reviewer's turn opens its message first and is refused, which
   ends the turn; that message (or a 413) marks the stage as `overflow`, and the
   runtime splits that shard in half and runs both halves as parts of the
   same pass (labels `shard 1/5a`, `1/5b`; with several passes
   `pass 2/2 shard 1/5a`). OpenCode's background summary (`compaction.background`,
   on by default from 2.3.1 on; `experimental.background_compaction`, opt-in, in
   earlier releases from 2.1.4) asks for a summary through the same request before the context is
   full and publishes nothing; it is refused before anything is sent and that
   refusal ends nothing: the
   turn goes on, so a later failure is classified by its own cause.
4. **The runtime's checks** — `evaluateReview` accepts each answer by its form
   and source only, never by whether a defect is real:
   - the answer contract with a required `location`; a parsed answer is a
     usable result only with a `findings` array and at least one reviewed
     file or accepted finding;
   - the location (`head:` by default, `base:` for content that exists only in
     BASE) must exist at that commit with the lines in range, in a file whose
     content this session's own `azpr_read_diff` or `azpr_read_file` calls showed
     (not the run's cache, another session's reads or the runtime's own checks).
     Only answers that show source count: a binary or oversized side, an empty
     file, identical versions or a line, column or hunk past the end show none;
     a diff reads a version only through the rows it shows after paging and byte
     cuts ("-" BASE, "+" HEAD, a blank mark both; folded repeats none), and an
     answer cut to the tool-output limit is no read;
   - problems the reviewer can fix get the normal correction turns, with hints
     for deleted and renamed files; what is still wrong afterwards becomes
     NEEDS_INFO. Passing findings are REPORTED, each with whether its location
     can carry an inline comment (a changed HEAD file);
   - a usable answer that is PARTIAL and names unfinished work (coverage gaps or
     assigned files it did not list as reviewed), with nothing left to correct,
     gets one **follow-up** turn in the same session within the
     `workflow.repairAttempts` budget: continue where the source is readable,
     keep a gap only for a limit it cannot close, and return the whole answer
     again. A second PARTIAL stands. The stage record keeps the outcome
     (`followUp`);
   - in this stage and every other one, a turn after the first that fails,
     or a correction turn whose answer is not usable, leaves the latest
     usable answer standing (the follow-up's, where it had one), with the
     items it would have repaired degraded; the stage record names the turn
     (`repairFailure`, `repair=failed:<class>` in the receipt). What is
     usable is the stage's own word: a reviewer answer that reviewed a file
     or holds a usable finding, a duplicate check that returned its list of
     merges, a rating that rated a finding, a grouping or planning page that
     parsed. Cancellation keeps its handling, and so does an overflow where
     the work can be split (a reviewer shard of several files).
5. **The review's finding IDs** — once every session has answered, the runtime
   sorts the findings by side (HEAD before BASE), path and lines, then by
   pass, shard, part of a split shard and place in the answer
   (`byPlaceAndSource`), and numbers them `F-1 … F-n`. Nothing a later stage
   or a person sees depends on which session finished first or on an ID a
   model wrote; a finding keeps the ID of its answer as `localId`, and the
   runtime records the session that reported it (`shard`, such as
   `1/3a pass 2`). Records identical in every field, character for
   character, are then merged, where what their texts name is the same (a
   finding that names itself names itself in each copy; copies that name
   different findings go to the duplicate check): the first in that order
   stays and stands for the sessions
   that reported it, the others become MERGED. Findings on the same lines
   that differ in any field stay separate.
6. **Duplicate check** — `duplicateGroups` takes the findings that are still
   REPORTED on one side of one file, where two of them share no reviewer
   session; one pass over one shard gives none. Each such group is one
   `dedupe` session with the first reviewer model, which gets the file, the
   side and the findings, each with its session, and may read the source. It
   only merges. Two findings are duplicates only when they state the same
   root cause and need the same correction; the same kind of mistake at
   several places is several findings (one comment may still cover them, see
   [Comments](#comments)). `evaluateDuplicates` applies the merges in the
   answer's order and refuses one that would put two findings of one session
   into one finding, directly or through a third: a session files one
   finding per place that needs its own correction, and that rule is the
   program's, whatever model checks. Invalid and refused merges get a
   correction turn and are otherwise left out; chains end at the finding that
   stays, and a cycle merges nothing. The finding that stays keeps its own
   text and records what it stands for (`alsoReported`: each merged report
   with its sessions and its reviewer's level; `sessions`: all of them). A
   failed check keeps every finding of its file and adds a warning.
7. **Severity rating** — unless `models.<mode>.rater` is `false`, `rating`
   sessions (25 findings each) set the severity of every finding that is
   still REPORTED, so that the findings of different reviewers stand on one
   scale. They run with the model `rater` names, or with the first reviewer
   model where it is `""`, the default. The role has no tools and its system
   prompt is its own text and the Severity rules; its input is the finding
   text (`RATED_FIELDS`: summary, location, evidence, counterevidence and
   suggestion) plus the PR title and the first 4,000 characters of its
   description, with no PR identity, commit, file list, earlier level,
   session or count of reports: whether several passes reported a finding
   never reaches the rating. An unusable answer gets a correction turn; a
   finding without a usable rating, and every finding of a failed session,
   keeps its reviewer's severity with a warning. The rating never drops, adds
   or rewrites a finding, and the record keeps the reviewer's own level
   beside it (`reviewerSeverity`; the report shows both where they differ).
   With `rater: false` the stage does not run and its role is not
   registered. Nothing runs when nothing is reported. The stage is on by
   default because the models measured for this release scaled severity very
   differently (see [validation](VALIDATION.md)); a model that underrates
   lowers other models' findings too, so the first reviewer model, or the
   named rater, should be one whose scale is sound.
8. **Recheck** — a fresh PR and iteration read compares versions. A changed
   head is STALE; a changed base only adds a warning. A failed recheck is a
   warning because publication rechecks the head anyway.

A review states its status, its coverage and its method separately:

- **Status.** COMPLETE needs at least one reviewer session with a usable
  answer and an unchanged head. When sessions answered but none was usable,
  the review is PARTIAL and cannot be commented on; a changed head makes it
  STALE. When every reviewer session failed, the run ends INCOMPLETE. A pass
  that fails leaves the others' work.
- **Findings.** A disposition is REPORTED (the finding passed the runtime's
  checks), NEEDS_INFO (it did not, also after the correction turns, or its
  answer was not usable) or MERGED (`mergedInto` names the finding that
  stays). The statuses CONFIRMED, REJECTED and UNREVIEWED exist only in
  reviews saved by 0.4.x.
- **Coverage.** `coverageSummary` has two numbers of the changed files Azure
  listed: those a usable answer reported as reviewed in at least one pass
  (`reviewedOnce`) and in every pass (`reviewedByAll`). Retries, follow-ups
  and the parts of a split shard belong to their pass. A pass that fails
  costs depth, which the second number and a warning show; only a file that
  no pass reviewed is unreviewed. Coverage is complete when no file is
  unreviewed and no fixed reason applies: a failed session that left files
  unreviewed, a partial change list, reviewer-reported gaps. Zero findings
  never hide unreviewed files.
- **Method.** Every review records `verification: "none"` and `method`
  (`kind: "reviewers"`, `version: 1`): the models asked for (`requested`),
  for each pass its model, its sessions and how many of them failed
  (`passes`: the shard sessions whose answers the pass's coverage rests on,
  so a shard split in two counts its two halves and not the session that
  overflowed, and a session retried after a transient failure counts once),
  how many duplicate checks ran, failed (also by giving no usable answer),
  merged and were refused
  (`duplicateCheck`), and of the rating its state (`first`, `named` or
  `off`), its model, its sessions and how many findings it rated or left
  (`rating`). A result that does not state both is not saved as a review.
  The report, the receipt and the disclosure line of comments are written
  from this record, and none of them says that a finding was verified.

A location on a changed HEAD file may carry an inline comment; a BASE location
or unchanged code stays in the summary index. Session reports are joined by
the runtime. COMPLETE reviews are cached (newest 20) and persisted with the
source the reviewers read, so `/pr-comment` works after a restart in the same
conversation.

### Reviews saved by 0.4.x

A review that 0.4.x saved stays what it was: a review whose findings a
verifier confirmed, or a quick review. `reviewMethod` (`comments.mjs`) is the
one place that tells the kinds apart, from the record alone, and every reader
of a saved review goes through it:

| Kind | The record | Findings that may become comments | Disclosure line of its comments |
| --- | --- | --- | --- |
| `reviewers` | `method.kind: "reviewers"`, `method.version: 1` and `verification: "none"`; both must be there | REPORTED findings that were not merged | The method: findings checked by their reviewer against the source, no separate verification; in the summary also incomplete coverage |
| `verified` | Profile review or deep, no `method`, `verification: "independent"` or no such field | The verifier's CONFIRMED findings and its additions | The line 0.4.x wrote: AI-generated review and the models |
| `quick` | Profile quick, no `method`, `verification: "none"` | Its REPORTED findings | The line 0.4.x wrote for a quick review: quick review, not independently verified |
| none | Anything else: a method this version does not know, or fields that contradict each other | None | — |

A record of no known kind can be listed and shown; it is never planned,
adjusted or published. A verified review is planned by a role of its own,
`azpr-<mode>-comment-plan-verified`, with the mode's first reviewer model.
The comment prompts (`comment-policy.md`, `comment-plan.md`) are the only
prompts that keep passages in two wordings, marked `<!-- azpr:verified -->`
and `<!-- azpr:reviewers -->`: the `verified` wording is the text 0.4.6 had
and speaks of the verifier's findings; the `reviewers` wording, which every
other role gets, never says that findings were verified or confirmed. Only a
quick review of 0.4.x is offered `mergeCandidates` in comment planning (see
[Comments](#comments)). Posted comments are never edited, so a comment keeps
the line it was posted with, and `listedPlaces` recognises all three
wordings as AZPR's.

The review system prompts are one set for every mode and every pass: a deep
or quick agent's system prompt is the review agent's, and only its model
differs. A hash test (`tests/config.test.mjs`) locks them, so a change to
them is deliberate.

### Stage attempts

A stage attempt creates a fresh role-bound session, admits the JSON payload as
the only prompt, waits for idle and correlates the turn. The handler evaluates
the answer; if it lists issues and a repair prompt, the runtime sends up to
`workflow.repairAttempts` correction prompts in the **same** session (each is a
newly authorized prompt with its own nonce). A transient failure (provider
408/409/425/429/5xx, missing idle, an unexpected message in the turn) retries
the stage once in a new session (`workflow.stageRetries`). Permanent failures
and cancellations are not retried. Before that, OpenCode itself retries a
failed provider request in the same session (backoff from 2 s, `Retry-After`
up to 15 minutes); it prepares every resend again, so the resend passes the
`context` and `model.request` hooks like any request. AZPR refuses those
retries for a used-up usage or spend limit (`provider.quota`,
`provider.free-limit`, `provider.chatgpt-limit`,
`provider.chatgpt-workspace-limit`, `provider.go-limit`,
`provider.budget-limit`, `provider.model-budget-limit`), which fails the
stage as permanent and is named in the receipt. The workspace limit is the one
a ChatGPT workspace's admin sets for a member; OpenCode 2.4.0 and later report
it as a type of its own, and earlier ones as a rate limit or a quota,
depending on the provider's wording.

A **stage inactivity watchdog** (`workflow.stageIdleSeconds`, default 600, 0
turns it off) covers a model stream, a tool or the host that stops responding.
While a stage waits on OpenCode, prompt admissions, model requests, streamed
output, tool starts and ends, approval requests and announced host retries are
activity (an announced retry wait is added to the window), and a running AZPR
tool counts until it returns because its Azure calls have their own timeouts.
Streamed output reaches no hook, so while a stage is watched AZPR follows
OpenCode's session events (`event.subscribe`): the answer text and reasoning
as they stream (OpenCode publishes what is pending every 100 ms and when a
part ends), and the start and end of a tool call's input, whose chunks in
between it does not publish. AZPR asks for
those progress types only; OpenCode 2.2.0 and later deliver nothing else. A
host without them leaves only the hooks. A stage with
no activity for the whole window is stopped: its grant is revoked, its session
interrupted, and it fails with `failure=idle` and an error that names the last
activity, such as `Stage inactivity watchdog stopped this stage: no activity
for 600 s after model request 3 was sent`; the receipt adds an inactivity
notice. It is retried in a new session like a transient failure. Any activity
restarts the window, so this is not the whole-run timeout or step cap the
[roadmap](ROADMAP.md#deferred) defers: a stage whose progress keeps reaching
AZPR is not stopped. A model that streams nothing but one tool call's
arguments for the whole window shows no progress, and neither does a stream
whose session events do not reach AZPR (a host without them, or a feed that
failed). The longest quiet stretch in 1,097 normal live stages was 151 s
(stages of versions before 0.5.0).

An interrupted model stream that OpenCode recovers by itself costs no new
session, whatever the provider. OpenCode 2.3.0 and later retry the interrupted step:
the errored assistant message stays, marked for retry, and the retried step
answers in the next assistant message. The retry is sent with what the step
had finished (its tool calls that ran and what came before them) and without
the output the interruption cut off, so AZPR takes the final message alone
as the answer and joins nothing of the errored one to it; the receipt counts
these as `step-retries`. OpenCode through 2.2.x resumed with a continuation
notice instead: an errored text-only assistant message that the host marked
for retry, followed by that notice and a successful final text, is joined
literally (`stream-continuations`), and when the model starts its answer over
instead of continuing (a later fragment opens like the first), only the
restarted text is used. The fragments belong to the answer that ended them:
where the model answered once more afterwards, because the notice of its own
background command woke it before the session went idle, that later answer
is the turn's and stands alone. The continuation notice is known by its text alone, which anyone
can post into a session, so it is taken for the host's only on a host whose
version names a release of that protocol (2.0.x to 2.2.x): on OpenCode 2.3.0
and later, and on a host that does not say its version or says what is no
release, such a message is someone else's and fails the turn. Either way an
errored message is excused only when the host marked it for retry and the
turn still ends with a complete, successful final answer on the granted agent
and model.

Before asking for a correction, a narrow local repair escapes unescaped double
quotes inside closed single-line `code` spans. Corrections for syntax errors ask
for the same content unchanged; answers without JSON are asked for the full
object.

### Comments

`publishableFindings` supplies the findings by the review's kind (see
[reviews saved by 0.4.x](#reviews-saved-by-04x)): for a review of this
pipeline the REPORTED findings that were not merged; for a verified review of
0.4.x the CONFIRMED ones and the verifier's additions; for a quick review of
0.4.x its REPORTED ones; for a record of no known kind none. The first
reviewer model of the review's mode plans. `commentFindings` hands the findings to planning as a person adjusted them
after a preview (see below); without adjustments they are exactly the
publishable findings. Planning (model) uses pages of at most four findings (more only where
one defect at several places keeps its findings on one page) plus report segments
(on a large PR each page carries the changed files and dispositions of its own
findings and references to the complete lists), with
CONTINUE checkpoints when a page needs more reading: at most three continuation
sessions per page, and a checkpoint without progress or a fourth unfinished
session ends the page, keeping its finished comments and skipping what is open.
Two pages run at a time (`PLANNING_PARALLEL_PAGES`, never more than
`workflow.parallelSessions`), each continuing in its own lane, and nothing a page
sees depends on which page finishes first: only the first page may write the
summary note (the runtime drops a note from any other page without a correction
turn); a page's anchor checks see the HEAD source the runtime fetched for its own
and earlier pages' findings; a checkpoint counts only the page's own details and
the planner tool results the runtime tagged with its page; and pages are
assembled in page order, so markers and their ordinals match planning one page
at a time. After a page fails, no page or continuation session starts and no
page is asked for a correction: stages already running finish the turn they
are in (the saved observations a page's comments are checked against are not
read on, and the page is taken as it would be at its last turn: the stage
asks the page's handler before each correction whether its work was given
up, and a stage tells its handler of a failure that will not be tried again
before it cleans its session up), and the failure of the lowest failed page
ends the command as before;
`/pr-stop` cancels every running page.
Each page is validated per item: titles, severity labels, path slashes and
HTML comment markers are normalized; anchors are restored against source text
observed during the review; real problems get a repair turn; what remains is
skipped with a reason. A planner skip names one cause, and the runtime checks
the facts it states against the finding, the page's source excerpts and the
live threads it read (a `cannot-anchor` skip whose lines the page showed goes
back for correction). For a review of this pipeline, as for a quick review of
0.4.x, an inline comment also needs a
finding located on a changed HEAD file and an anchor found in the observed HEAD
source; otherwise the finding stays in the summary index. The disclosure line
of their comments names the review's method (and, in the summary, incomplete
coverage). For a quick review of 0.4.x, which merged no duplicates, the
runtime also groups findings of different
sessions with the same severity on overlapping lines of one HEAD file into
`mergeCandidates`, keeps each group on one page, and accepts a planner's
combined comment (`findingIds`, `mergeReason`) only when its members are in one
group, come from different sessions, share a severity and a line, and the
anchor lies on the shared lines; a refused combination falls back to the valid
single comments and reasoned skips. The summary index gives an accepted
combination one row. A review of this pipeline is offered no such candidates:
it had its duplicate check, and what that kept apart stays apart. The assembled plan stores exact content, offsets and markers.

One defect made at several places is several findings (a reviewer files one
for each place that needs its own correction), and one comment may hold them.
Before the pages are made, `prepareComments` settles which findings may be
such repeats: `repeatEligible` takes the high and medium findings on lines of
a changed HEAD file whose place a list can hold as it is (`listablePlace`; a
finding of a 0.4.x quick review that is a merge candidate is left to that rule), and
`severitySets` the sets of one severity that lie at two places or more. Where
there is such a set, the HEAD text of those findings' files is read, and only
a finding whose lines the file has stays eligible: a place is listed as its
finding states it. When every finding fits one page, the page is offered the
sets as they are. Otherwise a group must share a page, so only a finding that
fits one together with another finding of its severity at a different place
stays (`pairable`): nothing is read ahead of the pages and nothing asked for
any other, and without such a pair there is no pass. Then a grouping pass
runs first: one stage of the comment-plan role whose input is
`commentWork: { kind: "group" }` and those findings' text, inline (without
the evidence above 60,000 characters; a list still longer is not grouped),
and whose answer
`evaluateGrouping` checks (`repeatProblems`: one severity, high or medium,
lines of a HEAD file, no two findings on the same lines; a finding in one
group at most; a status other than READY is sent back, since the pass has no
continuation), with repair turns like a page and a checkpoint text of its
own; `boundedGroups` cuts a group to a page's text and `candidatePages` keeps
each group on one page. A page receives its groups as `repeatCandidates`,
and a continued page what is still open of them. A combined comment for one
names findings of one listed group, of one severity, on different lines that
the changed files have in the page's HEAD text, and its anchor touches the
lines of exactly one of them: that finding is the comment's place
(`findingId`), the others become `otherPlaces`. `assemblePlan` renders them
under the planner's text with `renderOtherPlaces` (`attribution.mjs`): the
findings' own locations and IDs as a plain list, never text a model wrote.
The planner's text must leave no block open that would take that list in (a
code fence without its closing fence, raw HTML that waits for its own end):
`openBlock` reads its lines as CommonMark reads blocks, and such a text is
sent back.
The summary index keeps one row per place; only findings reported twice on
the same lines share a row. A grouping pass that fails is said in a progress
notice and planning goes on without groups; a stopped run starts no page.
`discussionDigest` reads the list back (`listedPlaces`) and gives the planner
those places as `alsoAt`, since the list lies beyond the excerpt of a thread:
a later plan then sees them as discussed. That only informs the planner;
nothing is posted or skipped because of it. The list is read only in the form
the runtime writes it: in the comment that opened a thread on a file and
carries AZPR's marker, under one of `OTHER_PLACES_HEADINGS`, with nothing
after its rows (a place and a finding ID each) but the attribution (the one
line `commentAttribution` writes, which ends with the word for the models
and the models) and the comment's two markers; a body that writes such a
heading itself is refused.

A comment for several places is a comment of its own, so `assemblePlan` gives
it a marker of its own: `sharedMarker` (PR, path, normalized anchor, the
sorted other places, and an ordinal for two such comments that are alike in
all of these: two defects at the same places). It is the item's key in the
ledger, the attempt records and the summary's marker, and `publishPlan`,
which is unchanged but for how it counts the other comments of a PR, skips
the item only when that marker is on the PR. That is this very comment, with
every place, so a receipt never infers what a posted comment covers. A
shared comment and a comment for one place do not find each other by marker;
`occupiedLines` (`comments.mjs`) keeps them off each other's quoted lines
when planning, with `posted` (`markersInThreads` of the threads read before
planning). For that, the shared comment's text carries a second marker
before its own, `linesMarker` (PR, path, normalized anchor), which only this
rule reads. A shared comment is sent back when a comment for one place is on
its quoted lines (an `inlineMarker` under one of the first ordinals; an
earlier comment there may have been deleted) or another shared comment is
(its `linesMarker`), unless the PR has this very comment; a comment for one
place is sent back when a shared comment is on its quoted lines and no
comment for one place is. After the correction turns such a comment is not
planned. A shared comment's quoted lines must also be found in the HEAD text
and end within the file. The files read ahead of the pages are not read
further once the run was stopped.

The runtime gives each page what it normally needs: the HEAD source around
each finding (the whole file when small) and a digest of every live thread, both
read deterministically; findings are inline. A page usually
finishes in one model request without tools.

Publication (runtime) rechecks that the head is unchanged (the PR's status
stops nothing; one that is not active is named in the receipt), lists every
thread, skips items whose marker exists, creates the rest with
`POST …/threads` (right-side `threadContext` for inline items; Azure DevOps adds
the iteration context itself), records each result immediately, and reads all
markers back (`VERIFIED`). Creation results are `POSTED`, `ALREADY_PRESENT`,
`FAILED`, `UNCERTAIN` (resolved by read-back), `UNVERIFIED` or `DELETED` (a
recorded thread whose comment someone deleted on the PR; it is not posted
again). Re-running publication is safe.

A `/pr-comment` command without a review ID acts on the conversation's current
review: in one of a review's own sessions that review, otherwise the
conversation's review with the latest `completedAt` or `usedAt`. `usedAt` is
set when a comment command selects a review, also one that answers at once
(`--show`, unchanged adjustments) or is refused, and again when a review or a
comment run has ended, after the cleanup of its sessions and next to its
receipt. The review whose receipt arrived last is therefore the current one,
also when that cleanup waited for OpenCode while a person used another review.
Every write of a review's record, and its removal on eviction, goes through one
queue per review (`createReviewWrites`), so two writes of a record never
overlap and an earlier one never lands after a later one. A selection is
saved by a write that reads the review when it starts: a choice made before it
starts is carried by it, and a choice made while it writes gets a write of its
own after it, so the record ends with the last choice even when commands
overlap. While a comment run is in flight on the review, the run alone writes
its record and its last write carries the latest choice; a choice made after
that write, or by a command refused before the run wrote anything, is written
when the run ends. Both times come from one counter that never
repeats or runs backwards, also against the times of saved reviews, so a
clock set back cannot change which review is current. Its `STARTED` notice
and receipt name the review and its PR, and the receipt of a preview ends
with the next commands, built from that review's findings and saved
adjustments so that an example list never undoes an earlier one.

A person's adjustments (`/pr-comment [review-id] --exclude`, `--severity`,
`--reset`) are stored apart from the review, as `review.adjustments`; the
review record, its findings and its report never change. `commentFindings`
leaves excluded findings out and applies changed severities, so the existing
page checks decide titles and inline eligibility, and the planner input gains
an `adjustments` field only while some are active. Two states matter:

- **Active adjustments** shape planning and the summary index. Published text
  must not name an excluded finding: the page checks repair or drop the
  planner's own text, and `excludedReferences` checks the assembled preview,
  including the summary rows rendered from the review's finding summaries,
  and holds publication when one still names an excluded ID, or the ID of a
  finding merged into an excluded one through any chain of merges.
- **Ever adjusted** (also after `--reset`) keeps the stricter publication
  rules. An adjustment is saved together with dropping the earlier preview
  before anything else, and a failed save changes nothing; the new preview is
  saved strictly as well and dropped when that fails. Such a review is posted
  only from a preview planned after its latest adjustment, never planned and
  posted in one `--publish`, and once its publication has started it is
  neither adjusted nor planned again. Its publication compares the text of
  items already on the PR (from the first thread list and from the read-back)
  and names in the receipt those that keep their earlier text; nothing posted
  is changed.

## Authorization and isolation

Private roles are hidden primary agents with explicit models (and variants,
when configured): `azpr-<mode>-reviewer`, `-reviewerb`, `-reviewerc` and
`-reviewerd`, one per entry of the mode's list; `-dedupe`; `-rating` unless
`rater` is `false`; `-comment-plan`; and, for review and deep,
`-comment-plan-verified`, which plans the comments of verified reviews saved
by 0.4.x. A role is registered only where its mode has reviewers and the role
has a model. The role names of 0.4.x
(`azpr-<review|deep>-functional|risk|verifier`) stay reserved, so that
sessions which saved reviews still name remain AZPR's private sessions. Every
private session gets a grant with the run, role, model and a pending prompt
(text + nonce); a request on another model or variant is refused, also when
the host itself resolved the configured entry to another model, as a routing
entry such as GitHub Copilot's Auto does.

A conversation that nobody named yet gets a name from the runtime when a
check or a review starts in it: `AZPR: PR #<id> (<repository>)`, from the URL
the person typed (`conversationTitle`; the PR's own title is text from the PR
and is not used). OpenCode names a conversation when its own model first runs
there, which an AZPR command never makes it do, so the session list would go
on showing "New session". Nothing waits for it, and a host without
`session.update` is left as it is.

Whether a conversation has a name is `isUntitledSession` in `host.mjs`: no
title, or the dated placeholder of earlier releases. OpenCode has no rename
that applies only to a conversation without a name (its own naming guards
itself with the sequence of the session's events, which a plugin cannot use),
and nothing ties a rename it reports to the call that made it. A read followed
by a write can therefore replace a name that was given in between, and no
plugin can rule that out. `nameConversation` is built so that AZPR's own name
gives way wherever it can tell, and also where it cannot:

- It names a conversation only where the host reports renames
  (`session.renamed`), and follows them from before it reads the conversation.
  A rename reported during that read stops the naming; everything the host
  has reported by then is looked at, also behind another conversation's
  rename.
- A report with other words than AZPR wrote is someone else's name. A report
  with AZPR's words is AZPR's write or someone's choice of the same words,
  which cannot be told apart. Where it follows someone else's name, that name
  may have been replaced by AZPR's write, so it is written back: in doubt, the
  name that is not AZPR's stays. A name given after AZPR's write stands by
  itself.
- What is written back is the last name reported once the host has reported no
  name of that conversation for a moment (50 ms, whatever it reports of other
  conversations meanwhile), so that several renames in a row end with the last
  one. AZPR's own first words are never written back as someone's name: after
  AZPR wrote a name back, a report of those words is AZPR's first write
  reported late, which the name written back follows, or, once that write-back
  was reported, someone's own choice of them, which stands.
- The watch stays open for three seconds after the host answered AZPR's last
  write, however promptly a report came, since an earlier name can be reported
  after it. It is never closed while a write is under way, which could still
  replace a name, and it writes four times at most: AZPR's name, and three
  names written back.
- One conversation is named by one watch at a time: a check can end while its
  rename is still under way, and a second watch would take the first one's
  write for someone's choice. When the plugin is unloaded, a watch first ends
  what it is doing: a write is waited for (five seconds at most on a host that
  does not answer), and a name it replaced is still written back.
- A read of the feed never rejects, also while nobody awaits it yet: a feed
  that fails has ended, and nothing is written that could not be watched.

What this cannot do: a person who gives a name and then exactly the words
AZPR wrote last (its own name, or a name it had just written back), both in
that moment, keeps the name given first; and a host that reported renames in
another order than they took place would mislead it. With debug
records on, `conversation-name.json` says how the naming ended (`named`,
`kept`, `restored`, `unconfirmed` when the host did not report a write in
time, `failed` when it refused one), never with a name that is not AZPR's
own. A host without the event feed names nothing.

A private session is a session of its own, never a child of the conversation.
OpenCode 2.3.0 and later hand every answer of a child session to its parent as
a `<subagent>` message and wake the parent's own model with it, so a review
would make the conversation's model, with that agent's tools, respond to raw
reviewer output and to AZPR's notices. Each session is created without a
parent at the conversation's location (read from the conversation's session;
without one the host places it where this plugin instance runs), and its
`metadata.azpr` names the run, the role, the conversation and, for a comment
run, the review it acts on, so tools that list sessions can tell AZPR's
sessions from conversations without reading titles. What ties a private
session to its conversation is AZPR's own record: the run's stages while it
runs, then the sessions the saved review keeps. OpenCode lists a session
without a parent like a conversation, and its plugin API cannot archive one
(`session.update` accepts `archived` and ignores it), so when a run ends AZPR
deletes its sessions except the one that holds the report or draft; see
[retention](../README.md#retention-and-privacy). The cleanup is ordered so that
no session is forgotten and none is taken from a command that needs it:

- The sessions to delete are chosen the moment the run ends, before anything
  is awaited. From then on a command typed in one of them is refused, since
  its answer would have nowhere to go.
- They go on record before any is deleted. A saved review's record takes all
  of the run's sessions and names those to delete apart, as
  `closingSessions`. An unfinished review writes all of its sessions to its
  run's record in one write, then those to delete to a record of their own,
  as still to be deleted, and leaves on the run's record what the run keeps.
  An evicted review's record, which names its sessions, is removed only
  after they were dealt with. A process that ends during a cleanup therefore
  forgets no session, and the next one knows which may be gone or may still
  go.
- What OpenCode confirms as deleted leaves the record. A session that is
  still there, because a command needed it or OpenCode refused the deletion,
  is one of the review's own again and takes commands. A deletion OpenCode
  had not answered when AZPR stopped waiting may still be carried out, so
  that session stays among `closingSessions` for good: commands are refused
  there, also by a restarted plugin, and it is deleted with the review.
- A session a command needs is left alone: the one it answers in, from the
  moment it is typed until its last notice is out, and while its run is active
  the run's conversation and its stages' sessions.
- A review is not evicted before the command that works on it has ended: its
  run, a comment run's last steps, and after a review the cleanup of its
  sessions, the delivery of its receipt and the start of the comment step it
  hands on. Nor is a review evicted while a command answers in one of its
  sessions. This holds in the process and on disk; what waited is evicted
  when the next review completes. The same holds for an unfinished review's
  record of kept sessions, which later runs do not release before its command
  has ended. A save of a review that was evicted is refused instead of
  bringing its record back.
- A session leaves the records only when it is gone: OpenCode confirmed its
  deletion, or answered the deletion or a read of it with
  `Session.NotFoundError`. Any other failure settles nothing.
- Sessions that are still to be deleted and belong to no saved review are on
  records of their own (`sessions/…-retry<id>.json`), apart from the sessions
  a run keeps on purpose: those an unfinished run is deleting, a late session
  (see below), and what could not be deleted of an evicted review or of an
  unfinished run whose record went beyond the limit, because a command
  needed the session or OpenCode refused or never answered. Such a session
  takes no commands, also after a restart.
- A pass tries these sessions again, and deletes the kept sessions of
  unfinished runs beyond the limit: after every run and at load. It runs in
  the background, one pass at a time, so no receipt waits for a host that is
  slow to delete, and it leaves a run whose command has not ended to that
  run's own cleanup. A run with both kinds of record is dealt with once, so
  that neither list replaces the other, and its kept record is removed only
  after what is left of it was recorded. With `deletePrivateSessions: false`
  the records are left as they are.
- A cancellation can overtake the host: a session OpenCode creates after its
  stage gave up is known to no stage, so it is put on record and deleted when
  it arrives.

One case is not covered: a process that ends while a run is still under way
has recorded none of that run's sessions yet, so they stay in OpenCode's
session list until a person deletes them. Their titles (`[AZPR <id>] …`) and
`metadata.azpr` identify them.

A new review cannot be started from a session AZPR created, also after a
restart, when the process no longer knows which sessions it created: the
saved reviews and the records of unfinished runs name them.

Hooks enforce the grant:

- `prompt`: only the exact pending runtime prompt is admitted; private agents
  cannot be mentioned or delegated. In an ordinary conversation one kind of
  prompt is refused: one of AZPR's commands that arrived as text (see below).
- `context`: private requests keep only the role's allowlist — AZPR's six
  tools, native read/glob/grep and shell when the `shell` setting allows it;
  every other tool (other MCP servers, edits, web, delegation, CodeMode) is
  removed. The `rating` role's allowlist is empty: it sees and runs no tool,
  whatever the `shell` setting. Ordinary sessions lose only AZPR's tools. Comment pages that read too
  much get their tools removed to force a checkpoint. Private requests also
  lose what the host collected for the conversation's place (see below).
- `compaction`, `generate`: the requests OpenCode builds outside a turn (a
  summary, also the one it writes in the background, and a generation such as
  a side question) carry the session's whole tool list and pass no `context`
  hook, so AZPR's tools are taken out of them here; a private session's are
  refused in `model.request` all the same.
- `model.request`: only primary requests after an authorized context; compaction,
  generation and title requests are refused (a compaction the host attempts
  in the turn ends it as overflow).
- `retry`: host retries continue only while the grant is active and never
  for a used-up usage or spend limit; the announced
  wait does not count as inactivity. OpenCode prepares the resend again
  (`context`, then `model.request`), so it passes the primary-request check.
- `permission` `evaluate`: enforces the `shell` setting for private roles,
  allows reads of AZPR's own private data directory and refuses at once any
  other request that would wait for an approval (private sessions run
  unattended); only shell under `shell: "ask"` or `"inherit"` may wait. A
  native read, glob or grep on a repository path is refused with a pointer to
  the azpr tools.
- `tool.execute.before`: refuses any tool outside the allowlist and delegation,
  and any tool call in a private session without an active grant, whatever
  agent the host names.

The hooks treat as private every session of an AZPR role (also a role of
0.4.x) and every session this process created or a saved review or a session
record names. A process without usable settings, settings of 0.4.x waiting
for their update among them, loads no runtime: it registers placeholder
commands, no agent, no tool, and one hook, which refuses one of AZPR's
commands that arrives as text (see below). A session an earlier process
created then runs as it would without AZPR installed, with nothing of AZPR's
and no token; the hooks that admit a private session's requests come with
the runtime once the settings load.
- `tool.execute.after`: records tool outcomes and pages large comment-tool
  results into private files.
- `prompt`, `model.request`, `retry`, the tool hooks and a pending approval in
  `permission` also record the stage's last activity for the inactivity
  watchdog, and so do OpenCode's session events for streamed output, followed
  only while a stage is watched.

AZPR registers its tools with `codemode: false` (OpenCode offers only such
tools directly). A tool runs only for an active grant and always on the run's
snapshot repository; it returns numbered, bounded text and, for file reads,
saves the full observed source for comment anchor checks. Failures come back as
visible tool errors so the model can report the gap. A tool reads its call's
`signal` once: OpenCode aborts it when it interrupts the call and, from 2.3.0
on, when a person stops a call whose tool read it. The call then ends at once
and the Azure DevOps request only it waits for (a folder listing of one level,
the PR's threads) is aborted, while a read the run's sessions share (a file, a
recursive listing, the repository archive) goes on for the others and stays in
the run's cache.

Every Azure DevOps call — runtime or tool — goes through one queue
(`azure.concurrency`) with a per-call timeout that aborts the HTTP request.
Reads retry network errors, timeouts, throttling (honouring `Retry-After`) and
5xx twice with backoff; authentication (HTTP 203 sign-in page or 401),
permission, validation and not-found errors and every write fail at once. Files
are cached per run. With debug enabled each call is logged to
`azure-calls.jsonl` (method, call, path or range, attempt, status, duration,
outcome; never comment bodies or credentials). Slots are released in
`finally`, never by a hook. Every request carries the `azure.proxy`,
`azure.caFile` and `azure.verifyTls` transport (Bun's per-request `proxy` and
`tls` options; extra CA certificates are added to the built-in roots). A
rejected certificate fails at once, and an error answer without Azure DevOps'
`X-TFS-ProcessId` header is reported as a proxy's or gateway's answer rather
than as a PAT or permission problem.

Shell is denied by default. With `shell: "ask"` or `"inherit"` reviewers may run
commands under host permissions; that is real host authority, not a sandbox.
Reviewers have no Azure DevOps write tool at all; only the runtime writes.

**What a private session is not told.** OpenCode builds the second system
part of every request from sources: the date, the environment, the
instruction files of the conversation's directory and above (`AGENTS.md`; from
OpenCode 2.3.1 also `CLAUDE.md`, the user's own included; the files a
configuration lists), and what MCP servers, references, skills and CodeMode
say of themselves. All but the first two tell an agent how to work in the
local directory, which is not the PR's repository; with a large instruction
file they also multiply the size of every private request. The `context` hook
therefore rebuilds that part from the date and the environment alone
(`withoutPlaceInstructions` in `host.mjs`). It can do so because OpenCode
2.3.0 to the tested version keep each source as `{ key, text }` in the part's
`metadata.experimental.instructions`, a field the host marks as experimental:
where no part has that form, more than one has it, or a part's text is not its
sources joined, the parts stay as they are and the stage's debug record counts
the request (`placeInstructionsNotToldApart`); what was left out is named
there too (`placeInstructions`). Ordinary sessions are not touched. This
keeps the host's collected instructions out; it does not make a review the
same in every directory, since the environment names the directory and a
reviewer can read local files.

OpenCode's own Claude Code provider (`claude-agent`) does not send the system
parts. Its hook, which runs before any plugin's and before the built-in hooks
that add parts of their own, has already made one text of the instructions
part and kept it in the request's options, and the model is handed that. On
OpenCode 2.3.0 and 2.4.1 that text is the sources but the date and the
environment, joined by a blank line (`claudeInstructions`). For a request to
that provider the sources are left out only where the option holds exactly
that, and the option is emptied with them; where it holds anything else, or
is missing, the parts and the option both stay and the request is counted.
An option of that name on another provider's request decides nothing.

The host also writes into a running session. After a native `read` of a file
of the project it leaves the instruction files between that file and the
conversation's directory there, as a message of its own; and when a source
changes while a session runs, it leaves an update. Neither is shown to a
private session's model: the `context` hook takes them out of every request,
whether or not the parts could be told apart, and an update whatever source
it is of, the date and the environment among them: a session that runs past
midnight is not told the new date by such a message (a session of the same
review that begins afterwards has it from its first request). Which messages
they are is the session's
own word (`hostInstructions` in `host.mjs`). An update is a `system` message,
which only the host writes. A load is a synthetic message that names the
files it holds; that metadata is what the host itself goes by, as its only
record of which files a session was given. Like the notice of a background
command, a load is the late result of the session's own tool call, so it
counts only after an assistant message of the session called the native read
tool: a message of that form in a session that did not read is someone
else's. The hook takes out of the request what is such a message as the host
builds it (`withoutHostMessages`): the user message that has a load's ID and
the load's text as one text part, and a system message of the host's form
that holds exactly an update's text. That is asked of the whole message:
OpenCode gives a load its ID, its role, its content and the stored message's
metadata, and an update its role and its content, and a text part its type
and its text, all of it plain data (a plain object for a load, an ordinary
array for a content, plain objects and arrays of strings for the metadata;
seen on OpenCode 2.3.0 and 2.4.1). A message or a part that carries anything
more holds what the host did not write, and stays: a field of another
hook's, also one that is not listed or stands under a symbol, a value behind
an accessor, an array or an object of another class, an object that answers
for another (a proxy), metadata that is other data than the stored
message's. Each is asked of the object's own properties, taken once from
their descriptors, so that nothing of a message's own is called and looking
at it changes nothing; metadata is compared to its end however deep it goes.
What an object inherits is not looked at, and an update is an object of the
host's own class, which a plugin cannot name. The same holds for a request's
system parts: the instructions part is made anew only where it, its metadata
and its sources are plain data, with what a hook added to them in plain
sight kept, and a part without a source left goes only where it holds nothing
but what the host gave it. The list of a request's messages is looked at
like its items: one that is no ordinary list is left whole. The Claude
provider's option is emptied only where an ordinary object holds it as a text
that can be written, and a source of the instructions part goes only where it
holds nothing but its key and its text. The event itself is read the same
way: what it holds under `system`, `messages`, `options` and `tools` is taken
once from its descriptors, a place is given another value only where it can
be written, and a change is made only where it can be made whole (for the
Claude provider the option and the parts together: where the parts take no
new value the option is put back). A tool is taken out of the list of tools
where the list lets it, and the stage's record counts a request in which one
stayed (`toolsLeftListed`); a planning session that was told to finish
without tools is refused a tool where it calls one all the same, and a note
that could not be added is counted (`notesNotAdded`). Where one of these
cannot be done the request goes out as it is and is counted; none refuses
it. What the hook takes out of a request as the host builds it is
exactly what `requestReview` takes for no one else's input: both go by the
session's record. A system message of another plugin's
stays, also one of the host's form, unless it holds exactly the text of an
update that the session holds: nothing tells those two apart. Beyond that,
who wrote a message cannot be proved, and
a load's text would prove nothing more than its metadata; a message of the
load's form that someone posts after such a read is kept from the model in
the same way, so its text reaches no answer.

What the hook cannot identify stays as it is, as with the system parts, and
no request is refused for what it holds. A message that has a load's ID and
is not the load as the host builds it (another plugin's hook joined
something to it, changed its form or marked it) goes out as it is, and the stage's
record counts the request among those that could not be told apart
(`placeInstructionsNotToldApart`); a load that such a hook gave another ID,
or moved into another message, is not seen at all. So `requestReview`, which fails a turn
that received anyone else's message, asks for no proof of what a model was
shown: what the host wrote of instructions is no step of a turn and no one
else's input, wherever it stands. Anyone else's message fails the turn where
the turn's model was sent it: after the prompt, and between the turn before
and the prompt. A turn that did not succeed fails by its own outcome first,
which decides whether it is tried again.

AZPR does not police other plugins. Its rules hold for a request as OpenCode
builds it, and for a tool's result as AZPR's tool returns it. A plugin's hook
may add to a request, so no check of what a request holds could be complete,
and a request refused for its form would fail every review on a host that
builds requests another way. What another plugin's hook makes of a request or
of a tool's result, before or after AZPR's own, AZPR neither sees nor
corrects, and a plugin that runs in the same process can do anything. Listing
AZPR first among the plugins of `opencode.json` makes its hook see a request
before those of the plugins listed after it; not before a plugin that
OpenCode loads from a configuration directory's `plugin/` or `plugins/`
folder, and not where AZPR's runtime starts after the others (a first
`/pr-setup` in a running OpenCode).

With shell allowed, a command can go on in the background: the model asked
for that, or (OpenCode 2.3.1 and later) its timeout ran out. The shell call's
tool part then says that the command is still running and names its shell,
and when the command ends the host tells the session with a message of its
own, which is that call's late result. `requestReview` takes it as no one
else's input when its metadata says `source: "shell"`, says that the command
ended, and names a shell that a shell call of this same session reported as
running; each such shell reports once (`ownShellNotices` in `session.mjs`).
A notice for a shell the session did not start, a second one, or one without
those marks fails the turn like any other message. Nothing proves who wrote a
message, so this rests on the host's metadata; with `shell: "deny"`, the
default, a private role has no shell call and no such notice is accepted.

**A turn, and what is open during it.** A turn is the admitted prompt and
what follows it up to the first idle marker; its answer is the last assistant
message before that marker, and that marker says how the turn ended. This
follows how OpenCode 2.3.0 to the tested version run a session. A prompt that is
admitted waits in the session's inbox and becomes a message only in the
execution that takes it. An execution is one busy period: it goes on while
input reaches the session, and leaves one marker when it ends, however it
ends, unless the host records that end as a shutdown (below). So the first
marker after the prompt is the end of the execution that had the prompt, also
where the model never answered (the turn was interrupted or failed), and what
another execution wrote after it is not the turn's: a command that ended
later woke the session, and neither what the host wrote then nor how that
ended changes the answer. The session's own outcome is its latest
execution's, which can be that later one.

The host records two ends as a shutdown and leaves no marker for them. Its
own shutdown ends the run with the process. The other is a known limitation:
a step ends that way when a person declines one of its tool calls without a
message, which only a reviewer's shell request can ask of a person
(`shell: "ask"` or `"inherit"`), and OpenCode's terminal UI and desktop app
send a decline in a reviewer's session without one (the terminal UI asks for
a message only in a session that has a parent). The host has given that
step's message an error ("Step interrupted"), so AZPR takes no answer of the
turn and credits none of its reads to a finding. Where no execution follows,
the turn fails as interrupted. Where a background command of the session
ended during that step, the host starts the next execution at once, the turn
takes it in (its model requests and tool calls run while the grant is open),
and the turn fails by how that execution ends: as an incomplete answer where
it succeeds. The stage then goes on by its usual rules: a first turn that
failed as interrupted ends the pass, an incomplete answer is tried again in a
new session as far as `workflow.stageRetries` allows, and a correction or
follow-up turn that failed leaves the latest usable answer standing. A
decline with a message, which OpenCode's permission route accepts, is a tool
error the reviewer goes on from.

A grant is open only during a turn: outside it the `context` hook refuses a
request, the `model.request` hook a request that was prepared earlier, the
`retry` hook a retry, and the tool hooks a call. A prompt opens it, and only
while the call that sent it still waits for the turn: one that the host
admits after that call has ended (the inactivity watchdog stopped the stage
while the host still worked on the prompt) is refused. The end of the wait
for the session closes it. Neither end is the turn's own. The host may have
begun an execution by itself before the prompt was admitted (the notice of a
background command woke the session), whose request does not hold the prompt;
and OpenCode's wait also covers an execution that it starts right after the
turn's, as when such a notice arrives in that moment, whether the turn
succeeded or failed. So before every request of a private session the
`context` hook reads the session's own messages and lets the request through
only where the turn's prompt is among them and no idle marker follows it
(`turnState` in `host.mjs`), which is the line `requestReview` draws
afterwards. The prompt is known among them by the nonce it was sent with
(`promptOf`). Before the prompt is a message, the request is refused and the
turn is still to come. Where input reached the session while it was going
idle, the same execution goes on with it, no marker stands there yet, and the
model's next message is the turn's answer. Where the execution had ended, its
marker is there before the host starts another one, the request is refused
and the grant closes. So a session that the host wakes by itself asks no
model and reads nothing. Where the messages cannot be read, the request is
refused. What follows a request (the request itself, a retry of it, the tool
calls of its answer) needs a request of this very turn that was looked at so.
What a hook reads of the host it reads until its stage ends, so a stage that
was stopped does not wait for a host that stalls. A request of the turn that
is refused, when it is prepared or when it is sent and whatever for (the
turn, the session's agent or model, a look at the session that failed, a
dispatch that was not prepared), also ends what an earlier request of the
turn allowed; a summary that the host attempts beside the turn is none of its
requests, and its refusal ends nothing. A request that is refused because the
session's messages could not be read is counted apart (`turnUnreadable`):
nothing was known of its turn. A stage's record counts those readings and the requests refused
outside a turn (`turnChecks`, `refusedOutsideTurn`).

What a session read, for the check that a finding names a file its own tools
read, is settled the same way, by the host's record and not by the time of a
call. OpenCode names to a tool the assistant message that asked for the call.
A read is kept under that message, and counts once the turn of that message
is looked at and its answer taken: the reads of the turn's own assistant
messages. A file that the session reads after its answer was taken belongs to
no such message, and neither does a call that names none.

Reading a session's messages before every request costs what the session's
size costs: about 3 ms for each million characters of its messages, measured
on OpenCode 2.4.1 (see the
[validation record](VALIDATION.md#051-release-candidate-acceptance-2026-11-26)).

**A command that arrives as text.** OpenCode's terminal UI can submit a
startup prompt before it has loaded the commands (`opencode --prompt`; with
2.4.0 and 2.4.1 nearly always, and then often to the built-in free model, see
[debugging](DEBUGGING.md#a-startup-slash-command-becomes-an-ordinary-prompt)).
`/pr-review <URL> …` is then an ordinary prompt: no command runs, and a model
would receive the URL and the context. The `prompt` hook refuses a prompt of
an ordinary conversation that begins with one of AZPR's commands, at its very
first character as OpenCode's prompt box takes a command, and leaves a notice
there that says what happened. It is the one prompt that AZPR refuses for
its text (the other one it refuses names one of AZPR's private agents, which
cannot be mentioned or delegated to); a prompt that only mentions a command,
begins with another name, or shows a command after indentation or a blank
line (an example) is the person's own. The rule needs no settings: a
process without usable settings (before a first setup, or with settings of
0.4.x that wait for their update) refuses such a prompt as well, in a hook
that setup registers beside its placeholder commands and that stands aside
once the runtime is loaded. With AZPR switched off (`enabled: false`) the
server part registers nothing, also not this hook. The terminal UI answers a
refusal by trying again in new conversations, which stay empty.

## Setup

Setup has two ways in and one writer. `/pr-setup` with options saves what
they name. In OpenCode's terminal UI, `/pr-setup` without options opens
dialogs: the command answers with its guidance as before, marks that notice
with `metadata.azpr.setup`, and the package's terminal part, which sees the
notice arrive in the session on screen, starts asking (the command palette's
"AZPR: settings" starts it too). Other clients show the guidance.

**The dialogs only ask.** `src/tui-setup.mjs` holds what is asked and in which
order, and imports nothing, so its order is tested with scripted answers. It
uses the host's own dialogs (the ones of `/connect`, `/models` and OpenCode's
settings) through the TUI plugin API, plus one field of AZPR's own for the
token, since neither the host's text prompt nor OpenTUI's text fields can hide
what is typed: that field takes keys and pastes itself, keeps the value in a
closure and draws bullets and a count, so the token is never in a cell of the
screen. Every answer goes to the server part over the plugin's RPC
(`azpr.setup`, registered with `ctx.rpc.register`), the way OpenCode's own
`/goal` talks to its server part. The terminal part reads and writes no file,
contacts neither Azure DevOps nor a model, runs no command and stores nothing;
the token is passed on once and is in no toast, dialog text or log. Each
project directory has a server part of its own: the dialogs of one setup
talk to the one of the session that was on screen when they opened, also
when another session comes on screen before they end. When the terminal
part is unloaded, a setup that is open ends at its next step and saves
nothing more.

**The server part knows the settings.** One table in `src/setup.mjs` (`ROWS`)
names what setup can set: organization, token, proxy, CA certificate file, the
review, quick and deep models, output language, what follows a review, the
report in the conversation, progress notices, the review panel and debug
records. Each row reads its value, shows it in a few words, takes an answer as
a person gives it and writes it. The dialogs draw whatever rows the server
part describes, and the options of `/pr-setup` are the same rows, so an answer
is checked the same way wherever it comes from. Everything else stays in the
settings file, which the list names; `shell` and `azure.verifyTls` are
deliberately not rows, and `rater` has none either.

A mode's models are one row whose value is a list (`reviewersFrom`). As text,
which an option and a dialog give alike, one model alone stands for the
mode's usual number of passes (`USUAL_PASSES`: two for `/pr-review` and
`/pr-deep`, one for `/pr-quick`), `MODEL*N` for N passes, and entries
separated by commas for different models, at most four passes in all; `off`
empties the list of quick or deep. The dialog asks for one model first and
then for the passes, in a list whose first row takes what is shown; the other
rows add a pass of the same or of another model, or take the last one away.

The RPC has four methods, and none of them throws: what went wrong is an
answer in AZPR's own words that never quotes the value it refused. Their
schemas are loose for the same reason, since the host's schema error would
quote the input.

| Method | What it does |
| --- | --- |
| `status` | The rows with their values, the settings file, and `state`: `required` (there are no usable settings), `migrate` (the settings are of 0.4.x, with or without a fault: the answer then carries what the update changes, as lines, and the word that confirms it; the rows are shown as they will be and cannot be edited before), `ready`, or `restart`. For settings in use, `restart` is the loaded runtime's own answer, by the rule of its preflight: the settings text differs by more than the defaults a load wrote into it, or the PAT file holds another token, whoever changed them. For a process that found no usable settings, it means that there are usable ones now which it did not load. Never the token, and a proxy without its user name and password. |
| `validate` | Whether answers can be used, their saved form and how they may be shown, without saving anything. For a proxy with a user name and password only how it may be shown comes back; the dialog keeps what was typed. |
| `check` | Asks Azure DevOps once whether a token works for an organization (`access` in `azure.mjs`: at most one pull request of the organization; not repeated, since a person waits), with the token given or else the saved one, and the proxy and CA file given or else the saved ones. The saved token is the one the settings name (`azure.patFile`, else `azure.pat`), as the runtime reads it; the default PAT file is none unless they name it. It goes only where the saved settings send it: to the organization it was saved for, through the saved proxy and with the saved CA file; anything else needs the token entered with it. The answer says what was refused and which answer to ask for again: the token, the organization, the proxy or the CA file. |
| `save` | Applies answers and, when one was given, the token. Organization and token change in one step, the write of the settings file. A token is saved with the organization it was checked for: the one this save sets, or the one the request names, which must still be the one in the settings; and the organization of settings that name a token (usable at the moment or not; also from no organization to one) changes only together with a token of the new one. Setup takes as a token one word of letters, digits, `-` and `_` of 20 to 1,024 characters, which is also what it requires of a token file before it replaces it, so that it can replace what it wrote. A token of the organization the settings named already replaces the token file they name. Every other token (a first setup's, another organization's, and one for settings that name the default PAT file of setup with options, which every settings file a person has may use) gets a file that did not exist: `pat-<organization>`, or that name with the first free number, beside the file the settings name or in AZPR's directory, taken in one step that refuses a name which exists; the settings name it in the same write. Setup thus overwrites no file but the one these settings name for this organization, whatever other settings files share the directory, and a reader of the settings and the file they name always has a pair that belongs together. A file a save made is removed again when its settings are not written, and only then: a settings file that is in place stays reported as written when a temporary file or the lock cannot be removed after it. Where the token these settings had before stays in its file, the answer says where. Both files are written under the setup lock, after the settings file was compared once more with what the answers were checked against: the token file first (created or replaced in one step, mode 600, in a directory no one else can write to; an existing file is replaced only when it is a regular file of the user's own that is empty or holds one such token, since settings can name any path), then the settings, through the same atomic, owner-only writer as before. A save that finds the lock held writes neither. A save with `migrate`, the word `status` gave, writes the update of settings of 0.4.x and nothing else: with anything else in the request, or with another word, nothing is written. While such settings wait for their update, every other `save`, and `validate` and `check`, answer that they need it. |

A proxy that a dialog shows without its user name and password stands for
the saved one when it comes back unchanged, so those never leave the server
part.

**What is asked, and when.** A first setup asks for what a review cannot run
without: organization, token, model (one model, which the server part lists
twice for `/pr-review` and once for `/pr-quick`). The proxy is asked before the token,
because the token is checked over the network, and it can be skipped; the CA
certificate file follows only a proxy. When the check cannot reach Azure
DevOps, or a certificate is refused, the dialogs show the reason and offer
the proxy or the CA file again before the same token is checked once more;
the token can also be saved unchecked. Posting comments without a preview is
confirmed in a list whose first row keeps the current setting.

**Settings of 0.4.x are updated only on a confirmation.** A settings file
with `version: 2` is no settings file of this version: validation refuses it
(`needsMigration`), so the process has no usable settings, its review
commands answer `SETTINGS UPDATE REQUIRED`, and the completion of missing
settings leaves the file byte for byte. Nothing rewrites such a file but the
update a person confirms. `/pr-setup` alone shows what the update changes
(`migrationLines`): for each mode the models it had and the passes it gets,
what becomes of the rating, the settings that are dropped, and every change
in behaviour nobody asked for (a rating that now runs; automatic publication
that now posts findings no verifier confirmed). In the terminal UI the
dialogs show those lines and ask in a list whose first row keeps the file;
other clients confirm with `/pr-setup --migrate <word>`. The word is a keyed
digest of the text the update replaces and the text it writes, with a key of
the process (`migrationOf`), so a confirmation holds only for the change that
was shown: a file that changed since, or a restart, needs another look. No
other option, save or load implies that consent: not the options of a first
setup, not the completion of missing settings, not the installer, which
carries such a file over byte for byte.

What the update writes is `migrateSettings` in `config.mjs`, a pure function
that loses and invents no value. The functional and the risk model of a mode
become its two reviewer entries, in that order, where all three models of
the mode were set; anything less was off and stays off. The verifier model is
dropped, the quick reviewer becomes a list of one, a named rater stays (an
empty one now lets the first reviewer model rate), `models._help` and
`workflow.shardFindings` are dropped, and every other value keeps its place.
The file is written by the same writer, under the same lock and comparison,
as every save, and a process that had no usable settings loads it at once, by
the rule of a first setup.

A version-2 file with a fault, or one that was never completed, is no
exception: the update comes first and the repair after it, since a repair
that rewrote the file in this version's layout would convert it unseen.
Validation refuses a version-2 file before it reads anything else of it, and
every other option of `/pr-setup` answers that the settings need the update
first. Where the updated file still cannot be used (a placeholder for a
model, an invalid value), the lines the update shows end with `After the
update the settings still cannot be used: …`, and after the update
`/pr-setup` sets what is missing.

**A first setup is loaded at once.** A process that found no usable settings
registered only `/pr-setup` and the commands that answer `SETUP REQUIRED`.
The command list describes each of them as not ready here and names
`/pr-setup`: words that also hold when the settings were saved elsewhere
since and wait for a restart, which `/pr-setup` then says.
Once a save of its own setup (the dialogs' or the command's) makes the
settings usable (the text it replaced could not be used, it wrote
something, and they can be used after it), `setupPlugin` removes those
commands and loads the runtime:
nothing was read before, so this is the one time the settings are read. Only
that save does it, and a later save of the same setup tries again when
loading them failed, as long as the settings file and the token file it
names have held nothing but what this setup wrote (remembered from what each
save wrote, the token as a digest, not from a later look at the files): both
are compared with that before the load (one save has the turn at a time,
through the RPC or `/pr-setup` with options, until the load that follows it
has ended), and afterwards the runtime must have read what the
files hold and they must hold what was saved (settings that were switched
off meanwhile load nothing, which is no load). The commands that say so come back
meanwhile, except under a name that another plugin has taken by then, which
is looked up again at that moment (adding a command would replace that
plugin's); where the host cannot list the commands, none is registered
until the next `/pr-setup` can. A load and this putting back run one after
another, never interleaved.
Another OpenCode process, or another project directory
of the same one, that had found no settings reads none either when they
appear, whoever wrote them: its review commands answer `RESTART REQUIRED`,
its setup reports `state: restart`, and what that setup saves afterwards
waits for the restart too, since something else made the settings usable. A
restart stays the moment at which settings from elsewhere take effect.
Settings that are in use are read once as well: a later save leaves
`state: restart`, the dialogs say so at the setting, and the runtime refuses
new runs until the restart as for any changed file.

OpenCode 2.3.0 to the tested version announce a change of commands that a plugin makes
after it was loaded without the location, and their clients ignore such an event, so a
terminal UI would keep suggesting the commands as they were. The server part
therefore publishes an RPC event (`loaded`) when it has loaded a first setup,
and the terminal part reads the commands again when it hears it.

## Terminal panel

OpenCode shows what a plugin tells a conversation (a synthetic message) as
plain text, whatever the text is, and a plugin's server part has no other way
to show something in a conversation. The package therefore has a second part,
which OpenCode's terminal UI loads when the plugin is active (`./tui` in the
package's `exports`; `tui.js` in an installed directory): a panel in the
host's `session.panel` slot that lists the sessions of a run and shows the
newest report or comment preview as rendered Markdown.

The panel is a reader first. It sends no prompt, calls no Azure DevOps API
and reads no settings file (the dialogs of [setup](#setup), which the same
terminal part brings, are a separate piece with rules of their own). The one
thing it sends is the command of a step a person picked: `/pr-comment` for
what a review or a preview offers, `/pr-stop` for a run under way (see
[what can be done next](#what-can-be-done-next)). What it shows comes from
three things the runtime already produced:

- AZPR's notices in the conversation: `[AZPR <run>] STARTED …`, `PROGRESS — …`,
  a receipt, or `[AZPR] …` for a command that answered at once. A receipt
  names each stage's session, and either encloses a document in
  `<azpr_report_data>` or `<azpr_comment_data>` or names the session the
  report was queued to.
- That session's inbox, where the queued report waits (`# AZPR <run> — …`).
- `metadata.azpr` of the sessions the host lists, which ties a session to its
  run and conversation while the run has no receipt yet.

`src/tui-model.mjs` works out what to show from these as plain data, without
any host import, so `npm test` covers it. It also holds the reader
(`createReader`): what the panel asks the server of sessions other than the
one on screen (lookups, inboxes, delivered messages, the list of a
conversation's sessions), in which order, how often again after a failure,
and what it does with an answer that arrives after the server reconnected,
after its session was deleted or after the plugin was unloaded. The view gives
it the host's functions; the tests give it answers that arrive when they say
so, and one of them draws the order of answers, notices, deletions and
reconnections from fixed seeds and compares, after every step, what the
reader holds with what it was told. `tests/tui-model.test.mjs` runs it
against `renderReceipt`, and a runtime test against the notices of a whole
review, a preview, `--show` and a check: a change to their form fails there
and not in a terminal. A comment run is shown together with the review it acts
on, which its STARTED notice and its receipt name; any other run stands alone,
so a review under way never shows the report of the review before it.

The panel is about what happened last in the conversation: a run that
started, progressed or ended, or a saved preview shown again, which names its
review (`/pr-comment <review> --show` makes that review the current one, and
the panel shows that review's status, sessions and preview). What the model
takes as fact is the runtime's own text, never a model's. A receipt that
encloses nothing, as a comment run's does when it failed before it had a
preview, is no document: the report of the review it acted on stays in view.

- A row's state is `running` while the host says that the session's model is
  at work. Otherwise it is what the run's receipt says of that stage
  (`complete`, `failed`), and `finished` until a receipt names it: the host
  calls such a session idle, which reads like a fault for a reviewer that has
  answered while another session still works. A session no receipt names, such
  as the planner of a comment run that `debug.enabled` kept, stays `finished`.
- A receipt is a notice whose status word is followed by `;`, a line break or
  the end. A run also says other things under its ID, such as `Automatic
  preview skipped: …` after the receipt of a review without findings; those
  change nothing shown, and do not make their run the current one when
  another run has started since.
- Stage lines and the report session are read from a receipt's lines before
  the report or preview it encloses. A line in the enclosed text that looks
  like one is just text.
- A session is a row, and a report is read from its inbox, only when the
  session's own `metadata.azpr` names this conversation and the run: one of
  the runs shown for a row, the run of the receipt that named it for a
  report. A session that AZPR 0.4.0 or earlier created has no such metadata
  and is a child of its conversation; that counts the same. A named session
  the host has not loaded is looked up first, the session itself and nothing
  it holds, so that no inbox is read before its session proved to be ours.
- In one of AZPR's own sessions the panel reads the conversation's notices
  and those of that session: the runtime answers a command typed there
  (`/pr-comment` in the session that holds the report) in that session, and a
  preview planned after the report takes the report's place. The conversation
  is the one the session itself names (its metadata; for a session of 0.4.0
  its parent, when it carries AZPR's title). Its notices are read from the
  server, since the host has them only while the conversation is on screen
  or in a tab: what waits in its inbox and what was delivered since (a
  notice is delivered once the conversation's model runs). The inbox is read
  first and the messages after it, so that a notice delivered between the
  two reads is in one of them, and what the inbox answered is kept when the
  messages cannot be read. From the moment a session's notices are asked
  for, each notice the host reports for it is kept: while the requests are
  under way, after they failed, and afterwards. A read that was asked before
  the server reconnected is dropped when it answers, and everything is read
  again. The session's own report is shown only for the review shown, or
  while nothing is known of any run yet: a status never stands above another
  review's report.
- The Markdown shown is the saved Markdown. The cells of the summary table,
  which the runtime writes with numeric character references for Azure
  DevOps, are decoded, each character escaped so that Markdown reads none of
  them as markup: a backtick stays a backtick and `__init__.py` keeps its
  underscores, as on the PR. AZPR's marker lines are left out. Both happen
  only where the runtime wrote them: a marker that stands alone between
  blank lines, and a table that begins after a blank line with the
  summary's header and its delimiter row. A reference or a marker inside a
  code block, inside a code span that runs over several lines, or anywhere
  else in a finding's text stays as it is, so the preview on screen is the
  preview that publication posts.
- A notice's block ends at its closing tag, so that tag cannot stand in the
  enclosed text. `enclose` (`attribution.mjs`) writes it there as
  `&lt;/azpr_NAME_data&gt;`, and gives text that already holds that form, or
  one escaped further, one more `&amp;` on each side, so that nothing in the
  block can be read two ways. The panel takes one level off again
  (`disclose`): a finding that quotes the tag, in a review of code that
  handles such notices, is shown with the tag, as it is posted. Every block
  is written through `enclose`; a test takes texts of all these forms there
  and back. A notice that 0.4.1 or earlier wrote, still in a conversation
  after an upgrade, has the tag in the same form but left a text's own
  entity form as it was, so there such a form is read as the tag.

`src/tui-view.jsx` is the view and the wiring to the host. What the host does
decided several things in it:

- **The keyboard.** The host gives the keyboard to a panel that opens and has
  no way to open one without it. The panel hands it back to the prompt
  (`pane.focus.left`), so the next command can be typed while a report is in
  view. That happens a moment after the panel mounted; the step acts only
  while this panel is still the one open in that session, and its timers end
  with the panel, so another plugin's panel that took the place is left
  alone. A click in the panel's text gives it the keyboard, and its keys
  (scrolling, Escape or `q`, and those of what can be done next) are a keymap
  layer of the panel, active only then. A click on one of the steps at its
  foot is a button pressed, not the keyboard asked for: the host gives a panel
  the keyboard on mouse down, so the step stops that event, and what is typed
  next still goes to the prompt (a key of the panel typed there would
  otherwise act instead of being a letter). The release of the mouse button
  that ends a selection of text is no click: text selected down the panel
  can be let go over a step, a session's row or `close`, OpenTUI sends that
  release to what lies there, marked as dragging, and none of them acts on
  it. A click on a step is the button pressed and let go on that step of the
  same offer, with the pointer still on it: a preview can be planned again
  while the button is held, and the release then picks nothing; a step that
  was pressed and then left is not picked either, although OpenTUI sends the
  release to the element that was pressed; and a press ends with any other
  press or release the panel sees, so that a gesture that was given up does
  not make a later release a click. The steps are drawn from their names, so
  each keeps its element while the panel's content is worked out again, which
  every notice and every answer of the server causes: OpenTUI finds what lies
  under the pointer in the frame it drew last, and a step that was made anew
  since is not in it, so a press or a release in that moment went nowhere and
  the click was lost (0.4.4 drew them from objects made anew each time). A panel that
  opened by itself and cannot hand the keyboard back closes again and shows a
  toast instead: in a terminal too narrow for two panes, where the host shows
  the panel alone, and while a dialog is open. Nor does it open by itself
  while another plugin's panel is open in that session, since the host shows
  one panel at a time.
- **Other sessions' data.** The host keeps the messages and the inbox of the
  session on screen and of open tabs, and drops those of other sessions again.
  The panel therefore reads the inbox of the report session from the server
  itself (`client.session.inbox.list`) and keeps what it read. A session the
  server no longer has is counted as deleted, not listed, whatever the host
  still holds of it and whatever a lookup under way answers later. Only the
  server's answer establishes that: a not-found error, a lookup that
  succeeded and found nothing, or the host's report of a deletion. A request
  that failed on the way says nothing about the session and is tried again,
  three more times and further apart; while a lookup waits for its next
  attempt it stands for its session, so the panel's asking again whenever
  something changes starts no attempt and uses none up. The panel
  keeps the inboxes of the 24 sessions it read last; one it let go is read
  again when it is needed. A session with a read under way is held beside
  those 24 and is not let go, however many others are read meanwhile: what
  a read's requests answer one after the other, and what the host reports
  in between, are held together, and the read is marked as done only with
  all of it. It takes none of the 24 places either, so what the panel shows
  stays held, and is not read again, while other reads wait for answers. A
  session whose read has ended is the one read last.
- **Leaving and returning.** The host closes a panel when the screen leaves
  its session, which a click on a session row does. The panel is opened again
  when the screen returns to a session in which it was open and which the user
  did not close it in.
- **After a TUI restart** the host has not loaded a running run's sessions.
  The panel asks the server for the sessions once per conversation and takes
  those whose `metadata.azpr.conversation` matches.

`/pr-panel` is the panel's only command. Whether it opens by itself is the
setting `terminalPanel` (`auto` or `manual`). The panel runs in the TUI's
process and cannot and must not read AZPR's settings file, so the runtime
tells it: with `manual`, every notice AZPR queues carries
`metadata.azpr.panel: "manual"` (`session.synthetic` stores metadata with a
notice and never sends it to a model), and a notice so marked opens nothing.
With the default no such mark is sent, so those requests are the ones earlier
versions made. The panel keeps no preference of its own.

### What can be done next

A receipt ends with the commands for the next step, but the panel shows the
document a receipt encloses, not its closing lines, and a person who reads the
panel would have to look for them in the conversation. A notice that offers a
next step therefore carries it as data as well, in its metadata (`azpr.next`,
made by `previewActions` in `comments.mjs`): the receipt of a preview, the
saved preview shown again, and the receipt of a COMPLETE review that no
preview follows by itself (`afterReview: none`, a review that was stopped, or
one without findings to comment on). It says which review and PR it is, in the
runtime's words; whether a preview is still to be planned; whether the preview
can be posted (not while it is held, nor when every finding is left out) and
how many items it holds; whether the findings can still be adjusted (not once
publication has started); and each finding the review can publish, with the
level it is published at, the review's own level where a person changed it,
whether it is left out, and its summary. No model reads a notice's metadata,
and every other notice is sent as before. A review with more than 200
findings offers nothing: half a list would let a person replace adjustments
they cannot see.

An offer goes with the document its notice encloses: it is true of the review
as that document was rendered. A review's receipt encloses a report: it offers
planning a preview and adjusting the findings before it, never posting, and
only for a review that nothing has acted on since (a command can name the
review from its STARTED notice while its sessions are still cleaned up). A
preview's receipt offers what is done with that preview. The command locks
are released before a run's sessions are cleaned up, so another `/pr-comment`
command may have adjusted the review, planned its preview again or posted it
by the time the receipt is written (`previewState` in `runtime.mjs`: the plan
and the adjustments, each of which a command replaces with another object,
and what publication has recorded, which every publication writes anew, also
one that follows an earlier publication; nothing is awaited between that look
at the review and the receipt's text and offer, and the record is saved after
them, so the document, the offer and its word are of one moment). Such a
preview is no
longer what would be posted: the run then ends with a receipt of a status of
its own,
`[AZPR <run>] REPLACED; source review=<id>`, which encloses nothing and
offers nothing. It does not make its review the conversation's current one,
since it says nothing a person acts on. The panel's model takes it for the end
of that run, so that a panel which showed the run as running sees it end, but
not for what happened last: where the other command was answered in the same
conversation, the panel goes on showing that command's preview and offer, and
where it was answered elsewhere (typed in the review's own session), the
review's report stays in view.

The panel's model (`nextOf`) checks every value, since commands are made of
them: the review and each finding by the form of their IDs, each level by
name. Anything that is not as expected, or an offer for another review than
the one shown, offers nothing, and the commands are typed as the receipt says
them. `buildPanel` also holds an offer to its document (planning only under a
report, never under a preview) and gives it the ID of its notice (`offer`).
Only the notice that happened last offers: once a run starts or another
receipt arrives, what a review or a preview offered is gone.

**A run under way offers to be stopped.** A STARTED notice ends with the
command that stops its run, in the conversation and with an ID to copy. The
same notice therefore carries the run's ID as data (`azpr.next.stop`, written
where the notice is sent, `launch` in `runtime.mjs`), for every command that
starts a run: a review, a quick or deep review, a comment run, also the one
that follows a review by itself, and a check. The model (`stopOf`) takes it
only as an ID of the right form that names the run the very notice starts.
That notice offers from then until its run has a receipt, whatever progress
the run reports in between (progress notices carry nothing and are sent as
before), and it offers nothing else: the row at the foot is **Stop this
run…** alone. Its offer is the STARTED notice's ID, so a step that was picked
for one run is not taken for the comment run that follows it. The step asks
first, in a list whose first row lets the run go on and names the run and its
command, and then sends `/pr-stop <run>` to the session on screen. The
command names its run and needs no word like `--seen`: the runtime stops a
run only while it is under way and only from its own conversation or one of
its sessions, so a step that reaches it late stops nothing, and never another
run. What the runtime answers to a stop is a notice that is neither a start,
progress nor a receipt, and changes nothing shown: the run is under way until
its receipt arrives (`CANCELLED`), which in the fixtures takes a fraction of
a second. A run whose STARTED notice an earlier version wrote, and a run that
the panel shows as running after the OpenCode process that ran it was
restarted, cannot be told from here: the first offers nothing, and a stop of
the second is answered with "No active review in this conversation matches
that request". The step stands where the first step of a receipt stands. A
click that was aimed at it in the moment its run ends is therefore a click on
that first step, pressed and let go on one offer like any other: after a
preview that is **Post N comments…**, which asks first; after a review that no
preview follows (`afterReview: none`) it is **Preview comments**, which is
sent at once, so a preview is planned that was not asked for. Nothing is
posted by it.

`src/tui-actions.mjs` turns an offer into the steps and into the commands
they send. It imports nothing, so the order of its dialogs is tested with
scripted answers. The view draws the steps as one row at the panel's foot
(`Button` in `tui-view.jsx`): on the panel's own ground under a line that
crosses it, in place while the text scrolls, level with the host's status bar
beside a conversation, and wrapping as whole items where they do not fit. A
step is clicked, or picked with its key while the panel has the keyboard; the
key is drawn in its colour only then. A label that ends in "…" asks before
anything is sent. Posting asks in a list whose first row posts nothing, and
stopping in one whose first row lets the run go on: the host's confirm dialog
would confirm by default. What is typed into such a question finds a row by
the beginning of its title (the list's own `search`, `byBeginning`): the
host's search finds a letter anywhere in a title and selects the best match,
and the key that opened the question, pressed once more than meant, is typed
into it. `s` is in "Yes, stop it" and not in "No, let it run", so the host's
search would leave "yes" as the only row for Enter to take; by the beginning
of a title it leaves none. Adjusting lists the findings;
picking one chooses its level or leaves it out, and everything is applied
with one command that gives both lists in full, since each list of
`/pr-comment` replaces the saved one. It is applied from the foot of that
dialog (`DialogSelectOptions.actions`, `ctrl+s` or a click), which stays in
view however long the list is, and from the list's last row, for a host that
draws no such foot; the foot's action does not close a dialog, so it closes it
itself, once and only while that list is the dialog that is open. Every command names its review (`/pr-stop` its run), so that what is on screen is what is
acted on, whatever the conversation's current review is by then. The view
sends it with `client.session.command` to the session on screen, as the
host's own prompt does for a typed command, and the server part takes it like
one: its checks, its notices and its receipt are the same.

A dialog can stay open for any time. With each step the view gives the
actions a way to ask whether the step is still what the panel offers
(`still`): the same panel, still drawn and the one the host shows in that
session, with the same notice offering. An answer that comes back for
anything else sends nothing and says so in a toast: a preview that was
planned again while the question was open is not posted unread, a run that
has ended meanwhile is not asked to stop, and nothing goes to a session that
left the screen.

That check knows only what this conversation was told. A command typed in a
review's own session is answered there, and another client's panel may have
its own question open: the review changes, and no notice arrives here. So an
offer also carries one word for the review's comments as they are
(`commentToken` in `comments.mjs`: the review, the moment its saved preview
was planned, or none, and the adjustments; the record holds all of it, so the
word is the same after a restart), and every command the panel sends hands
the word back as `--seen`. The runtime compares it when the command arrives,
before the review becomes the conversation's current one, and again under the
comment lock, and refuses a command whose review is no longer as it was
shown, before anything is planned, saved or posted: a step refused when it
arrives changes nothing, also not which review a command without an ID acts
on next. Posting does not change the word, since what was shown can be posted
again. A command a person types carries none and acts on the review as it is.
One action runs at a time; a command
that the server part refuses, or that does not get there, is said with the
reason given, as the host says it for a typed command; after the terminal part
was unloaded nothing is asked or sent. A host without that client call or
without the list dialog shows no steps.

The panel reads a document from its beginning when another one takes its
place (a preview planned again), and keeps one empty row under its header,
which the text that scrolls never touches. Where it has no document to show
it says so: "No report or preview yet." while a run is under way, and "This
run ended with no report or preview to show." once the run has a receipt (a
run that was stopped, or one that failed before it had anything), since "yet"
would have a person wait for what is not coming.

**Why a compiled file.** OpenCode compiles a plugin's JSX when it loads it,
but OpenCode 2.3.0 through 2.3.2 (OpenTUI 0.8.4) skip every file under
`node_modules`, where they install npm and Git packages, so JSX in the package
fails to load there. anomalyco/opentui#2051 compiles such files again from
OpenTUI 0.9.0 on, which OpenCode 2.4.0 brought. `scripts/build-tui.mjs` compiles `tui-view.jsx` to
`src/tui.js` with the settings OpenTUI itself uses for plugin JSX
(`babel-preset-solid`, the universal renderer imported from `@opentui/solid`),
and the result is part of the repository and of the package. The compiler is a
development dependency at an exact version; `npm run check` fails when the two
files differ. The package still has no dependency, no install script and no
build at installation. The compiled file imports only what the host provides
to plugins (`@opentui/solid`, `@opentui/core`, `solid-js`) and the model
beside it, since a copy of its own would be a second renderer;
`tests/release.test.mjs` holds that. The tested OpenCode now compiles the JSX
of installed packages, and the package still ships the compiled file, which
every one of these versions loads; the [roadmap](ROADMAP.md#shipping-the-terminal-panel-as-jsx-source)
says why.

## Compatibility

`host.mjs` normalizes list/record response shapes, detects optional capabilities
(`permission.hook`, `plugin.list` and others) and holds the host continuation text.
What a host that lacks something shows a person:
- Registration needs a set of methods, `tool.transform` among them
  (`requireMethods` in `runtime.mjs`). Where OpenCode starts with usable
  settings, a host without one leaves AZPR unregistered, and the host's plugin
  list reports that with the error; so does a host without what setup itself
  registers with (`command.list`, `command.transform`). During a first setup
  on a host that has those, the runtime is loaded when the setup is saved:
  where a method it needs is missing, the setup's own commands stay, and they
  and `/pr-setup` say that the saved settings could not be loaded, and why.
- A command whose workflow needs a method the host lacks fails with an error
  that names the method: the review workflow's session methods before its
  STARTED notice; the model catalog (`model.list`) at the readiness check
  every run begins with, after STARTED, so that run ends INCOMPLETE and its
  receipt names the method. Posting a saved preview asks for no model
  catalog.
- Without `permission.hook` the project boundary for native read tools is left to
  the host's own permission rules; `/pr-check` shows a WARNING row and reviews
  still run.
- With `plugin.list`, `/pr-check` names the installation that runs and warns
  about any other AZPR entry the host configured but does not run, such as a
  second version that OpenCode 2.1.4 to the tested version list as a duplicate
  plugin ID; a host without it gets an information row.

`/pr-check` names the detected OpenCode version in a row of its own. On another
release than the tested one (`TESTED_HOST_VERSION`), and on a host that reports
no version, that row is `ok` with a note naming the tested release: reviews run
on an OpenCode V2 host that provides what AZPR needs, which AZPR checks as above.
Until 0.5.1 that row was a WARNING. Other receipts do not repeat the version.
REST paths and the pinned api-version live only in `azure.mjs`; see
[Azure DevOps access](AZURE_DEVOPS.md) for the API list and version policy.

The terminal part runs in the TUI's process and does not share `host.mjs`. At
setup it checks that the host offers the parts of the TUI plugin API it uses
and stays out of the way otherwise; it reads theme tokens through fallbacks,
since their names have changed between OpenCode releases.
