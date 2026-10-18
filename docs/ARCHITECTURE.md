# Architecture

AZPR is a source-only OpenCode V2 plugin. Model work runs in private,
role-bound child sessions; deterministic facts and every Azure DevOps write are
runtime code that calls the Azure DevOps Services REST API (api-version 7.1)
with the organization and PAT from AZPR's own settings. Reviewers read the
repository through AZPR's own read-only tools, which use the same client.

## Components

| File | Responsibility |
| --- | --- |
| `src/plugin.js` | V2 plugin definition and setup entry. |
| `src/runtime.mjs` | Registration, hooks, grants, workflows, stage attempts (repair turns and retries), notices, cancellation and lifecycle. |
| `src/host.mjs` | OpenCode compatibility layer: response-shape normalization, capability detection and host constants. |
| `src/config.mjs` | Settings validation, roles, native tool rules, shared prompt policies, prompt variants per mode and agent compilation. |
| `src/session.mjs` | Session create/admit/wait/correlate, host stream continuations, failure classification, interrupt and synthetic notices. |
| `src/tool-queue.mjs` | Bounded Azure DevOps concurrency with per-call timeouts that abort the request, shared by reviewer tools and runtime calls. |
| `src/azure.mjs` | PR URL parsing, the REST client (PR, iterations, changes, items, threads, thread creation), error classification, retries, the per-run file cache and snapshot construction. The only place with REST paths and the api-version. |
| `src/review-tools.mjs` | The reviewers' read-only tools (`azpr_read_diff`, `azpr_read_file`, `azpr_search_code`, `azpr_find_files`, `azpr_list_files`, `azpr_pr_threads`): definitions, argument validation and bounded output. |
| `src/diff.mjs` | Line diffs (Myers) with both line numbers, more context before a change than after, the enclosing block's start, and folding of repeated changes. |
| `src/search.mjs` | Content search: reads the repository zip of one commit once per run (stored or deflated entries; bounded inflation; ZIP64 and encrypted archives refused), keeps its text files in memory and finds literal text, bounded per file and in total. |
| `src/review-work.mjs` | Sharded initial reviews, overflow splitting, sharded verification, the same-file duplicate check, merge and the final version recheck; the quick review and its location and source checks. |
| `src/output.mjs` | Strict model JSON extraction, review acceptance with per-item degradation, and repair prompts. |
| `src/comments.mjs` | Publishable findings per mode, comment-plan validation, title/anchor normalization, stable markers and plan assembly. |
| `src/comment-work.mjs` | Comment planning pages and deterministic, idempotent publication. |
| `src/comment-data.mjs` | Private content-addressed data files for large inputs and observed source. |
| `src/store.mjs` | Persistent reviews, data cleanup, fallback receipt files and the reviewer sessions kept from unfinished runs (released for deletion beyond the review limit). |
| `src/attribution.mjs` | Deterministic reports, provenance, receipts and ledgers. |
| `src/diagnostics.mjs` | Optional private diagnostic files (bounded by `debug.keepRuns`) and stage timing. |
| `src/prompts/` | Shared review rules, role prompts and comment policy. |

## Commands and workflows

`ctx.command.transform` registers `/pr-check`, `/pr-review`, `/pr-deep`,
`/pr-quick`, `/pr-stop` and `/pr-comment`. A command validates its arguments, registers a run
with its origin lock (and a PR lock for comments), queues a `STARTED` notice and
returns; the workflow continues in the background. The final receipt is queued
to the invoking conversation with up to three attempts and is written to
`receipts/` in the state directory if the conversation cannot be reached.
`PROGRESS` notices report phases (snapshot, shard counts, verification,
planning pages, posting). Notices never start a model response.

Each workflow first runs one **preflight**: `settings.json` must be unchanged
since load, reserved commands must still be ours, the private agents of the
command's profile are pinned and the models the command uses must exist and
support tools (and offer the variant when a model is set as
`provider/model#variant`). Pinning and the model check are per profile, so a
problem with the quick (or deep) roles or models blocks only the commands that
use them; `/pr-check` reports a configured quick model as a warning. Review commands refuse a PR
URL whose organization differs from `azure.organization` before any request.
After preflight, hooks never re-read settings or catalogs.

### Review

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
2. **Initial reviews** — changed files are sorted and cut into shards of
   `workflow.shardFiles`. For each role and shard a private session reviews the
   assigned files with a finding-ID range (`F-1…`, `F-1001…`) so IDs never
   collide. Up to `workflow.parallelSessions` sessions run at once. Each
   reviewer files every concrete defect it finds as a finding: a role's focus
   orders its attention and is not a filter, and `report` carries exclusions,
   advice and limitations only.
3. **Overflow** — private sessions may not compact. A compaction request (or a
   413) marks the stage as `overflow`; the runtime splits that shard in half
   and runs both halves (labels `shard 1/5a`, `1/5b`).
