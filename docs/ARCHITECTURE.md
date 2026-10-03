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
| `src/output.mjs` | Unique JSON parsing, complete evidence/disposition validation and bounded tolerance. |
| `src/comments.mjs` | Comment target, preview validation, stable markers and uncertain-attempt ledger. |
| `src/attribution.mjs` | Deterministic reports, provenance, notices and receipts. |
| `src/diagnostics.mjs` | Optional private evidence files and local timing observations. |
| `src/prompts/` | Shared policies plus check, review, deep, verifier and comment instructions. |

The installer creates one `plugins/azpr-v2` ESM package with an exported entry,
eight source modules, nine prompts and private settings. No top-level loader or
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

Initial failures or valid PARTIAL results revoke sibling work, including a
sibling SDK promise that never settles. Valid partial evidence remains in the
incomplete draft and diagnostics. Origin/PR locks prevent duplicate review or publication workflows.
Report retention is in-memory and bounded by report count, never evidence size.

## Review and evidence contract

Normal and deep each run two independent full-scope initial stages concurrently.
Focus differs (functional versus risk); source coverage obligations do not.
They independently discover PR identity, PR-reported source/target SHAs and paths.
The runtime compares identity/version/scope and passes a sorted union of their
unique discovered paths to the verifier. It does not discover omitted server
pages itself. The target reference is not a proven merge base.

The verifier independently reads source/counterevidence, adjudicates every F/R ID,
may discover new V IDs, and checks current source and target SHAs at completion.
Confirmed findings include corrected evidence, counterevidence, severity,
suggestion and location. Merges must point to real confirmed roots, cannot cycle,
and cannot hide missing original IDs. Rejected and needs-info findings never
become comment candidates. Initial location-only gaps are explicit pending
candidates; final confirmation still requires a verified location.

All outputs are JSON text, optionally one unambiguous fenced JSON body. Reject
unknown envelope keys, duplicate raw/escaped-equivalent keys, invalid statuses,
missing evidence/coverage, truncated or failed finishes, incomplete original-ID
accounting and stale versions. Validate unique path sets, not array order. Strict
structural validation is separate from semantic evidence requirements.

Bounded local tolerance permits known finding-key whitespace, exactly empty/null
unknown finding fields, and exact redundant new-finding dispositions. Normal
initial/verifier JSON with stop finish may remove trailing separators using a
grammar-aware scan. No values or evidence are invented. Preserve raw bytes,
record corrections and validate the whole candidate. A rejected syntax correction
cannot unlock model recovery. Checks, comments and amendments remain strict JSON.

When outputRetries=1, eligible stages may receive one status-only amendment,
missing final-location amendment, missing MERGED-disposition amendment, or complete
final content resubmission. Each shares one stage allowance and original deadline.
Status recovery creates a fresh session; other eligible amendments regrant the
stopped reviewer's own context. Narrow amendments cannot alter existing fields.
Complete resubmission freezes snapshot/current versions and revalidates all
replacement content. No ordinary tools, fallback model or second amendment is
allowed. Original failures remain visible; recovery is model-authored, not proof.

## Presentation, comments and diagnostics

A deterministic renderer formats final findings, dispositions and invoked model
provenance. Synthetic notices carry full text in their description and use
resume:false. Receipt mode carries status/session/diagnostic locations; full mode
also carries the report to the origin. Queuing never starts a formatter model and
does not certify TUI display. See [debugging](DEBUGGING.md#output-and-report-presentation).

Only completed same-origin reviews enter the comment cache. Preview verifies
eligible corrected findings, anchors, severity, count and exact content with AI
attribution. Explicit --publish requires comments.enabled and a saved preview.
Before publication, mark every planned item uncertain; results can only update
that ledger to model-reported outcomes. No automatic retry or independent
provider verification is claimed.

Optional diagnostics persist requests, visible answers, stage results and rendered
reports under private permissions; never provider reasoning or full host config.
Tool hook counts/timing do not audit source contents. Missing outcomes remain
unknown; an MCP error, host truncation and a blocked native attempt are distinct.
See [validation](VALIDATION.md) for tests and remaining service/OS acceptance.

## Exact upstream contracts

The inspected host source revision is
[527f0b931d1f9b3ebd34e106c51b31ce5db5b075](https://github.com/anomalyco/opencode/tree/527f0b931d1f9b3ebd34e106c51b31ce5db5b075).
The matching npm plugin/schema/API artifacts are 2.0.22. Audit an upgrade against
that source/API and an isolated actual-host fixture before changing the target.
The [V2 plugin guide](https://opencode.ai/v2/docs/build/plugins/) describes the
public model; exact-version source and runtime evidence determine this adapter's
claims. Model/provider/MCP/OS acceptance remains separate from host API tests.
