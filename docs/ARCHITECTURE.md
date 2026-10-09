# Architecture

AZPR is a source-only OpenCode V2 plugin. Model work runs in private,
role-bound child sessions; deterministic facts and every Azure DevOps write are
runtime code that calls the user's connected `@azure-devops/mcp` tools directly.

## Components

| File | Responsibility |
| --- | --- |
| `src/plugin.js` | V2 plugin definition and setup entry. |
| `src/runtime.mjs` | Registration, hooks, grants, workflows, stage attempts (repair turns and retries), notices, cancellation and lifecycle. |
| `src/host.mjs` | OpenCode compatibility layer: response-shape normalization, capability detection and host constants. |
| `src/config.mjs` | Settings validation, roles, native tool rules, shared prompt policies and agent compilation. |
| `src/session.mjs` | Session create/admit/wait/correlate, host stream continuations, failure classification, interrupt and synthetic notices. |
| `src/tool-queue.mjs` | Bounded MCP concurrency with per-call timeouts, shared by model tool calls and runtime calls. |
| `src/azure.mjs` | PR URL parsing, Azure server selection, snapshot construction and the deterministic MCP client (PR, threads, file content, thread creation). |
| `src/review-work.mjs` | Sharded initial reviews, overflow splitting, sharded verification, merge and the final version recheck. |
| `src/output.mjs` | Strict model JSON extraction, review acceptance with per-item degradation, and repair prompts. |
| `src/comments.mjs` | Comment-plan validation, title/anchor normalization, stable markers and plan assembly. |
| `src/comment-work.mjs` | Comment planning pages and deterministic, idempotent publication. |
| `src/comment-data.mjs` | Private content-addressed data files for large inputs and observed source. |
| `src/store.mjs` | Persistent reviews, data cleanup and fallback receipt files. |
| `src/attribution.mjs` | Deterministic reports, provenance, receipts and ledgers. |
| `src/diagnostics.mjs` | Optional private diagnostic files and stage timing. |
| `src/prompts/` | Shared review rules, role prompts and comment policy. |

## Commands and workflows

`ctx.command.transform` registers `/pr-check`, `/pr-review`, `/pr-deep`,
`/pr-stop` and `/pr-comment`. A command validates its arguments, registers a run
with its origin lock (and a PR lock for comments), queues a `STARTED` notice and
returns; the workflow continues in the background. The final receipt is queued
to the invoking conversation with up to three attempts and is written to
`receipts/` in the state directory if the conversation cannot be reached.
`PROGRESS` notices report phases (snapshot, shard counts, verification,
planning pages, posting). Notices never start a model response.

Each workflow first runs one **preflight**: `settings.json` must be unchanged
since load, reserved commands must still be ours, private agents are pinned, the
selected models must exist and support tools, an MCP server must be connected,
and the Azure server is selected from the captured tools. A model-less runtime
session (agent `azpr-runtime`) is created for the run's Azure calls. After
preflight, hooks never re-read settings or catalogs.

### Review

1. **Snapshot** — `repo_pull_request get` with `includeChangedFiles` gives PR
   identity, `lastMergeSourceCommit` (head), `lastMergeTargetCommit` (base),
   repository/project IDs, title, description and the change list. The
   organization in the response must match the PR URL. A paged change list is
   marked incomplete and reviewers are asked to report missing paths.
2. **Initial reviews** — changed files are sorted and cut into shards of
   `workflow.shardFiles`. For each role and shard a private session reviews the
   assigned files with a finding-ID range (`F-1…`, `F-1001…`) so IDs never
   collide. Up to `workflow.parallelSessions` sessions run at once.
3. **Overflow** — private sessions may not compact. A compaction request (or a
   413) marks the stage as `overflow`; the runtime splits that shard in half
   and runs both halves (labels `shard 1/5a`, `1/5b`).
4. **Verification** — findings are grouped by file into shards of
   `workflow.shardFindings`. Each verifier decides its assigned IDs and may
   merge into any original ID. Missing or invalid decisions trigger a repair
   turn asking only for those IDs; leftovers become UNREVIEWED (or NEEDS_INFO
   for incomplete confirmations).
5. **Recheck** — a fresh PR read compares versions. A changed head is STALE; a
   changed base only adds a warning. A failed recheck is a warning because
   publication rechecks the head anyway.