4. **Verification** — findings are grouped by file into shards of at most
   `workflow.shardFindings`; shards end only between files, so every finding on
   a file reaches the same verifier (a file is split only when it alone has
   more findings than a shard holds). Each verifier decides its assigned IDs and may
   merge into any original ID; merging is the only place duplicates are
   resolved. A decision row is judged by its own fields (an explicit status,
   or a merge target on a row without a finding) even when it sits in another
   list. A confirmation that moves its finding to another file must say so
   with `movedFrom`; otherwise the verifier is asked to confirm or undo the
   move, and an unconfirmed move is kept with a warning. The report shows a
   moved finding's initial location. Missing or invalid decisions trigger a
   repair turn asking only for those IDs; leftovers become UNREVIEWED (or
   NEEDS_INFO for incomplete confirmations). A merge whose chain ends at a
   finding the same answer rejected or marked NEEDS_INFO gets a repair turn
   for the pair; left unresolved, the merged finding is UNREVIEWED. After the
   shards are combined the same rule settles merges into findings another
   verifier did not confirm, with a warning.
   Without candidate findings one verifier still runs: it checks the initial
   reports and condenses them into the report's checks and limitations, which
   comment planning also uses for the PR summary.
5. **Duplicate check** — the runtime groups confirmed findings by their final
   file. A file whose findings different verifiers confirmed (a verifier moved
   one there, or a crowded file was split) lost the one-verifier-per-file
   guarantee, so one `dedupe` session per such file, using the verifier model,
   compares them and may only merge a finding into another of that file (same
   root cause and same correction). Invalid merges get a correction turn and are
   otherwise ignored; chains end at the finding that stays; a failed check keeps
   every finding and adds a warning. Usually no file qualifies and nothing runs.
6. **Recheck** — a fresh PR and iteration read compares versions. A changed
   head is STALE; a changed base only adds a warning. A failed recheck is a
   warning because publication rechecks the head anyway.

COMPLETE reviews are cached (newest 20) and persisted with the source the
reviewers read, so `/pr-comment` works after a restart in the same conversation.

### Quick review

`/pr-quick` uses the same snapshot, file shards, overflow splitting, stage
retries, watchdog and final version recheck, with one role,
`azpr-quick-reviewer`, per shard (IDs `Q-1`, `Q-1001`, …) and no verifier,
duplicate check or summary session. The reviewer covers the functional and
the risk focus and checks each finding against source it read in its own
session. A defect its files lead it to in another changed file is filed at
that file's defective lines (never at a line that only uses the code), so two
shards can report one defect; comment planning may combine such repeats. The runtime then checks only form and source, never whether a defect
is real:

- the answer contract of an initial review with a required `location`; a
  parsed answer is a usable result only with a `findings` array and at least
  one reviewed file or accepted finding;
