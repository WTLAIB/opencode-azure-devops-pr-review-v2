# Architecture

This is an independent V2 implementation targeting OpenCode 2.0.22, official
Azure DevOps MCP 2.9.0 and Ubuntu 22.04. The source-only plugin uses host domains;
it contains no provider client, Azure SDK, MCP dispatcher catalog or V1 shim.

## Components

| File | Responsibility |
| --- | --- |
| `src/plugin.js` | V2 default plugin definition and setup entry. |
| `src/config.mjs` | Strict settings, immutable roles, native denials, compiled Agent.Info. |
| `src/session.mjs` | Exact V2 create/admit/wait/context/interrupt/synthetic contract. |
| `src/runtime.mjs` | Command registration, grants, workflow, cancellation and lifecycle. |
| `src/output.mjs` | Review envelope extraction, syntax recovery, best-effort delivery and final evidence assessment. |
| `src/comments.mjs` | Comment target, preview validation, stable markers and uncertain-attempt ledger. |
| `src/attribution.mjs` | Deterministic reports, provenance, notices and receipts. |
| `src/diagnostics.mjs` | Optional private evidence files and local timing observations. |
| `src/prompts/` | Shared policies plus check, review, deep, verifier and comment instructions. |

Active review and comment roles receive a numbered display of plain, multiline
tool text when its single text block exactly matches the raw string output.
The request arguments stay beside that display to help distinguish source
versions. When the admitted stage already has a snapshot, exact string argument
values matching its head/base receive HEAD (PR source) / BASE (PR target reference)
labels. These label arguments only: they do not certify selector semantics,
returned bytes or a merge base. No snapshot is invented for independent initials.
The original output bytes remain unchanged. Native displays, errors,
truncated results, structured output, wrappers and attachments pass through.
This uses the public `tool.execute.after` result hook without classifying MCP
names or actions. It adds no requests, fields, source certificate or completion
gate. Display row numbers are source positions only for complete unwrapped files;
models still establish the file/version and interpret the evidence.

The installer creates one `plugins/azpr-v2` ESM package with a generated `server.js`
entry re-exporting `plugin.js`, matching package exports, eight JavaScript modules,
nine prompts and private settings. The Python settings helper runs only during
installation. No top-level loader or
Markdown command expansion is involved. Optional docs/schema/uninstaller do not
change runtime requirements. The installer merges missing current defaults;
obsolete profiles/keys fail instead of being migrated. See README's exact list.

## Explicit commands and private roles

`ctx.command.transform` registers five commands. Their callbacks consume literal
`prompt.text`, reject attachments, and handle the entire workflow without an
ordinary-agent model invocation. Matching text in a normal chat, PR comment or
MCP result cannot grant access. Reserved command/agent conflicts fail closed.

`ctx.agent.transform` creates hidden primary agents with explicit provider/model
references and composed system text. Unconfigured deep roles are absent.
The host's post-configuration phase applies global/project
permissions after external transforms. Before use, the adapter validates resolved
protected fields, retains host permission rules, and pins the complete role
configuration. Changes to settings or resolved roles require a restart.

Each private session has an active run grant, exact role/model, expected literal
input and a random admission nonce carried in metadata, outside the model text.
The prompt/context/tool hooks enforce that grant. Private agent mentions,
delegation, manual model switching and reuse of stopped sessions are rejected.
Ordinary sessions pass through without reading plugin settings.

An additional `session.model.request` hook covers every V2 model request kind,
including operations that do not trigger `prompt` or `context`. Only a primary
request preceded by the granted context hook is authorized. Private generation,
title and compaction requests fail before provider submission, including after
completion and after a host restart. No in-memory session ID is needed to reject
an ungranted private role. Compaction fails early because its summary cannot
replace the exact admitted input in the current evidence contract.

Workflow-owned preflight checks all selected role models through `model.list`
and reads MCP connection state through `mcp.list`. It records value-free readiness
counts. The public MCP status schema has no server configuration/tool provenance;
the adapter does not infer Azure identity or `codemode:false` from a connection.
No provider fallback, extra inference, MCP action classifier or permission grant
is introduced. The existing review evidence checks remain authoritative.

