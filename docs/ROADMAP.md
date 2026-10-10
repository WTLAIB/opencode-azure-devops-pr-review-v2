# Roadmap

Tested with OpenCode CLI 2.0.22, the Azure DevOps Services REST API
(api-version 7.1) and Ubuntu 22.04. [Current validation](VALIDATION.md) records what this revision was tested
with; [validation history](VALIDATION_HISTORY.md) keeps earlier results.

## Implemented (stability revision)

- **Own Azure DevOps access.** AZPR calls the REST API (api-version 7.1, the
  latest released version) with the organization and PAT from its settings;
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
- **Only source changes are stale.** A moved base is a warning; a changed head
  is STALE. Publication rechecks the head before writing.
- **Sharded reviews.** Initial reviews run per file shard with disjoint finding-ID
  ranges; verification runs per finding shard; parallelism is bounded.
- **Context overflow is recovered.** A refused compaction marks the stage as
  overflow and the shard is split and rerun (validated on the real host).
- **Correction turns.** Answers that break the output contract are corrected in
  the same session (`workflow.repairAttempts`); remaining problems degrade per
  item (UNREVIEWED, NEEDS_INFO, skipped comments) instead of failing the review.
- **One place for duplicates.** Only verification merges duplicates: each
  verifier within its shard, and a duplicate check for files whose findings
  different verifiers confirmed. Verifier rows are judged by their own fields,
  a move to another file must be declared and the report shows the initial
  location, and the comment planner may not skip a finding because another
  finding of the review is commented.
- **Stage retries.** Transient failures retry once in a new session
  (`workflow.stageRetries`); stream continuations work for every provider.
- **Bounded Azure calls.** One queue with configurable concurrency and a
  per-call timeout that aborts the request, for both tool and runtime calls;
  slots are released in `finally`.
- **Deterministic, idempotent publication.** Existing markers are skipped,
  writes are read back, partial results are safe to re-run, and inline markers
  are stable across reviews of unchanged code.
- **Persistence.** Completed reviews, previews and ledgers survive restarts;
  stale scratch data and legacy temporary directories are cleaned up.
- **Reliable notices.** PROGRESS notices during long runs; final receipts are
  retried and fall back to a file.
- **Safer defaults.** Shell is denied for private roles by default and enforced
  through the permission hook; `/pr-stop` only affects the caller's conversation.
- **Maintainability.** Prompts are about a third of their former size, runtime is
  split into focused modules, host specifics live in `host.mjs`.

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
show whether a run is moving, and the optional `runTimeoutSeconds`.

Revisit when there is evidence from real runs, for example:

- a step budget that scales with the shard's file count or changed lines instead
  of a fixed number;
- a soft limit that first asks the model to finish (as comment pages already do
  after twelve requests) before any hard stop;
- per-stage wall-clock budgets derived from observed timings in `result.json`.

### Other credential sources

Only a PAT in AZPR's settings is supported. Microsoft recommends short-lived
Microsoft Entra tokens over PATs; an Entra or Azure CLI token source could be
added if organizations restrict PAT creation.

### Azure DevOps Server

The REST calls work with Azure DevOps Server 2022.1 or later (api-version 7.1),
but PR URLs and the base URL are limited to Azure DevOps Services.

## Remaining validation work

1. Publish a large PR with this revision to confirm the planner rule on skips
   that rely on another finding. Moved findings, decision rows in the wrong list
   and the duplicate check worked in live reviews; an earlier commit passed
   review and publication of 25 items on a 316-file PR (see
   [validation](VALIDATION.md)).
2. Confirm that a PAT limited to Code (Read) and Pull Request Threads
   (Read & write) is sufficient.
3. Measure how often correction turns and retries happen per model, and tune
   `workflow` defaults from those numbers. On the 316-file PR,
   `parallelSessions` 8 with `azure.concurrency` 6 cut the review from 719 s
   (4 / 3) to 393 s with no provider retry or throttling; 8 with a queue of 3
   made the REST queue the bottleneck. The defaults stay 4 / 3 until other
   providers and organizations have been measured; raise both together.
4. Reduce input tokens further. Reading diffs with folded repeats cut the
   316-file review from 7.5–9.2 to about 5.5 million input tokens and a real
   35-file code PR from 6.15 to 0.55–0.79 million; reviewers still make 4–5.5
   model requests per session and each re-sends what was read. Next candidate:
   provider prompt caching (cache reads are 10–16 % of input).
5. Cross-shard evidence: a new test in one shard that contradicts unchanged
   code in another shard is still missed. Content search (`azpr_search_code`,
   over the repository zip of the exact commit; Azure DevOps Code Search
   indexes only the default branch) and the PR's commit messages are in place,
   and reviewers search often, but not for every new test. Next candidate: the
   runtime cross-references identifiers on added test lines with the non-test
   files that use them and gives each test file's reviewers those locations
   (offline it points at the seeded line in PR #4 for about 4,000 tokens per
   PR; comments must be filtered out), or a check stage dedicated to what new
   tests assert.
6. Check rendered comments, inline anchors and summaries in the Azure UI.
7. Repeat host acceptance for future OpenCode versions; `host.mjs` is the place
   for shape changes, `azure.mjs` for REST changes.

## Quality principles

Keep deterministic facts in code and judgment in models. Prefer a correction
turn or a per-item downgrade over discarding useful work, and keep every
downgrade visible in the report. Preserve failed samples; a COMPLETE status or a
successful write does not prove factual quality.