- the location (`head:` by default, `base:` for content that exists only in
  BASE) must exist at that commit with the lines in range, in a file whose
  content this session's own `azpr_read_diff` or `azpr_read_file` calls showed
  (not the run's cache, another shard's reads or the runtime's own checks).
  Only answers that show source count: a binary or oversized side, an empty
  file, identical versions or a line, column or hunk past the end show none;
  a diff reads a version only through the rows it shows after paging and byte
  cuts ("-" BASE, "+" HEAD, a blank mark both; folded repeats none), and an
  answer cut to the tool-output limit is no read;
- problems the reviewer can fix get the normal correction turns, with hints
  for deleted and renamed files; what is still wrong afterwards becomes
  NEEDS_INFO. Passing findings are REPORTED; only records identical in every
  field are merged (findings on the same lines stay separate);
- a usable answer that is PARTIAL and names unfinished work (coverage gaps or
  assigned files it did not list as reviewed), with nothing left to correct,
  gets one **follow-up** turn in the same session within the
  `workflow.repairAttempts` budget: continue where the source is readable,
  keep a gap only for a limit it cannot close, and return the whole answer
  again. A second PARTIAL stands. When the follow-up, or a correction turn
  after it, fails or gives no usable answer, the answer it followed stands;
  cancellation and context overflow keep their usual handling (overflow
  splits the shard). The stage record keeps the outcome (`followUp`). Review
  and deep shards have two reviewers and get no follow-up.

A location on a changed HEAD file may carry an inline comment; a BASE location
or unchanged code stays in the summary index. Shard reports are joined by the
runtime. The review records `verification: "none"` and a coverage summary
(complete, or the number of unreviewed files when it is known and fixed
reasons: a failed shard, a partial change list, reviewer-reported gaps).
COMPLETE needs at least one usable shard; without one the review is PARTIAL
and cannot be commented on.

Shared prompts mark the passages about where findings come from with
`<!-- azpr:verified -->` and `<!-- azpr:quick -->` blocks. Review and deep
agents get the verified text, so their system prompts are byte-identical to
the files without markers; quick agents get the quick text, which never claims
that findings were verified, confirmed or de-duplicated.

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
`context` and `model.request` hooks like any request.

A **stage inactivity watchdog** (`workflow.stageIdleSeconds`, default 600, 0
turns it off) covers a model stream, a tool or the host that stops responding.
While a stage waits on OpenCode, prompt admissions, model requests, streamed
output, tool starts and ends, approval requests and announced host retries are
activity (an announced retry wait is added to the window), and a running AZPR
tool counts until it returns because its Azure calls have their own timeouts.
Streamed output reaches no hook, so while a stage is watched AZPR follows
OpenCode's session events (`event.subscribe`), which carry one event per
streamed chunk of answer text, reasoning or tool-call input; a host without
them leaves only the hooks. A stage with
no activity for the whole window is stopped: its grant is revoked, its session
interrupted, and it fails with `failure=idle` and an error that names the last
activity, such as `Stage inactivity watchdog stopped this stage: no activity
for 600 s after model request 3 was sent`; the receipt adds an inactivity
notice. It is retried in a new session like a transient failure. Any activity
restarts the window, so this is not the whole-run timeout or step cap the
[roadmap](ROADMAP.md#deferred) defers: a stage that keeps working is never
stopped. The longest quiet stretch in 1,097 normal live stages was 151 s.

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

`publishableFindings` supplies the findings: CONFIRMED ones and verifier
additions for review and deep, REPORTED ones for a quick review. A saved
review without a verification field is trusted only when its profile is review
or deep. Planning (model) uses pages of at most four findings plus report segments, with
CONTINUE checkpoints when a page needs more reading: at most three continuation
sessions per page, and a checkpoint without progress or a fourth unfinished
session ends the page, keeping its finished comments and skipping what is open.
Each page is validated per item: titles, severity labels, path slashes and
HTML comment markers are normalized; anchors are restored against source text
observed during the review; real problems get a repair turn; what remains is
skipped with a reason. For a quick review an inline comment also needs a
finding located on a changed HEAD file and an anchor found in the observed HEAD
source; otherwise the finding stays in the summary index. The disclosure line
of a quick review's comments names its method (and, in the summary, incomplete
coverage). For a quick review the runtime also groups findings of different
sessions with the same severity on overlapping lines of one HEAD file into
`mergeCandidates`, keeps each group on one page, and accepts a planner's
combined comment (`findingIds`, `mergeReason`) only when its members are in one
group, come from different sessions, share a severity and a line, and the
anchor lies on the shared lines; a refused combination falls back to the valid
single comments and reasoned skips. The summary index gives an accepted
combination one row. The assembled plan stores exact content, offsets and markers.

The runtime gives each page what it normally needs: the HEAD source around
each finding (the whole file when small) and a digest of every live thread, both
read deterministically; findings and earlier pages are inline. A page usually
finishes in one model request without tools.

Publication (runtime) rechecks that the PR is active and the head unchanged,
lists every thread, skips items whose marker exists, creates the rest with
`POST …/threads` (right-side `threadContext` for inline items; Azure DevOps adds
the iteration context itself), records each result immediately, and reads all
markers back (`VERIFIED`). Creation results are `POSTED`, `ALREADY_PRESENT`,
`FAILED`, `UNCERTAIN` (resolved by read-back) or `UNVERIFIED`. Re-running
publication is safe.

## Authorization and isolation

Private roles (`azpr-<mode>-functional|risk|verifier|dedupe|comment-plan`, and
`azpr-quick-reviewer|comment-plan`) are hidden
primary agents with explicit models (and variants, when configured). Every
private session gets a grant with the run, role, model and a pending prompt
(text + nonce); a request on another model or variant is refused. Hooks enforce it:

- `prompt`: only the exact pending runtime prompt is admitted; private agents
  cannot be mentioned or delegated.
- `context`: private requests keep only the role's allowlist — AZPR's five
  tools, native read/glob/grep and shell when the `shell` setting allows it;
  every other tool (other MCP servers, edits, web, delegation, CodeMode) is
  removed. Ordinary sessions lose only AZPR's tools. Comment pages that read too
  much get their tools removed to force a checkpoint.
- `model.request`: only primary requests after an authorized context; compaction,
  generation and title requests are refused (compaction marks overflow).
- `retry`: host retries continue only while the grant is active; the announced
  wait does not count as inactivity. OpenCode prepares the resend again
  (`context`, then `model.request`), so it passes the primary-request check.
- `permission` `evaluate`: enforces the `shell` setting for private roles,
  allows reads of AZPR's own private data directory and refuses at once any
  other request that would wait for an approval (private sessions run
  unattended); only shell under `shell: "ask"` or `"inherit"` may wait. A
  native read, glob or grep on a repository path is refused with a pointer to
  the azpr tools.
- `tool.execute.before`: refuses any tool outside the allowlist and delegation.
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
visible tool errors so the model can report the gap.

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

## Compatibility

`host.mjs` normalizes list/record response shapes, detects optional capabilities
(`permission.hook`, `tool.transform`) and holds the host continuation text.
Without `permission.hook` the project boundary for native read tools is left to
the host's own permission rules; `/pr-check` shows a WARNING row and reviews
still run.
Receipts note when the detected OpenCode version differs from the tested one
(`TESTED_HOST_VERSION`, 2.0.32).
REST paths and the pinned api-version live only in `azure.mjs`; see
[Azure DevOps access](AZURE_DEVOPS.md) for the API list and version policy.