Initial reviewers, the verifier and comment roles inherit host shell/read/glob/grep
permissions. The plugin adds no permission rule for those tools. Standalone
source readiness still denies shell/search. All private roles deny native editing,
delegation, skills, public web, interactive questions, host session/model control
and CodeMode execute. CodeMode's built-in fetch is not permission-gated in the
target host; use direct MCP tools with codemode:false. See
[MCP boundaries](AZURE_MCP.md#direct-mcp-tools-are-required).

The execution hook enforces these role-specific denials even if later host rules
expose a prohibited schema. A second distinct prohibited attempt revokes the run;
a host hook failure can terminate execution on the first. Allowed project tools
recheck the active reviewer role/model and use the host's permission decision.
There is no separate plugin shell permission setting.

MCP action meanings remain host/server-owned. The plugin cannot guarantee that a
reviewer's generic MCP call is read-only. Nor does the saved-output prompt policy
programmatically prove local-file provenance. These limits must remain explicit.

## V2 session lifecycle

1. Create a child session already bound to the exact role/model; verify the
   returned identity, parent and selection before admitting input.
2. `session.prompt` returns a queued inbox item, not the final answer. Validate
   its ID, type, literal payload, metadata and delivery; do not submit again.
3. `session.wait` waits for idle. Read `session.context` and session info, locating
   exactly that admitted user message. Require unchanged projected input and no
   interleaved user/switch/other input. Unrelated synthetic input also fails.
4. Require a successful terminal idle and complete final assistant text with
   stop finish, matching granted role/model. Exclude provider reasoning and
   earlier tool turns. If compaction removed the exact input, fail closed.
5. Revoke the grant before cleanup. A completed reviewer cannot be resumed by
   ordinary messages. Raw captured failures remain available in diagnostics.

Initial/final review text may recover the pinned host's incomplete-stream
continuation when the authoritative context contains the failed text response,
matching retry metadata, exact host continuation message and direct text
continuation ending successfully in the same role/model. Only the observed
missing `finish_reason` protocol is recognized. Literal fragments are joined
without inserted text; ordinary extraction and final evidence checks still
apply. Diagnostics preserve visible fragments and disclose recovery. This adds
no plugin model request and cannot recover cancellation, failed final sessions,
tool execution between fragments or missing admission. Check/comment roles keep
the strict transport path.


Recognized provider failures expose only the HTTP error status and the number
of tool calls observed in admitted assistant context. Authentication/authorization
statuses point to provider access and role/tool compatibility, not JSON repair.
Raw provider details stay outside the receipt; private diagnostics retain the
error message/status, while full bodies require the original host response.
Cancellation stays distinct; no fallback, retry or permission change is
introduced by this diagnostic.

There is no whole-run timer when runTimeoutSeconds is null. Explicit finite
seconds create one deadline shared by all stages. Cancellation
or disposal revokes grants synchronously, then interrupts and waits for each
session with bounded cleanup. The Promise adapter ignores extra request options;
local AbortSignal races are not server cancellation. Track pending admissions
before interrupt so a delayed prompt cannot start after an idle acknowledgment.
Unconfirmed settlement is visible in receipts and prevents recovery.

The same run signal covers settings reads, command/agent catalog validation,
initial role pinning and model/MCP preflight. Cancellation can therefore release
the command and origin lock while a non-cancellable SDK read remains pending.
Late read results cannot create a reviewer or restore a revoked grant. A pending
read is distinct from an unconfirmed in-flight model/session interruption.
Concurrent origins own their initial role reads; cancelling one cannot reject
another origin's preflight or replace an already pinned role fingerprint.

A completed PARTIAL initial or an admitted execution failure does not cancel
useful sibling work. Both outcomes reach the existing verifier as available
observations or an explicit unavailable-stage notice. Failed/interrupted response
text is not accepted as evidence. Configuration, admission and permission failures
before a stage starts still revoke the workflow. Manual cancellation and an
explicit timeout stop pending work; there is no new default deadline.
Origin/PR locks prevent duplicate review or publication workflows.
Report retention is in-memory and bounded by report count, never evidence size.
The latest 20 completed reviews survive until eviction or plugin/process exit;
there is no TTL or restoration from debug files. A comment command may omit its
review ID and select the latest completed review from its own origin only.
Completed report/comment-result sessions route explicit commands back to that
same origin for locking, permissions and child creation. This does not authorize
ordinary prompts to resume a revoked reviewer or cross-conversation selection.

## Review delivery and publication assessment

Normal and deep each run two independent initial stages and the existing verifier.
The runtime retains partial observations, coverage gaps, extra fields and literal
unstructured text. Available consistent snapshots contribute a union of paths;
conflicting frames remain visible and are not silently merged. With no usable
initial snapshot, the verifier receives the PR request and establishes its own.
The target comparison commit is not a proven merge base.

Both initial roles include architecture and test quality in their review scope.
Functional review considers responsibilities, dependencies, ownership, interfaces
and behavioral test coverage. Risk review considers failure/trust boundaries,
recovery and tests of adverse or concurrent behavior. These are directions for
model judgment, not mandatory topic sections, finding quotas or extra completion
gates. Useful design tradeoffs and test gaps can remain in the existing report
without being promoted into confirmed defects. The verifier adjudicates concrete
findings through the existing evidence contract; no additional model round is used.

Reviewers use their current OpenCode project for model-chosen verification methods,
including tests, reproductions and static inspection. OpenCode child sessions
[inherit the origin's location and session permissions](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/session.ts#L254).
MCP remains the source for remote PR identity, paths and exact-commit content;
no local Git repository or history is required. Models do not clone/fetch for
review. They may save needed MCP-returned files in fresh temporary directories
for experiments, preserving provenance and distinguishing modified reproductions.
This replaces the custom isolated executor; no repository mappings, root filesystems, subprocess launcher,
resource settings or runtime verification ledger remain. Relevant commands and
observations belong in the existing review evidence/report fields, with original
tool results in the host session. The verifier must attribute initial observations
and establish the PR evidence independently.

Native shell executes with ordinary host authority. The plugin does not guarantee
filesystem/network isolation or prevent side effects of permitted commands.
Reviewers must preserve user work and distinguish a dirty/different local checkout
from the PR commit. Test failure or missing execution does not impose a completion
gate. Cancellation revokes grants and interrupts/waits for host sessions; it does
not guarantee termination of detached processes or undo side effects. Unconfirmed
session settlement still prevents a COMPLETE cache. See
[project verification](VERIFICATION.md).

JSON is preferred, not a prerequisite for retaining useful review content.
Completed stop-finish responses use an iterative grammar-aware recovery pass for
trailing/missing commas, missing colons or terminal structure delimiters, redundant
root closers, single/smart quotes, quoted literal controls, bare object keys and
JSON comments. String content is preserved; incomplete values, array holes and
conflicting duplicate keys are not silently repaired. Ambiguous JSON and prose
are retained literally for verification or report presentation. Failed execution,
context mismatch and truncation remain separate from correctable syntax.

Known key spelling, enum case, quoted SHA wrappers and simple section shapes are
normalized locally. Extra information stays in the result. Missing, malformed or
duplicate IDs in initial and new-verifier findings receive unique runtime tracking
IDs, with supplied IDs retained when replaced. Original disposition IDs are never
remapped by this recovery. Missing evidence is never fabricated. The verifier is asked to verify
all candidates independently. Omitted original decisions become explicit runtime
UNREVIEWED rows, with the full original observations shown in the report.

Strict validators assess structured evidence, full identity/versions, coverage,
source/counterevidence and original-ID decisions. Review quality defects produce
limitations and a readable PARTIAL result instead of throwing away the review.
A model-declared stale review or changed current SHAs remains STALE. An absent
snapshot may be displayed from initial metadata, explicitly labelled as such;
missing current SHAs are never copied from an older snapshot.

Every COMPLETE review enters the same-origin comment cache. The independent
verifier must pass the final evidence, requested snapshot, current-version and
original-ID checks. Initial coverage disclosures, partial/unavailable initials
and their frame warnings remain context for verification and comment planning;
they are not a second publication veto. A corrected section shape can keep its
warning without downgrading a final result that passes these checks. Borrowed
verifier identity, conflicting field aliases, missing final evidence/decisions,
stale versions and unstructured final prose still cannot establish completeness.
Unconfirmed session settlement makes the workflow INCOMPLETE, avoiding a COMPLETE
receipt with no comment-cache entry. Completion never publishes automatically.

Fenced extraction consumes Markdown blocks in order, so a code example closing
fence cannot swallow the next JSON block. It selects a unique review-shaped
object and retains surrounding prose/examples. Another complete or unfinished
review candidate, including a status-only verdict, prevents automatic selection.
An incidental dictionary literal is not a competing review. Comment preview
also extracts a unique strict plan object while retaining surrounding notes in
its session and optional stage record. It uses the same ambiguity checks without
review syntax repair or field normalization. Settings, source checks and
publication receipts do not use this extraction.

All review recovery uses local normalization and the existing review rounds.
There are no model requests for status, location, disposition or final-content
repair. Standalone source checks, settings and publication receipts continue to
use strict parsing. Comment-plan structure and semantic validation remain
unchanged after extraction. Raw responses, failures and limitations are kept.

## Presentation, comments and diagnostics

A deterministic renderer formats final findings, dispositions and invoked model
provenance. Synthetic notices carry full text in their description and use
resume:false. Receipt mode carries status/session/diagnostic locations; full mode
also carries the report to the origin. PARTIAL, STALE and incomplete draft bodies
are included even in receipt mode. Queuing never starts a formatter model and
does not certify TUI display. See [debugging](DEBUGGING.md#output-and-report-presentation).

COMPLETE same-origin reviews enter the comment cache. Preview verifies
eligible corrected findings, anchors, severity and exact content with AI
attribution. Preview displays the full comment count without a numerical quota.
Explicit --publish reuses a saved preview or runs planning and publication in one
workflow. The planner must finish with a validated saved plan before any publisher
starts. The stages share the command's cancellation/deadline and origin/PR locks;
no additional reviewer or automatic retry is introduced. Empty plans return
NOTHING_TO_POST with skip reasons and no publisher. A planning failure retains
the review and exposes an optional model-supplied reason, or states that none was
provided. The report footer supplies exact direct/preview commands and memory
retention limits. No separate config switch applies.
The saved plan adds line-local character offsets derived from its existing
anchor. This does not add fields the planner must generate or inspect MCP schemas
in code; the publisher translates the saved positions to the available tool.
Publisher input contains only the target, snapshot, output language and saved
comments. Full report/finding/source observations remain planner context. Current
PR and discussion checks apply once to the batch; preview-verified immutable
anchors need no mandatory reread. Models read further when evidence is missing
or uncertain, without adding a stage or a request budget.
Before publication, mark every planned item uncertain; results can only update
that ledger to model-reported outcomes. Any observed execution-hook error or
explicit error result during publication synchronously revokes grants before
interruption is awaited. This stops subsequent authorized model/tool requests
without classifying MCP actions; it cannot recall calls already dispatched.
No automatic retry or independent provider verification is claimed.

Optional diagnostics persist requests, visible answers, stage results and rendered
reports under private permissions; never provider reasoning or full host config.
Tool hook counts/timing do not audit source contents. Missing outcomes remain
unknown; an MCP error, host truncation and a blocked native attempt are distinct.
Opt-in `toolErrors` retain scalar execution-error fields before cancellation can
replace the host outcome with an interruption. They omit arguments, result bodies
and nested provider data; receipts do not echo these private messages.
Request-kind observations count hook events and authorized primary preparations,
not billable HTTP requests. The retry hook preserves the host's proposal during
ordinary review, rejects it for revoked grants, and
records only attempt/decision/delay. It never starts or expands a retry policy.
See [validation](VALIDATION.md) for tests and remaining service/OS acceptance.

## Exact upstream contracts

The inspected host source revision is
[527f0b931d1f9b3ebd34e106c51b31ce5db5b075](https://github.com/anomalyco/opencode/tree/527f0b931d1f9b3ebd34e106c51b31ce5db5b075).
The matching npm plugin/schema/API artifacts are 2.0.22. Audit an upgrade against
that source/API and an isolated actual-host fixture before changing the target.
The [V2 plugin guide](https://opencode.ai/v2/docs/build/plugins/) describes the
public model; exact-version source and runtime evidence determine this adapter's
claims. Model/provider/MCP/OS acceptance remains separate from host API tests.


Successful multiline review tool text is retained with its observed request
arguments for same-origin comment planning. The existing display
eligibility excludes flagged failures, truncation and unsupported wrappers;
native project-tool output is excluded. Identical tool/arguments/raw-text
observations are deduplicated, with no source-content classification or new
model request. The completed-review cache owns this temporary data and drops it
with the review; no checkout, persisted cache or repository map is introduced.
Captured text is data, not source/commit certification or a new eligibility gate.
Initials remain independent and the verifier retains its existing source checks.
