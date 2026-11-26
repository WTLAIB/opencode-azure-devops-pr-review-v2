# Roadmap

Tested with the OpenCode CLI release the README's
[Compatibility](../README.md#compatibility) row names, the Azure DevOps
Services REST API (api-version 7.1) and Ubuntu 22.04. [Current validation](VALIDATION.md) records what this revision was tested
with; [validation history](VALIDATION_HISTORY.md) keeps earlier results.

## Implemented (stability revision)

- **One pipeline for every mode (0.5.0).** `/pr-review`, `/pr-deep` and
  `/pr-quick` run the same stages with the same prompts: reviewer passes, a
  duplicate check, a severity rating and comment planning. A mode is its list
  of models (`models.<mode>.reviewers`, one to four entries, which may
  repeat); an empty list leaves `/pr-deep` or `/pr-quick` off, and no mode
  falls back to another mode's models. It replaced the functional and the
  risk reviewer, the verifier and the separate quick review of 0.4.x (see
  [Deferred](#a-verifier-as-an-optional-stage)).
- **Passes instead of roles (0.5.0).** Each entry of a mode's list is one
  pass: an independent session per shard that covers function and failure
  behaviour and checks each of its findings against the source it read.
  Passes do not see each other's work and share one bound on parallel
  sessions.
- **No stage verifies a finding, and every review says so (0.5.0).** The
  runtime checks only the form and source of a finding (a required location
  that exists at that commit, in a file the session's own tools read):
  passing findings are REPORTED, the rest NEEDS_INFO. A usable PARTIAL answer
  that names unfinished work gets one follow-up turn in the same session. A
  review records `verification: none` and how its findings were produced, and
  reports, receipts and the disclosure line of comments state status,
  coverage and method separately.
- **A duplicate check across reviewer sessions (0.5.0).** The runtime numbers
  the findings in a fixed order (`F-1 … F-n`, by place and then by pass) and
  removes records identical in every field. Where different sessions
  reported findings on one side of one file, a session of the first reviewer
  model merges repeated reports of one defect (the same root cause and the
  same correction); the runtime refuses a merge of two findings of one
  session, and a failed check keeps every finding.
- **A blind severity rating by default (0.5.0).** After the duplicate check,
  sessions without tools set each reported finding's level from its text
  alone, without the level its reviewer gave it, so that the findings of
  different reviewers stand on one scale. The first reviewer model rates
  unless `models.<mode>.rater` names another model or is `false`. From 0.3.7
  to 0.4.6 the verifier set the level, and a rating ran only with a named
  rater.
- **Coverage in two numbers (0.5.0).** With several passes a review states
  the changed files reviewed in at least one pass and those reviewed in
  every pass. A pass that fails costs depth and leaves the others' work.
- **Local instructions stay out of a review (0.5.1).** A private session
  gets AZPR's own instructions and OpenCode's date and environment. What
  OpenCode collects for the conversation's directory (instruction files, what
  MCP servers, references and skills say of themselves) stays out of it, and
  so do the instruction files OpenCode loads when a reviewer's native read
  reads a file beside one, which used to fail the pass. With a `claude-agent`
  model this holds for what OpenCode hands the Claude Code program; what that
  program reads by itself was not tried.
- **OpenCode 2.4.1 as the tested host (0.5.1).** With what 2.3.1 to 2.4.1
  changed for AZPR: a release the terminal UI makes up late, for a button
  whose own release was lost, no longer picks a step (one it makes up within
  a second of the pointer's last movement still can), a usage limit set by a
  ChatGPT workspace's admin is
  named and not retried, a command that goes on in the background no longer
  fails its pass where shell is allowed, a private session runs only while a
  turn of it is open, and one of AZPR's commands that reaches OpenCode as an
  ordinary prompt is stopped before a model gets it.
- **OpenCode 2.4.2 as the tested host (0.5.2).** No change to how a review
  runs: in the host fixtures, 2.4.2 sends private sessions what 2.4.1 sent,
  request by request. `/pr-check` notes
  another OpenCode version instead of warning of it, the tested release is
  one constant that CI, the installer and the README follow, and the error
  for a reviewer's prompt that is gone names the causes it may have, a
  prompt taken back in the terminal UI among them.
- **Rows the host's read returns whole (0.5.1).** The pages of AZPR's
  private data hold rows short enough for OpenCode's native read, which cut
  every row after 2,000 characters, so a model that read a large value in
  pages got about two thirds of it. Pages of a saved review that do not fit
  are written in the new form, beside the old ones, whenever it is used.
- **Stages in one order (0.5.1).** A review's receipt lists the stages by
  their place in the pipeline, and the report is in the last one that did
  not fail, whichever session OpenCode created first.
- **Settings of 0.4.x are updated on a confirmation (0.5.0).** A version-2
  settings file is left as it is and not used. `/pr-setup` shows what its
  update changes and writes the new file only for a confirmation of that
  very change: in the terminal UI in a list whose first row keeps the file,
  elsewhere with `/pr-setup --migrate <word>`. Reviews saved by 0.4.x can
  still be shown, previewed and published, with the comment wording of the
  version that made them.
- **Adjust findings before publishing.** After reading a preview, use
  `/pr-comment <review-id> --exclude` or `--severity` to choose which findings
  to publish and at what severity. The model plans a new preview while the
  original review stays intact. Each list replaces the saved one; `--reset`
  clears both, and `--show` displays the saved preview without a model or Azure
  request. Adjusted reviews require a saved preview and cannot be adjusted or
  planned again once publication starts. Earlier PR comments keep their text;
  the receipt reports differences. See [commenting](COMMENTING.md#adjusting-findings-after-a-preview).
- **A preview after each review; publication on request.** `afterReview`
  selects `preview` (default), `none` or `publish` for each mode; a flag after
  the PR URL overrides it for one review. A COMPLETE review hands off to a separate, cancellable
  comment command. Automatic publication holds individual items with mentions,
  images or active content for inspection, posts ordinary text and links, and
  skips a summary when every finding is already discussed. Every comment
  discloses how its review was made. See [commenting](COMMENTING.md).
- **Native installation and guided setup.** OpenCode's plugin manager loads
  the npm package or the versioned Git package through `server.js`. `/pr-setup` validates one
  configured model and an existing private PAT file, then writes an external,
  owner-only settings file. The source installer remains available; updating
  or removing the package does not remove external settings or review records.
- **Public distribution and contribution.** An npm package, versioned release
  notes, a real recorded review and publication, contribution and private
  vulnerability reporting guides, a code of conduct, and issue and
  pull-request templates support adoption.
- **Own Azure DevOps access.** AZPR calls the REST API (api-version 7.1, the
  latest released version) with the organization and PAT from its settings,
  or from an owner-only PAT file (`azure.patFile`) so `settings.json` holds no
  secret;
  no MCP server is needed. Reads retry transient failures, writes never retry,
  every call is bounded and the PAT is never logged.
- **Runtime-owned facts.** PR identity, the latest iteration's head and merge
  base, the complete changed-file list (paged 2,000 per request) and the final
  version recheck come from REST calls, not model echoes. `/pr-check` is fully
  deterministic.
- **Reviewer tools.** Models read the repository through six read-only AZPR
  tools bound to the run's repository: diffs with structure-aware context and
  folded repeats, whole files, content search over the exact commit, file
  search by name, folder listings and PR threads. They also see the PR's commit
  messages. Private sessions see only an allowlist of tools, and ordinary
  sessions never see AZPR's tools.
- **Commands that need no review ID.** Every `/pr-comment` command, adjustments
  included, acts on the conversation's current review when no ID is given:
  the one completed or used there last. The start notice and the receipt name
  the review and its PR, a preview ends with the commands for the next step,
  `/pr-comment --list` shows the saved reviews, and every command answers
  `--help`. Command descriptions say what a command is for in the part
  OpenCode's one-line command list still shows.
- **A review without content search says so.** When the repository archive is
  over `azure.archiveMegabytes`, or is one AZPR cannot read, the report's
  limitations and the receipt state that sessions could not search file
  contents, with the setting's value where a larger one would help. Before,
  only the models were told.
- **Only source changes are stale.** A moved base is a warning; a changed head
  is STALE. Publication rechecks the head before writing.
- **Sharded reviews.** Every review pass runs per file shard, and all passes
  of all shards share one bound on parallel sessions. The runtime gives the
  review's finding IDs once every session has answered, so they do not depend
  on which session finished first.
- **Context overflow is recovered.** A compaction the host attempts in a
  reviewer's turn is refused, which ends the turn as overflow, and the shard is
  split and rerun (validated on the real host). A refused background summary
  (OpenCode's `compaction.background`, on by default from 2.3.1 on;
  `experimental.background_compaction` in earlier releases) ends nothing and
  leaves the turn's own failure to decide.
- **Correction turns.** Answers that break the output contract are corrected in
  the same session (`workflow.repairAttempts`); remaining problems degrade per
  item (NEEDS_INFO, a merge left out, a level kept, a skipped comment) instead
  of failing the review.
- **Duplicates are settled before comments are planned.** The comment planner
  may not skip a finding because another finding of the review is commented.
- **Defects in moved code and unknown intent.** A correctness or security
  defect on lines the PR adds or moves is filed even when the base commit had
  the same code, and the finding says the PR carries it over. Behavior that is
  wrong only if the author did not mean it, with nothing showing whether they
  did, is a low finding that asks the author. Neither keeps a defect out of
  the findings. Measured on two benchmarks with 0.3.6, whose reviews had a
  verifier; see
  [validation](VALIDATION.md#defects-in-moved-code-and-unknown-intent-2026-11-09).
- **Stage retries.** Transient failures retry once in a new session
  (`workflow.stageRetries`); stream continuations work for every provider, and
  OpenCode's own retries of a failed provider request pass AZPR's hooks.
- **Stage inactivity watchdog.** A stage that shows no activity for
  `workflow.stageIdleSeconds` (default 600 s) while it waits on OpenCode is
  stopped with `failure=idle` and an error naming its last activity, then
  retried in a new session; any activity, including each streamed chunk of
  output, restarts the window.
- **Nothing to review.** A PR whose complete change list is empty stops before
  any session.
- **Deep means stronger models.** `/pr-deep` runs the same review as
  `/pr-review` with the models of `models.deep.reviewers`: stronger models, a
  higher variant or more passes. Prompt text of its own was dropped in
  October 2026, after it changed neither gpt-6-luna's nor gpt-6.1-sol's
  results on the test PRs of that time, and the split into a functional and a
  risk reviewer went in 0.5.0 for the same kind of reason: mode-specific or
  pass-specific instructions come back only with a measured benefit.
- **Bounded Azure calls.** One queue with configurable concurrency and a
  per-call timeout that aborts the request, for both tool and runtime calls;
  slots are released in `finally`.
- **Corporate networks.** `azure.proxy`, `azure.caFile` and `azure.verifyTls`
  send AZPR's Azure DevOps calls through a proxy and trust a TLS-inspecting
  proxy's CA without changing OpenCode's other connections; certificate,
  proxy-authentication and gateway errors say which setting to change.
- **Deterministic, idempotent publication.** Existing markers are skipped,
  writes are read back, partial results are safe to re-run, and inline markers
  are stable across reviews of unchanged code.
- **Persistence.** Completed reviews, previews and ledgers survive restarts;
  stale scratch data and legacy temporary directories are cleaned up.
- **Reliable notices.** PROGRESS notices during long runs; final receipts are
  retried and fall back to a file.
- **Safer defaults.** Shell is denied for private roles by default and enforced
  through the permission hook, which also keeps native read tools inside the
  project; a host without the hook gets a `/pr-check` warning. `/pr-stop` only
  affects the caller's conversation.
- **Maintainability.** Prompts are about a third of their former size, runtime is
  split into focused modules, host specifics live in `host.mjs`.
- **Severity from the harm the evidence shows.** A change that breaks what
  worked before is at least medium, documented steps that stop working
  included. A finding states one defect, and a reviewer looks for stated
  intent before asking about it.

- **A panel in the terminal UI.** OpenCode shows a plugin's notices as plain
  text, so reports and comment previews appeared as Markdown source, and a
  reviewer session had to be picked from the session list. The package's
  terminal part shows the newest report or preview rendered beside the
  conversation and lists the sessions of the review, each a click away. It
  opens by itself, leaves the keyboard with the prompt and only reads what
  the runtime already produced. `terminalPanel: manual` leaves it to
  `/pr-panel`, its only command.
- **Comments on a PR that is no longer active.** A PR merged before its
  review was commented on could be reviewed but not commented on. The PR's
  status no longer stops a publication; the check and the receipt name it.
- **New settings reach the settings file.** Loading a version writes the
  settings it brings into the file, at their defaults, so each can be found
  and changed there; until then only a source installation did.
- **The next step in the panel.** A receipt ends with the commands for the
  next step, but the panel showed only the document, so they had to be found
  in the conversation and typed. After a preview the panel lists them in one
  row at its foot, where reading ends: posting the comments (asked once more,
  "no" first), leaving findings out or changing a level from a list of the
  findings, and resetting that. Each sends the `/pr-comment` command a person
  would type, for the review shown; the panel sends nothing by itself. A session that has answered is `finished`
  until its run's receipt names its result, where the host's word, idle, read
  like a fault.
- **A conversation is named after its PR.** OpenCode names a conversation when
  its own model first runs there, which an AZPR command never makes it do, so
  a conversation used only for reviews stayed "New session" in the list. A
  check or a review now names an unnamed conversation after the PR; a name
  that is there stays, and AZPR's own gives way to one given in the same
  moment.
- **Stopping a run from the panel.** A STARTED notice says how its run is
  stopped (`/pr-stop <run-id>`), but in the conversation, which a person who
  reads the panel does not watch, and with an ID to copy. While a run is
  under way the panel's foot now offers **Stop this run…**: it asks first,
  with "no" first, and sends `/pr-stop` for that run.
- **One comment for one defect at several places.** A mistake repeated in
  several files was several findings and so several inline threads with the
  same text, each to be read and resolved. The comment planner may now give
  them one comment at the clearest place, and AZPR lists every other place
  under it from the findings' own locations. The review still has one finding
  per place.

## Planned

Nothing is scheduled at the moment. A change to what reviewers file or how
findings are checked is listed here once a measurement on more than one
benchmark supports it.

A run of Martian's Code Review Bench, in which every expected issue that no
run matched and a sample of the unmatched findings were checked against the
code (see [validation](VALIDATION.md#martian-code-review-bench-2026-11-05-and-06)),
pointed to five changes. Two are implemented: defects in moved code and
rejections for a possible intention. The other three were examined for 0.3.7
and are not planned; see
[Deferred](#three-changes-the-martian-benchmark-run-pointed-to).

## Deferred

### A verifier as an optional stage

Through 0.4.6 a verifier re-checked every candidate finding of `/pr-review`
and `/pr-deep`, set its severity and merged duplicates. 0.5.0 removed it,
with the rules that existed only for it (decision rows, moved findings, a
confirmation that states its correction, UNREVIEWED findings,
`workflow.shardFindings`), and does not offer it as an option. The reason: in
the runs behind 0.5.0 a verifier of the reviewers' own strength rejected
almost none of their findings and added few, for a large share of a review's
cost (see [validation](VALIDATION.md)).

### Majority voting between passes

Declined: keeping only the findings that more than one pass reported, or
presenting them as more certain. Passes are run to find what another pass
missed, so a vote would remove exactly those findings, and agreement between
passes does not make a finding right. The record keeps which sessions
reported a finding; it is never used to drop or to rate one.

### A sandbox for reviewers' experiments

Not done: a prototype that let reviewer passes run commands in an isolated
sandbox (no network and no home directory, with copies of the PR's files),
to test a suspicion that reading leaves open, changed neither recall nor the
share of valid findings measurably, with GPT-6.1 Terra, which used it in 15%
of its passes, or with GPT-6.2 Sol, which used it in 80%. Most experiments
backed findings that reviewers without the sandbox filed as well, by
reading; see
[validation](VALIDATION.md#reviewers-running-code-in-a-sandbox-2026-11-25-and-26).

### Choosing the number of passes by PR size

Not done: the number of passes is what a person lists per mode, and
`/pr-deep` is where more passes go for the PRs that need them. There is no
data yet that ties the useful number to a PR's size or risk.

### Shipping the terminal panel as JSX source

OpenCode 2.3.0 through 2.3.2 do not compile the JSX of a package they
installed, so the package carries the panel's view compiled (`src/tui.js`)
next to its source, and the repository has a compiler as a development
dependency. OpenCode 2.4.0 and later compile such files again (OpenTUI 0.9,
anomalyco/opentui#2051): a package that exported `src/tui-view.jsx` itself
loaded and worked on 2.4.1 in a fixture run. Not done all the same. On 2.3.x
the terminal part of such a package does not load at all, while the compiled
file loads on every version from 2.3.0 to 2.4.1 and does not depend on how a
host transforms JSX: the native terminal UI in OpenCode's source, which has
not shipped, documents that it compiles every plugin module with Bun's
transform, under which the view's properties would be read only once. The
build costs one script and one development dependency, and
`npm run check` holds the two files together.

The panel and the setup dialogs are for OpenCode's terminal UI. The desktop
app has a plugin entry of its own, which OpenCode still marks as experimental;
a panel and dialogs there wait for that interface to settle. Until then the
desktop app shows AZPR's notices as text and takes `/pr-setup` with options.

### Settings changes without a restart

A first setup is loaded at once, because nothing was loaded before it. A
change to settings that are in use still takes effect when the OpenCode
service restarts, and `/pr-setup` says so where the change is made. Loading
such a change in place would give up a property of today's rule: settings are
read once, so a settings file that something other than its owner edited
(an agent with file tools, say) changes nothing until a person restarts the
service. A reload would need its own answer to that, for example only for
changes that came through setup, and would have to wait for running reviews.
It is not planned until that restart proves to be in the way.

### The token in OpenCode's own credential store

OpenCode lets a plugin register a service for `/connect`, which then asks for
the key and keeps it. AZPR does not use it for the PAT. The token would live
in OpenCode's database beside the model keys, which `opencode auth export`
prints and every copy of the database carries, instead of alone in a file
that names its one purpose; setups that provision that file would have two
places to look; and `/connect` continues into a model choice after it. The
dialogs of `/pr-setup` give the same ease in the terminal UI and write the
same file as before.

### Default whole-run timeout and per-stage step cap

A default `runTimeoutSeconds` and a per-stage step limit that removes tools and
forces the model to finish were considered and **deliberately not adopted**.
Earlier versions removed the step cap after real large PRs repeatedly hit
whatever limit was chosen, and no step count worked across PR sizes and models.
`runTimeoutSeconds` therefore stays `null` by default and private agents carry no
`steps` value.

Mitigations now in place: per-call Azure DevOps timeouts, sharding that keeps each
session's work bounded, overflow splitting, `/pr-stop`, PROGRESS notices that
show whether a run is moving, the optional `runTimeoutSeconds`, and the stage
inactivity watchdog (`workflow.stageIdleSeconds`). The watchdog limits silence,
not work: it stops a stage only when nothing happened for the whole window, so
it never cuts a large PR that keeps working. It was added after four stages of
one run waited about 30 minutes on an approval (the cause, a native tool
outside the project, is refused at once since) and because OpenCode 2.0.22
waits up to 30 minutes for data on the OpenAI WebSocket transport.

Revisit when there is evidence from real runs, for example:

- a step budget that scales with the shard's file count or changed lines instead
  of a fixed number;
- a soft limit that first asks the model to finish (as comment pages already do
  after twelve requests) before any hard stop;
- per-stage wall-clock budgets derived from observed timings in `result.json`.

### Repository archives over 1 GB

Content search downloads the repository zip of the exact commit, up to
`azure.archiveMegabytes` (at most 1024). A repository with committed binaries
can be larger; it is reviewed without content search, which the report and
the receipt state. Raising the maximum alone
is not enough (measured on 2026-10-14):

- Azure DevOps sends the zip without a length, and the entries' local headers
  carry no sizes (data descriptors follow the data), so entries cannot be
  skipped while downloading; the central directory at the end is needed. The
  zip is held in memory and briefly doubled when the received chunks are
  joined, and a Bun 1.4.2 buffer holds at most 4 GiB.
- The download counts against `azure.callTimeoutSeconds` as total time, and a
  failed download is not remembered, so each later search starts it again.
- ZIP64 archives (over 4 GB or 65,535 entries) are refused.

A larger maximum would need the zip written to a private temporary file with
only its directory and text entries read back, ZIP64, an inactivity timeout for
the download and a failed download remembered for the run. Every run would
still download the whole archive. Revisit once the size of the repositories
that need it is known.

### Other credential sources

Only a PAT is supported, in AZPR's settings or in its own file
(`azure.patFile`). Microsoft recommends short-lived
Microsoft Entra tokens over PATs; an Entra or Azure CLI token source could be
added if organizations restrict PAT creation.

### Azure DevOps Server

The REST calls work with Azure DevOps Server 2022.1 or later (api-version 7.1),
but PR URLs and the base URL are limited to Azure DevOps Services.

### A second initial-review round

A round that reviews each shard again in a new session, given the findings
already filed on its files and asked only for defects they miss, was built and
measured together with the changes for moved code and unknown intent (0.3.6,
whose reviews had a verifier). With
Claude Opus 5.5 at medium effort on Martian's benchmark it found more of the
golden issues, but its extra findings lowered precision more, so F2 fell; it
posted 38% more comments and about doubled the tokens. It was removed. It
helped GPT-6 Luna in `/pr-review` more, which is no reason to bring it back:
a stage is not added to steady a weaker model; see
[validation](VALIDATION.md#a-second-initial-review-round-measured-and-removed).
The passes of 0.5.0 are something else: independent sessions that are not
given each other's findings.

### Three changes the Martian benchmark run pointed to

These stood under Planned until the work on 0.3.7 examined them (see
[validation](VALIDATION.md#severity-from-verified-harm-2026-11-11-and-12)).

- **Filing concrete issues that reviewers judged harmless.** Reviewers note
  some issues in their reports without filing them. A reviewer sentence that
  made minor issues and edge cases findings was measured and left out: it added
  findings without evidence that the additions were valid. What 0.3.7 kept is
  narrower: before answering, a reviewer makes the read that would settle a
  suspicion.
- **Fewer missing-test findings.** The two benchmarks disagree about them:
  Martian's counts a comment that matches none of its expected issues as a
  false positive, while ReviewBench's judge rated 97.4% of the findings of
  0.3.7's `/pr-deep` run valid. In AZPR a missing test for working code is a
  low finding, which appears in the summary and never as an inline comment,
  so withholding such findings would serve one benchmark's precision more
  than a reader. 0.3.7 kept one rule: a wrong test is stated as what it
  wrongly accepts, not as missing coverage.
- **Root cause first in comments.** Comparing AZPR's comments with other
  tools' comments on the same expected issues did not show the opening
  sentence as what kept a comment from matching. AZPR's comments were longer
  and often carried a second claim, which the benchmark counts as one more
  unmatched issue; 0.3.7's rule that a finding states one defect addresses
  that instead.

## Remaining validation work

The numbers in this list were measured before 0.5.0, with reviews of two
reviewers and a verifier, unless an item says otherwise. They are kept as the
record of those versions; what was measured with 0.5.0 is in
[validation](VALIDATION.md).

1. Publication on other repositories and organizations. On the 316-file test
   PR an earlier revision published 24 items, all read back, re-ran without a write
   and reported comments deleted by hand as `DELETED`; the planner made no skip
   that relied on another finding there, and the correction turn for one was
   seen live in a preview (see [validation](VALIDATION.md)).
2. Measure how often correction turns and retries happen per model, and tune
   `workflow` defaults from those numbers. On the 316-file PR,
   `parallelSessions` 8 with `azure.concurrency` 6 cut the review from 719 s
   (4 / 3) to 393 s with no provider retry or throttling; 8 with a queue of 3
   made the REST queue the bottleneck. The defaults are 8 / 6 since then, on
   that one measurement: other providers, API keys with low rate limits and
   other organizations have not been measured, and neither has a review of
   several passes, whose sessions share `parallelSessions`. With OpenCode's
   claude-agent provider each session has a local process of about 200 MB
   that ends five minutes after the session's last turn; OpenCode 2.4.0 and
   later also end it when the session is deleted. Many passes over many
   shards need memory for the sessions of the last five minutes, whatever
   `parallelSessions` is. Change `parallelSessions` and
   `azure.concurrency` together.
   Comment planning runs two pages at a time, which cut a nine-page plan from
   140–175 s to 71–90 s; more lanes were not measured.
3. Reduce input tokens further. Reading diffs with folded repeats cut the
   316-file review from 7.5–9.2 to about 5.5 million input tokens and a real
   35-file code PR from 6.15 to 0.55–0.79 million; reviewers still make 4–5.5
   model requests per session and each re-sends what was read. They already
   make 9–12 tool calls per round, so batch parameters for the read tools
   would save little and were not added (see [validation](VALIDATION.md)).
   Prompt caching is the host's part: with the ChatGPT sign-in route the
   1-file PR read 4–5 % of its input from the cache on OpenCode 2.0.22, which
   sent no session headers, and 54 % on 2.0.32. The 316-file PR read 11–21 % on
   2.0.22 and 67–71 % on 2.0.32 in all three modes (see
   [validation](VALIDATION.md)).
4. Cross-shard evidence: a new test in one shard that contradicts unchanged
   code in another shard is found with content search (`azpr_search_code`, over
   the repository zip of the exact commit) by gpt-6.1-sol in 2 of 2 runs and
   missed by gpt-5.6-luna and gpt-6-luna, even with high reasoning effort and
   the defective line in a search result. It is a model limit, so no runtime
   hints were added. The reviewers' model decides what is found, and
   `/pr-deep` is for that: the review with the stronger models of
   `models.deep.reviewers`, for selected PRs. Confirm on other real PRs. In
   those versions a verifier could not make up for it either: verifiers
   added 1 new finding in 616 decisions over 21 live runs, and gpt-6-luna as
   verifier rejected 3 known defects in 62 reviews, two of them with a reason
   that confirms the defect (gpt-6.1-sol none in 35).
5. Repeat host acceptance for future OpenCode versions; `host.mjs` is the place
   for shape changes, `azure.mjs` for REST changes.
6. One reviewer per shard without a verifier, which was `/pr-quick` in 0.4.x
   and is a pass of every review since 0.5.0: two runs per mode on the three
   test PRs with gpt-6-luna used
   36–50 % of the review's model requests and 34–68 % of its input with the
   same planted-defect results except one configuration defect (see
   [validation](VALIDATION.md)). A quick review of the 1-file test PR was
   published and read back. Still open: other PRs and models, a published
   multi-shard review, and other multi-shard PRs: on the 316-file PR a
   shard's tests led its reviewer into another shard's changed files (8–9
   repeated defects in 32–35 findings), and comment planning combined 23 of 25
   such pairs into
   one comment over three runs; since 0.5.0 the duplicate check merges such
   repeats before planning, which has not been measured on that PR. The follow-up for unfinished work has
   not run live yet (no PARTIAL answer in 24 runs); the larger loss is a
   reviewer that answers after reading only the diffs, which on PR #4 misses
   the regression outside the diff. A prompt sentence asking to continue
   unfinished checks made such answers rarer on PR #4 for 37% more input there
   and was not adopted (see [validation](VALIDATION.md)).
7. One comment for one defect at several places (0.4.6) ran with fake models
   on a real host. Still open with real models: how often the planner
   combines the right findings, combines different defects or leaves repeats
   apart, and a later plan of a PR that already carries such a comment (see
   [validation](VALIDATION.md#limits-of-this-candidate)).
8. The pipeline of 0.5.0 (passes, the duplicate check, the blind rating) was
   measured with our own judge, not with the benchmarks' judges (see
   [validation](VALIDATION.md)). Open: the benchmarks' own judges, and models
   and pairs of models other than those measured.

## Quality principles

Keep deterministic facts in code and judgment in models. Prefer a correction
turn or a per-item downgrade over discarding useful work, and keep every
downgrade visible in the report. Preserve failed samples; a COMPLETE status or a
successful write does not prove factual quality. Say what was checked and no
more: no stage verifies a finding, so no report, comment or document says
that one was verified.
