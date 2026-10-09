# Roadmap

Tested with OpenCode CLI 2.0.22, official Azure DevOps MCP 2.9.0 and Ubuntu
22.04. [Current validation](VALIDATION.md) records what this revision was tested
with; [validation history](VALIDATION_HISTORY.md) keeps earlier results.

## Implemented (stability revision)

- **Runtime-owned facts.** PR identity, source/target SHAs, the changed-file list
  and the final version recheck come from direct MCP calls, not model echoes.
  `/pr-check` is fully deterministic.
- **Only source changes are stale.** A moved target branch is a warning; a
  changed head is STALE. Publication rechecks the head before writing.
- **Sharded reviews.** Initial reviews run per file shard with disjoint finding-ID
  ranges; verification runs per finding shard; parallelism is bounded.
- **Context overflow is recovered.** A refused compaction marks the stage as
  overflow and the shard is split and rerun (validated on the real host).
- **Correction turns.** Answers that break the output contract are corrected in
  the same session (`workflow.repairAttempts`); remaining problems degrade per
  item (UNREVIEWED, NEEDS_INFO, skipped comments) instead of failing the review.
- **Stage retries.** Transient failures retry once in a new session
  (`workflow.stageRetries`); stream continuations work for every provider.
- **Bounded MCP.** One queue with configurable concurrency and a per-call timeout
  for both model and runtime calls; slots are released in `finally`.
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

Mitigations now in place: per-call MCP timeouts, sharding that keeps each
session's work bounded, overflow splitting, `/pr-stop`, PROGRESS notices that
show whether a run is moving, and the optional `runTimeoutSeconds`.

Revisit when there is evidence from real runs, for example:

- a step budget that scales with the shard's file count or changed lines instead
  of a fixed number;
- a soft limit that first asks the model to finish (as comment pages already do
  after twelve requests) before any hard stop;
- per-stage wall-clock budgets derived from observed timings in `result.json`.

### Merge-base comparison

MCP 2.9.0 exposes no PR iterations, so `commonRefCommit` (the merge base) is not
available. If a later server version exposes iterations, BASE could become the
merge base, which would remove target-only differences from the comparison.

### Complete change lists beyond one page

`repo_pull_request` returns one page of iteration changes (the first 100
files). Very large PRs are marked incomplete and reviewers discover the rest. A
paged changes tool in a later MCP version, or the REST path below, would make the
inventory complete and verifiable.

## Under evaluation: Azure DevOps REST for runtime operations

A read-only comparison on 2026-10-10 (10 calls per operation) favoured direct
REST over MCP 2.9.0 for the runtime's deterministic operations: 40/40 REST calls
succeeded with median latencies of 120–270 ms, while direct MCP calls failed 2 of
30 times with empty error messages at 500–1000 ms. MCP returns only the first
100 changed files (a 316-file PR listed 100), exposes no merge base and returns
`{}` for a missing PR; REST pages iteration changes up to 2000 per call and
provides `commonRefCommit`. The cost is credential handling inside AZPR (PAT
file, environment variable or Azure CLI token) and calls that bypass OpenCode
permission rules. Proposed shape: REST when a credential source is configured,
MCP otherwise; models keep using MCP tools for source reads.

## Remaining validation work

1. Run the new revision against large real Azure DevOps PRs: sharded reviews,
   overflow splits and verifier sharding. A one-file PR passed review and
   publication with read-back (see [validation](VALIDATION.md)).
2. Measure how often correction turns and retries happen per model, and tune
   `workflow` defaults from those numbers.
3. Check rendered comments, inline anchors and summaries in the Azure UI.
4. Repeat host acceptance for future OpenCode and MCP versions; `host.mjs` is the
   place for shape changes.

## Quality principles

Keep deterministic facts in code and judgment in models. Prefer a correction
turn or a per-item downgrade over discarding useful work, and keep every
downgrade visible in the report. Preserve failed samples; a COMPLETE status or a
successful write does not prove factual quality.
