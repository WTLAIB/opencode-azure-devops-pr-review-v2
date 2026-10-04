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

The installer creates one `plugins/azpr-v2` ESM package with a generated `server.js`
entry re-exporting `plugin.js`, matching package exports, eight source modules,
nine prompts and private settings. No top-level loader or
Markdown command expansion is involved. Optional docs/schema/uninstaller do not
change runtime requirements. The installer merges missing current defaults;
obsolete profiles/keys fail instead of being migrated. See README's exact list.

## Explicit commands and private roles

`ctx.command.transform` registers five commands. Their callbacks consume literal
`prompt.text`, reject attachments, and handle the entire workflow without an
ordinary-agent model invocation. Matching text in a normal chat, PR comment or
MCP result cannot grant access. Reserved command/agent conflicts fail closed.

`ctx.agent.transform` creates hidden primary agents with explicit provider/model
references and composed system text. Unconfigured deep roles and disabled
publishers are absent. The host's post-configuration phase applies global/project
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

The private native deny set includes shell, mutation, delegation, skills,
public web, unrestricted local search, interactive questions, host session/model
control and CodeMode execute. CodeMode's built-in fetch is not permission-gated
in the target host; private roles therefore require direct MCP tools configured
with codemode:false. See [MCP boundaries](AZURE_MCP.md#direct-mcp-tools-are-required).
Host global rules still apply. shellToolPermission=ask sets the private host rule to ask; final host rules
determine schema exposure. The immutable execution guard still applies. The second observed distinct native attempt
revokes the run; a host hook failure can terminate execution on the first.

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
   interleaved user/synthetic/switch/other input.
4. Require a successful terminal idle and complete final assistant text with
   stop finish, matching granted role/model. Exclude provider reasoning and
   earlier tool turns. If compaction removed the exact input, fail closed.
5. Revoke the grant before cleanup. A completed reviewer cannot be resumed by
   ordinary messages. Raw captured failures remain available in diagnostics.

There is no whole-run timer when runTimeoutSeconds is null. Explicit finite
seconds create one deadline shared by original stages and amendments. Cancellation
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

Reviewers can inspect test source and relevant existing CI results through
authorized reads, distinguishing the tested commit and scope from static predictions.
The adapter creates host child sessions; it does not prepare an isolated checkout
or test execution environment. Running PR tests can execute project code, hooks
and dependencies with the host's authority, and the current workspace need not
match the reviewed SHA. Native execution and pipeline triggering therefore remain
outside this review workflow. Missing execution alone does not make a review
incomplete. An optional isolated runner is a future capability, not a prerequisite
for delivering useful reviews.

JSON is preferred, not a prerequisite for retaining useful review content.
Completed stop-finish responses use an iterative grammar-aware recovery pass for
trailing/missing commas, missing colons or terminal structure delimiters, redundant
root closers, single/smart quotes, quoted literal controls, bare object keys and
JSON comments. String content is preserved; incomplete values, array holes and
conflicting duplicate keys are not silently repaired. Ambiguous JSON and prose
are retained literally for verification or report presentation. Failed execution,
context mismatch and truncation remain separate from correctable syntax.

Known key spelling, enum case, quoted SHA wrappers and simple section shapes are
normalized locally. Extra information stays in the result. Missing or duplicate
initial IDs receive unique runtime tracking IDs, with supplied IDs retained when
replaced. Missing evidence is never fabricated. The verifier is asked to verify
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
An incidental dictionary literal is not a competing review. Settings, source
checks and publication receipts do not use this review-only extraction.

All recovery uses the existing model rounds. No extra model request fixes review
format or missing fields, even with outputRetries=1. That setting retains an
eligible standalone source-check status amendment under its existing tool-free,
one-request and original-deadline rules. Checks, settings and comment operations
continue to use strict parsing. Raw responses, failures and limitations are kept.

## Presentation, comments and diagnostics

A deterministic renderer formats final findings, dispositions and invoked model
provenance. Synthetic notices carry full text in their description and use
resume:false. Receipt mode carries status/session/diagnostic locations; full mode
also carries the report to the origin. PARTIAL, STALE and incomplete draft bodies
are included even in receipt mode. Queuing never starts a formatter model and
does not certify TUI display. See [debugging](DEBUGGING.md#output-and-report-presentation).

COMPLETE same-origin reviews enter the comment cache. Preview verifies
eligible corrected findings, anchors, severity, count and exact content with AI
attribution. Explicit --publish requires comments.enabled and a saved preview.
The saved plan adds line-local character offsets derived from its existing
anchor. This does not add fields the planner must generate or inspect MCP schemas
in code; the publisher translates the saved positions to the available tool.
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
Request-kind observations count hook events and authorized primary preparations,
not billable HTTP requests. The retry hook preserves the host's proposal during
ordinary review, rejects it for revoked grants and one-request amendments, and
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
