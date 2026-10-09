# Debugging OpenCode V2 reviews

Keep the failed run and inspect its original evidence before changing settings
or starting another model request. The target is `@opencode/cli@2.0.22` with the
official `@azure-devops/mcp@2.9.0`. A passing parser or workflow test does not
establish provider acceptance, Azure source validity, or report quality.

## Enable local diagnostics

Edit the installed `plugins/azpr-v2/settings.json`, keeping the existing model
choices and output language. For example, change these fields in the current
settings object:

```json
{
  "debug": { "enabled": true, "directory": "" },
  "returnReport": "full"
}
```

This is a settings fragment, not a complete profile. Fully restart OpenCode after
editing it. The plugin refuses to mix settings changed during a run.

An empty debug directory selects
`${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2-debug/`. A relative directory
is resolved against the active project; an absolute directory is also accepted.
The `~` shorthand is not expanded in this setting. Each run creates a unique
private directory and reports its location in the receipt. No existing debug
file is overwritten, no automatic deletion is performed, and uninstall does not
remove debug data.

On Linux, newly created directories/files use owner-only permissions. The run
folder includes a `.gitignore`. These controls do not protect forced Git adds,
backups, other software, or secrets echoed in ordinary model output. Debug data
can contain source, PR details, user context, model IDs, and credentials echoed
by a service. Do not commit or upload it. The logger selects visible output and
error fields; it does not save private reasoning, full tool traffic, provider
configuration, or HTTP headers.

## Files and diagnosis order

| Artifact | What it records |
| --- | --- |
| `run.json` | Run identity, settings relevant to execution, start time, and privacy notice. |
| `readiness.json` | Checked role slots, connected MCP count and direct-tool registration observation/timing; source access remains unassessed. |
| `NN-azpr-ROLE.request.json` | Stage identity, literal payload, and applicable instructions. |
| `NN-azpr-ROLE.response.json` | Captured visible model response, finish state, and available error data. |
| `NN-azpr-ROLE.result.json` | Validation outcome, finding/output corrections, observations, and timing. |
| `report.md` | Deterministically rendered report when available. |
| `comment-plan.json` | Exact prepared comments, anchors, offsets, skip reasons and target before optional publication; diagnostic only, not a restorable authorization. |
| `draft.md` | Incomplete, explicitly unconfirmed draft when available. |
| `result.json` | Final status, failure, stage records, cleanup state, and logging warnings. |

The numeric prefix reflects stage creation order; the two initial sessions run
concurrently. A response file may be absent if no response was captured. Missing
files can also reflect a logging failure; inspect `warnings` and host history.
A debug write failure does not authorize retrying the review.

Start with `result.json`, then inspect the failed stage's request, response, and
result together. Distinguish host/session failure, provider failure, MCP failure,
output parsing, evidence validation, final rendering, and model factual quality.
Compare the original response with the parsed result and verifier handoff. Do not
infer a cause from the final status alone.

`Comment planning incomplete: ...` includes the planner's optional `reason`.
When the model returns INCOMPLETE without a reason, the receipt says so instead
of guessing. The completed review remains available for an explicit new comment
command; there is no automatic model retry. A publisher error is different: its
attempt ledger is uncertain and cannot be retried through that review.

For an empty-discussion failure, inspect the actual tool result and whether it
was a full response. A complete unfiltered empty comment collection is not an
unknown missing body; it contains no discussion text to duplicate. Summary-only
responses, pagination gaps and read errors remain distinct. Thread IDs and source
coordinates do not prove that an existing comment survives. No runtime Azure
response classifier or blanket permission override is involved.

Only COMPLETE review IDs select entries in the latest-20 review cache; check and
comment command IDs do not identify a new review. Restart or eviction removes
their plans and attempt state without removing host history or
debug files. Those files are retained with no automatic purge and cannot restore
publication authorization. Both full reports and COMPLETE receipts provide exact
comment commands. `returnReport: full` also displays the complete report; it does
not persist a publishable review or change eligibility.

