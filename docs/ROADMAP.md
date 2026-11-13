# Roadmap

Tested with OpenCode CLI 2.2.4, the Azure DevOps Services REST API
(api-version 7.1) and Ubuntu 22.04. [Current validation](VALIDATION.md) records what this revision was tested
with; [validation history](VALIDATION_HISTORY.md) keeps earlier results.

## Implemented (stability revision)

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
  skips a summary when every finding is already discussed. Quick comments
  retain their unverified disclosure. See [commenting](COMMENTING.md).
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
- **Sharded reviews.** Initial reviews run per file shard with disjoint finding-ID
  ranges; verification runs per finding shard; parallelism is bounded.
- **Context overflow is recovered.** A compaction the host attempts in a
  reviewer's turn is refused, which ends the turn as overflow, and the shard is
  split and rerun (validated on the real host). A refused background summary
  (`experimental.background_compaction`) leaves the turn's own failure to decide.
- **Correction turns.** Answers that break the output contract are corrected in
  the same session (`workflow.repairAttempts`); remaining problems degrade per
  item (UNREVIEWED, NEEDS_INFO, skipped comments) instead of failing the review.
- **One place for duplicates.** Only verification merges duplicates: each
  verifier within its shard, and a duplicate check for files whose findings
  different verifiers confirmed (a quick review, which has no verifier, merges
  only records identical in every field). Verifier rows are judged by their own fields,
  a move to another file must be declared and the report shows the initial
  location, and the comment planner may not skip a finding because another
  finding of the review is commented.
- **Defects in moved code and unknown intent.** A correctness or security
  defect on lines the PR adds or moves is filed even when the base commit had
  the same code, and the finding says the PR carries it over. Behavior that is
  wrong only if the author did not mean it, with nothing showing whether they
  did, is a low finding that asks the author. Neither is a reason for the
  verifier to reject a finding. Measured on two benchmarks; see
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
- **Quick review.** `/pr-quick` runs one reviewer per shard for both the
  functional and the risk focus and no verifier, duplicate check or summary
  session. The runtime checks only the form and source of its findings (a
  required location that exists at that commit, in a file the session's own
  tools read): passing findings are REPORTED, the rest NEEDS_INFO. A usable
  PARTIAL answer that names unfinished work gets one follow-up turn in the
  same session; a follow-up that fails or gives no usable answer keeps the
  answer it followed. The review records `verification: none`, reports status, coverage and verification
  separately, and its comments keep the layout with a disclosure line that
  names the quick method. Shared prompts carry verified/quick variants; the
  review prompts are byte-identical to before (hash-tested), and a command
  checks only its own profile's agents and models.
- **Deep means stronger models.** `/pr-deep` runs the same review as
  `/pr-review` with the models of `models.deep`. Its extra prompt text was
  dropped after it changed neither gpt-6-luna's nor gpt-6.1-sol's results on
  the test PRs, so the deep profile is where a stronger, costlier model goes.
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
- **Severity from what was verified.** The verifier receives candidates
  without the reviewer's severity and sets the level itself. An optional
  severity rating without tools (`models.<mode>.rater`) can set each confirmed
  finding's final level from its text on a stronger model; it is off unless a
  rater is named. A change that breaks what worked before is at least
  medium, documented steps that stop working included. A finding states one
  defect, a merge keeps no defect only the merged finding named, a reviewer
  looks for stated intent before asking about it, and a verified behavior only
  the author can call intended is confirmed as a question, not NEEDS_INFO.
- **A confirmation states its correction.** A verifier that confirms a
  finding with a suggestion such as "N/A" or "No correction needed." is asked
  in the same session which it means; left unresolved, the finding is
  NEEDS_INFO and gets no comment. Such confirmations came from GPT-6 Luna
  verifiers whose own reason refuted the finding.

## Planned

Nothing is scheduled at the moment. A change to what reviewers file or how
findings are verified is listed here once a measurement on more than one
benchmark supports it.