COMPLETE reviews are cached (newest 20) and persisted with their observed
source excerpts, so `/pr-comment` works after a restart in the same conversation.

### Stage attempts

A stage attempt creates a fresh role-bound session, admits the JSON payload as
the only prompt, waits for idle and correlates the turn. The handler evaluates
the answer; if it lists issues and a repair prompt, the runtime sends up to
`workflow.repairAttempts` correction prompts in the **same** session (each is a
newly authorized prompt with its own nonce). A transient failure (provider
408/409/425/429/5xx, missing idle, an unexpected message in the turn) retries
the stage once in a new session (`workflow.stageRetries`). Permanent failures
and cancellations are not retried.

Host stream continuations are accepted for any provider: an errored text-only
assistant message that the host marked for retry, followed by the host's
continuation notice and a successful final text, is joined literally. When the
model starts its answer over instead of continuing (a later fragment opens like
the first), only the restarted text is used.

Before asking for a correction, a narrow local repair escapes unescaped double
quotes inside closed single-line `code` spans. Corrections for syntax errors ask
for the same content unchanged; answers without JSON are asked for the full
object.

### Comments

Planning (model) uses pages of at most four findings plus report segments, with
CONTINUE checkpoints when a page needs more reading and a no-progress guard.
Each page is validated per item: titles, severity labels, path slashes and
HTML comment markers are normalized; anchors are restored against source text
observed during the review; real problems get a repair turn; what remains is
skipped with a reason. The assembled plan stores exact content, offsets and
markers.

The runtime gives each page what it normally needs: the HEAD source around
each finding (the whole file when small) and a digest of every live thread, both
read deterministically; findings and earlier pages are inline. A page usually
finishes in one model request without tools.

Publication (runtime) rechecks that the PR is active and the head unchanged,
lists every thread, skips items whose marker exists, creates the rest, records
each result immediately, and reads all markers back (`VERIFIED`). Creation
results are `POSTED`, `ALREADY_PRESENT`, `FAILED`, `UNCERTAIN` (resolved by
read-back) or `UNVERIFIED`. Re-running publication is safe.

## Authorization and isolation

Private roles (`azpr-<mode>-functional|risk|verifier|comment-plan`) are hidden
primary agents with explicit models; `azpr-runtime` has no model and never
receives a prompt. Every private session gets a grant with the run, role, model
and a pending prompt (text + nonce). Hooks enforce it:

- `prompt`: only the exact pending runtime prompt is admitted; private agents
  cannot be mentioned or delegated.
- `context`: tools the role may never use are removed from the request; comment
  pages that read too much get their tools removed to force a checkpoint.
- `model.request`: only primary requests after an authorized context; compaction,
  generation and title requests are refused (compaction marks overflow).
- `retry`: host retries continue only while the grant is active.
- `permission` `evaluate`: enforces the `shell` setting for private roles and
  allows reads of AZPR's own private data directory.
- `tool.execute.before`: refuses hidden native tools and delegation.
- `tool.execute.after`: numbers plain source text, saves observed review source
  for anchor checks and pages large comment-tool results into private files.

Runtime Azure reads (PR, threads, file content) retry transient failures twice
with backoff — the MCP server reports network errors with an empty message —
while authentication, permission, validation and not-found errors and every
write fail at once. Threads are read in one call (`top: 1000`). With debug
enabled each runtime call is logged to `azure-calls.jsonl` (tool, argument
summary, attempt, duration, outcome; never comment bodies).

The plugin wraps every namespaced tool executor so private model calls share the
MCP queue (concurrency and per-call timeout) with runtime calls; ordinary
sessions are untouched. Slots are released in `finally`, never by a hook.

Shell is denied by default. With `shell: "ask"` or `"inherit"` reviewers may run
commands under host permissions; that is real host authority, not a sandbox.
Read-only use of MCP tools by reviewers is a prompt policy; only the runtime
writes to Azure DevOps.

## Compatibility

`host.mjs` normalizes list/record response shapes, detects optional capabilities
(`permission.hook`, `tool.list`) and holds the host continuation text. Receipts
note when the detected OpenCode version differs from the tested one. The Azure
tool names live only in `azure.mjs`.