## Session completion and context limits

V2 prompt admission is asynchronous. The adapter admits one exact literal prompt,
waits for session settlement, reads active context, and verifies that the final
assistant response belongs to that prompt. It accepts only a successful session
ending in a complete text response with `finish: "stop"`. A tool-call turn,
interrupted session, provider error, filtered/length finish, or mismatched context
is not a complete review. A successful initial/final session can recover the
pinned host missing-finish continuation sequence; `hostContinuations` and a
review warning disclose it. Response diagnostics retain each visible fragment
and the original stream error. No plugin prompt retry is added; unrelated
synthetic input, changed admission and unsuccessful terminal states still fail.

The V2 context API returns active context after compaction, not an unlimited
transcript. If the exact admitted prompt disappears or becomes ambiguous, the
adapter refuses the answer. It does not infer identity from a compaction summary
or accept a nearby assistant message. This is a remaining large-context limit
without a plugin iteration or character budget.

Execution failures record bounded session/terminal outcomes, assistant-response
count and final finish state in the stage result. `authorizedPrimaryRequests: 0`
distinguishes failure before a model request from failure after submission.
The receipt does not echo arbitrary provider error text. `wallMinusMonotonicMs`
compares timestamp duration with monotonic timing; a large difference is a clue
for investigating suspension or clock changes, not proof of the interruption
cause and not permission to retry or claim a successful response.

Private compaction fails at the V2 model-request boundary before any summary
request is sent. Transient `session.generate` and title requests are also denied
for private reviewers. A missing exact input remains a failure even if a later
host or plugin changes compaction behavior. Ordinary sessions are unaffected.

Review inputs come from native command `prompt.text`. They remain literal text;
there is no Markdown command template or placeholder sentinel. Attached files,
agent mentions, and skills are rejected for these commands. Reviewers cannot be
resumed with an ordinary prompt after their grant expires.

## Output and report presentation

Reviews prefer JSON text. Common syntax and field-shape mistakes are normalized
locally; ambiguous or unstructured completed output remains literal review data.
No native StructuredOutput path, parser dependency or formatting model is used.
Settings, source checks and comment operations keep strict JSON contracts.

Inspect `outputFormatCorrections` for syntax repairs or literal-output retention.
Offsets are zero-based UTF-16 positions in the selected JSON body. Inspect
`reviewWarnings` and the original response for quality or structural gaps.
Extra fields remain available; known key spelling and enum case can be normalized.
`extract-review-envelope` records selection of a unique review object from prose
or code fences. Braces in ordinary code examples do not block selection.
Surrounding text remains attached; competing review candidates or duplicate
keys retain the complete literal output instead.
A missing, malformed or duplicate initial/new-verifier ID receives a runtime tracking ID rather than
losing its observation. Missing final decisions appear as runtime UNREVIEWED,
with the original observations shown separately. These are not model verdicts.

PARTIAL initial outputs and admitted initial failures continue to the existing
verifier. A failed execution contributes an unavailable-stage notice, not accepted
partial model text. If the verifier cannot return complete structured evidence,
its available observations appear in a PARTIAL report. A failed verifier execution
retains available initial observations as an incomplete draft. Missing details do
not become guessed evidence, a confirmed finding or a fabricated fresh SHA.

COMPLETE means the final verifier passed structured evidence and version checks,
and the review can enter comment preview in the original session/process. Initial
limitations do not impose another eligibility gate. Read the limitations even
when the workflow completes; preview still rechecks anchors and duplicates. A partial/stale report or incomplete
draft includes its body even when returnReport is receipt. Synthetic notices use
resume:false and do not start a formatting model. Queue acknowledgement does not
certify every UI's rendering; inspect existing sessions without prompting them.

Check unsupported claims about permanence, recovery, ordering and business impact
against actual source and counterexamples. A parseable result cannot establish
those facts. The original response and failures remain in private diagnostics.