A run of Martian's Code Review Bench, in which every expected issue that no
run matched and a sample of the unmatched findings were checked against the
code (see [validation](VALIDATION.md#martian-code-review-bench-2026-11-05-and-06)),
pointed to five changes. Two are implemented: defects in moved code and
rejections for a possible intention. The other three were examined for 0.3.7
and are not planned; see
[Deferred](#three-changes-the-martian-benchmark-run-pointed-to).

## Deferred

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
measured together with the changes for moved code and unknown intent. With
Claude Opus 5.5 at medium effort on Martian's benchmark it found more of the
golden issues, but its extra findings lowered precision more, so F2 fell; it
posted 38% more comments and about doubled the tokens. It was removed. It
helped GPT-6 Luna in `/pr-review` more, so it may return as an option for
weaker models if a measurement on more than one benchmark supports it; see
[validation](VALIDATION.md#a-second-initial-review-round-measured-and-removed).

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

1. Publication on other repositories and organizations. On the 316-file test
   PR this revision published 24 items, all read back, re-ran without a write
   and reported comments deleted by hand as `DELETED`; the planner made no skip
   that relied on another finding there, and the correction turn for one was
   seen live in a preview. Moved findings, decision rows in the wrong list and
   the duplicate check worked in live reviews (see [validation](VALIDATION.md)).
2. Measure how often correction turns and retries happen per model, and tune
   `workflow` defaults from those numbers. On the 316-file PR,
   `parallelSessions` 8 with `azure.concurrency` 6 cut the review from 719 s
   (4 / 3) to 393 s with no provider retry or throttling; 8 with a queue of 3
   made the REST queue the bottleneck. The defaults are 8 / 6 since then, on
   that one measurement: other providers, API keys with low rate limits and
   other organizations have not been measured, and with OpenCode's
   claude-agent provider each session keeps a process of about 200 MB for
   minutes after it ends, so a large PR needs memory for them. Lower
   `parallelSessions` there; change both values together.
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
   hints were added. A stronger verifier cannot make up for it: verifiers
   judge the candidates and added 1 new finding in 616 decisions over 21 live
   runs, so the initial reviewers' model decides what is found. `/pr-deep`
   is for that: the review with the stronger models of `models.deep`, for
   selected PRs. Confirm on other real PRs. A stronger verifier does keep
   more of what the reviewers find: gpt-6-luna as verifier rejected 3 known
   defects in 62 reviews, two of them with a reason that confirms the defect,
   and gpt-6.1-sol none in 35; behind gpt-6-luna reviewers it cost 3–8 times
   the luna review.
5. Repeat host acceptance for future OpenCode versions; `host.mjs` is the place
   for shape changes, `azure.mjs` for REST changes.
6. Quick review: two runs per mode on the three test PRs with gpt-6-luna used
   36–50 % of the review's model requests and 34–68 % of its input with the
   same planted-defect results except one configuration defect (see
   [validation](VALIDATION.md)). A quick review of the 1-file test PR was
   published and read back. Still open: other PRs and models, a published
   multi-shard quick review, and other multi-shard PRs: on the 316-file PR a
   shard's tests led its reviewer into another shard's changed files (8–9
   repeated defects in 32–35 findings), and comment planning combined 23 of 25
   such pairs into
   one comment over three runs. The quick follow-up for unfinished work has
   not run live yet (no PARTIAL answer in 24 runs); the larger loss is a
   reviewer that answers after reading only the diffs, which on PR #4 misses
   the regression outside the diff. A prompt sentence asking to continue
   unfinished checks made such answers rarer on PR #4 for 37% more input there
   and was not adopted (see [validation](VALIDATION.md)).

## Quality principles

Keep deterministic facts in code and judgment in models. Prefer a correction
turn or a per-item downgrade over discarding useful work, and keep every
downgrade visible in the report. Preserve failed samples; a COMPLETE status or a
successful write does not prove factual quality.
