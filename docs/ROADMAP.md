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
- **Reviewer tools.** Models read the repository through three read-only AZPR
  tools bound to the run's repository; private sessions see only an allowlist
  of tools, and ordinary sessions never see AZPR's tools.
- **Only source changes are stale.** A moved base is a warning; a changed head
  is STALE. Publication rechecks the head before writing.
- **Sharded reviews.** Initial reviews run per file shard with disjoint finding-ID
  ranges; verification runs per finding shard; parallelism is bounded.
- **Context overflow is recovered.** A refused compaction marks the stage as
  overflow and the shard is split and rerun (validated on the real host).
- **Correction turns.** Answers that break the output contract are corrected in
  the same session (`workflow.repairAttempts`); remaining problems degrade per
  item (UNREVIEWED, NEEDS_INFO, skipped comments) instead of failing the review.
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

1. Plan and publish comments for a large PR. A 316-file PR passed a full
   real-model review (26 initial and 4 verification sessions, all COMPLETE) and
   a one-file PR passed publication with read-back (see
   [validation](VALIDATION.md)).
2. Confirm that a PAT limited to Code (Read) and Pull Request Threads
   (Read & write) is sufficient.
3. Measure how often correction turns and retries happen per model, and tune
   `workflow` defaults from those numbers.
4. Reduce the input-token cost of initial reviews: the 316-file review used
   about 7.4 million input tokens, mostly tool output re-sent with every model
   request of long initial sessions. Candidates are a tool that returns HEAD
   and BASE hunks instead of two full files, smaller shards and provider prompt
   caching; measure before changing defaults.
5. Check rendered comments, inline anchors and summaries in the Azure UI.
6. Repeat host acceptance for future OpenCode versions; `host.mjs` is the place
   for shape changes, `azure.mjs` for REST changes.

## Quality principles

Keep deterministic facts in code and judgment in models. Prefer a correction
turn or a per-item downgrade over discarding useful work, and keep every
downgrade visible in the report. Preserve failed samples; a COMPLETE status or a
successful write does not prove factual quality.