## Output recovery

Review formatting recovery is local and does not create additional model
requests. Useful incomplete content is retained for the existing verifier and
report. Standalone `/pr-check` uses strict validation and retains an invalid
answer as a diagnostic failure; it never asks a model to amend it.
Execution failure, cancellation, compaction, unknown settlement and publication
are not repaired by asking a formatting model to regenerate a review.

## Tool observations and permissions

Initial reviewers, the verifier and comment roles use native shell/read/search under OpenCode's
normal permissions. Check the active project's host rules and pending approval
requests when execution is unavailable. Comment roles inherit those same
project permissions; standalone readiness still denies shell/search. All private roles deny CodeMode `execute`, native editing, delegation
and public web tools. Set MCP `codemode: false` for direct tools. See
[the CodeMode boundary and MCP limitations](AZURE_MCP.md).

A forbidden native attempt is prevented before execution. Two distinct blocked
attempts in a stage stop the run. These observations must remain visible even
when no forbidden operation executed. They are different from MCP tool failures
and provider rejection before any tool request.

`Model provider request failed (HTTP ...; ... tool calls observed)` separates
provider rejection from review-format failures. It exposes only bounded host
metadata; raw provider error messages and response bodies stay in private evidence.
A zero observed-tool count describes the admitted assistant context, not a network
or billing audit. Check the original error before attributing a 401/403 to Azure.

Provider admission can depend on the exposed tool schema and host permissions.
Earlier controlled probes are preserved in
[validation history](VALIDATION_HISTORY.md#historical-provider-permission-probes);
they do not justify restoring removed settings or bypassing a denial. Current
comment roles inherit real host project-tool permissions. Check actual catalog
availability and provider access separately, without spoofing client identity or
silently changing models. A catalog entry is not proof of usable quota or cost.

If initial snapshots disagree, inspect the original metadata and labels before
retrying. The common label uses `organization/project-id/repository-id`, with
both stable IDs from the same PR metadata response. Project display names and
project IDs are not interchangeable strings in this contract. The runtime preserves the differing labels and asks the verifier to resolve the
requested PR. It does not guess name/ID equivalence. The final verifier must
establish the expected requested frame and current versions; a valid final
result can proceed to comment preview with initial warnings preserved.

`toolObservations` summarizes matching V2 execution hooks. Completed/error counts
are execution observations, while `reportedErrors` and `truncated` record explicit
result flags. Counts overlap; do not add them as unique failures. `withoutOutcome`
means a registered call has no observed outcome. `unverifiedResults` means only
that no error/truncation flag was observed. `evidenceValidity: "not-assessed"` and
`recoveredReads: null` deliberately leave source truth and recovery unknown.

A tool can report success with incomplete or semantically wrong content. Empty
`warnings` records do not prove zero MCP errors, and absent events do not prove
no errors occurred. These counters do not contain arguments, source bodies,
private output paths, or inferred causes. Inspect original host tool history to
check exact versions and distinguish directory selector failures, content-read
failures, search-service errors, and actual recovery.

With debug enabled, `toolErrors` also retains the tool name and scalar execution
error name/type/message/status observed before grant revocation. Interruption can
otherwise replace the original host tool error with an aborted outcome. Explicit
error-result flags without an execution error retain only their source, not the
result body. These private summaries omit arguments, headers, nested provider
data and reasoning; receipts do not echo them. Error messages may still contain
sensitive text, so do not publish the diagnostic files.

## Timing, cancellation, and large output

`requestObservations` separates primary, compaction, generate, title and unknown
request-kind hooks, authorized primary preparations, rejections, and host retry
proposals. It records no request bodies, headers or provider error text. These
are observations of hooks, not a count of network requests or billed usage.
Normal review retains the host's retry decision. Revoked grants cannot retry;
no new retry policy is added.

`A publisher tool failed` means the publication stage observed a tool error and
revoked its grants immediately. This includes explicit error results returned
through a completed hook. The uncertain-attempt ledger stays intact; inspect
Azure even if the error appears to be parameter validation. An existing thread
does not prove correct coordinates: compare its body, file, line range and
line-local character offsets with the saved preview. Cumulative file offsets
are not valid substitutes. Preserve the original evidence before any authorized
correction; never infer that an interrupted write had no remote effect.

With debug enabled, stage timing records model-request windows, tool intervals,
response processing, and time after the last completed tool. Overlapping tool
intervals count once; missing outcomes remain unknown. These measurements include
host/provider waiting and are not pure inference time or Azure server latency.
Input/output character counts and request counts are observations, not budgets.

`runTimeoutSeconds: null` creates no whole-command timer. A configured finite
value applies to the entire command, including all stages and presentation;
recovery does not reset it. Use `/pr-stop <run-id>` from an ordinary session in
the same process to cancel. Grants are revoked before cleanup awaits the host.
Interrupt acknowledgement alone is insufficient; the adapter also waits for
settlement. `abortUnconfirmed` means the bounded cleanup did not establish that
remote work stopped, and sent requests may still incur usage.

Catalog/settings checks also share the run's cancellation signal. `/pr-stop`
can release the command and origin lock while a host catalog read remains pending;
late read results cannot authorize new work. No additional default timer is used.

The V2 Promise adapter does not reliably propagate request AbortSignals. Local
cancellation stops acceptance and the plugin's grants, while cleanup explicitly
interrupts and waits. Preserve uncertainty if that cleanup fails. There is no
plugin spending cap, iteration cap, or stage-character cap. Host context limits,
MCP pagination, server-side truncation, and service limits remain independent.

## Project verification

OpenCode's native tools operate in the current project. Inspect the child session's
location, inherited permissions, approval requests and actual tool result. No plugin repo
mapping or root filesystem is needed. A local checkout or Git history is optional;
MCP supplies the remote source. Models may save needed retrieved files in fresh
temporary directories, recording source commits and any reproduction changes.
A checkout different from the PR head must be disclosed; do not reset user work
to make a test apply.

Distinguish tool execution failure from a test command's nonzero exit. Read the
output and tested state before interpreting either; a shell pipeline can return
zero even when a test fails. Neither creates a new review completion requirement.
The host session retains native command results; debug stage records expose tool
counts and errors. There is no separate plugin execution ledger.
See [project verification](VERIFICATION.md) for permissions and cancellation scope.

## Connected MCP before tool registration

In the pinned host, connection and tool-registry reconciliation are separate,
and the public tool-list API reads the current registry. See the pinned host
[registration implementation](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/tool/mcp.ts)
and [catalog implementation](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/tool.ts).
A single catalog read is not a registration barrier. Before inference, readiness
observes the public tool catalog for direct tools in connected servers' host
namespaces, using the pinned host's namespace encoding. It polls local metadata
every 50 ms for at most five seconds, returning immediately when tools appear.
This is a cancellable startup grace period, not a model iteration/time limit or
new refusal: unavailable/unobserved registration is recorded and the existing
workflow continues. It does not reload servers, retry a model or add permissions.
Namespace observation does not classify MCP actions, prove Azure source access,
or override role-filtered tool exposure. Source-supported sibling/final results
remain usable. Inspect original contexts and tool history when a provider still
acts as though tools are missing. Never troubleshoot by exposing credentials or
printing the host configuration; native shell retains ordinary host authority.

## Source versions and anchors

Planner request diagnostics now include `evidenceIndex`, not embedded
`reviewToolText`. Its private JSONL entries retain original arguments and exact
output references. `reportReference`, `priorPlanning` and `workEvidence` point to
complete report text, completed fragments and prior comment tool observations.
Empty source observations do not block planning; the model may read missing data.
These files can contain source code and PR data and require the same protection as
other private diagnostics. They cannot restore publication authority after restart.

`commentWork` identifies plan, publication-check or publish pages. Stage numbers
vary with data size and checkpoints; identify the role and page instead of assuming
one planner and one publisher. `inputFieldCharacters` attributes serialized input
size to each field; `visibleToolCharacters` measures model-visible tool data and
arguments. These are UTF-16 character observations, not provider token counts.
Large complete tool results are saved and replaced by references before admission
to subsequent model history. Read-only checkpoints preserve exact records in new
sessions; host compaction remains blocked. A CONTINUE checkpoint is successful
progress, not a retry of a rejected, interrupted or failed response.
Publisher inputs include only assigned saved items, target, relevant paths,
language and work metadata. Inspect `comment-plan.json` for the complete approved
content; a large publisher text placeholder must restore to that exact text in
`execute.before`. Data pages are transport offsets, not Azure source coordinates.
Numbered displays may include snapshot argument labels when that stage already
knows a selected snapshot. Compare the original arguments and bytes if HEAD/BASE
reasoning is wrong: a matching string does not certify selector semantics or the
returned revision. Substring/key-name matches do not produce labels; both labels
remain visible if the same value matches both references.

Correct snapshot SHAs do not establish correct BASE/HEAD interpretation. When a
report reverses a change, correlate each decisive statement with its own tool
request's path/commit and returned body, then inspect the original initial and
verifier answers, including exclusions. The shared prompt establishes proposed
HEAD behavior first and compares it with a short BASE evidence pair in existing
fields. A PR title or an apparent improvement cannot assign the source side.
For model-created test files, compare the actual contents with the claimed
commit; a directory named `head` or passing tests is not version evidence.
Keep a corrected final verdict separate from an initial reversal. This guidance
adds no source-comparison code, persisted data, output fields or model rounds.

For comment `anchorRestorations`, compare the retained response.json with the
result.json saved anchor and original captured output. Restoration only fixes
indentation/quote display and uniquely locatable counted lines. It cannot certify
full-file content or provenance. `locationRestorations` keeps original/restored
coordinates; ambiguous matches stay untouched. Known excluded verifier IDs can appear in skipped
notes without enabling a comment for those IDs.

## Summary and inline publication

Inspect `comment-plan.json` for the saved general summary and inline comments.
The summary marker has a separate attempt entry (`kind: summary`), while inline
entries retain finding IDs. `summaryThreadId` is model-reported; Azure readback
is still necessary for independent confirmation. A missing summary result or
any uncertain inline write leaves the batch incomplete. Do not retry, delete or
rewrite the summary to conceal partial publication.

Optional planner summary prose precedes the issue index with useful PR-wide
context: a supported purpose or change overview, then useful shared impact or fix
priorities. Review IDs and commit SHAs stay in local records; their absence from
the public summary does not remove the saved review/HEAD binding. Review
methods and test results need no separate account. Routine
publication bookkeeping belongs in local diagnostics. Inspect the planner's
original `summary` when notes are noisy: the runtime adds the localized heading
and preserves the prose; it does not semantically filter or translate it.
Counts and the index come from corrected findings. Missing/malformed prose omits
the notes section while retaining the summary; a heading does not prove quality.
Inspect checked example calculations and expected/actual results separately.

For missing improvement suggestions, compare both initial `report` fields with
the final verifier's `report`, then the planner's original `summaryDetails` and
the saved summary. Only final-report recommendations reach the planner; advice
left solely in an initial report cannot be recovered by the publisher. Check
that each retained recommendation has affected code, a useful benefit and a
practical direction, with duplicate advice combined and evidence limits intact.
Confirmed findings without inline coverage need a useful summary explanation
or reference to their existing discussion. Neither COMPLETE nor a valid plan
proves this semantic coverage. Missing/non-text optional details omit the section;
valid detail text is not subject to the introduction's length cap. HTML-comment
delimiters are displayed literally so they do not become extra active markers.
Compare publisher input to the saved summary; the publisher has no full report
and cannot add or rewrite missing recommendations.
