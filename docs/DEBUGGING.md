# Debugging OpenCode V2 reviews

Keep the failed run and inspect its original evidence before changing settings
or starting another model request. The target is `@opencode/cli@2.0.22` with the
official `@azure-devops/mcp@2.9.0`. A passing parser or workflow test does not
establish provider acceptance, Azure source validity, or report quality.

## Enable local diagnostics

Edit the installed `plugins/azpr-v2/settings.json`, keeping the existing model
choices. For example, change these fields in the current settings object:

```json
{
  "debug": { "enabled": true, "directory": "" },
  "returnReport": "full",
  "outputLanguage": "en"
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
| `readiness.json` | Checked role slots and connected MCP count; source access remains unassessed. |
| `NN-azpr-ROLE.request.json` | Stage identity, literal payload, and applicable instructions. |
| `NN-azpr-ROLE.response.json` | Captured visible model response, finish state, and available error data. |
| `NN-azpr-ROLE.result.json` | Validation outcome, finding/output corrections, observations, and timing. |
| `report.md` | Deterministically rendered report when available. |
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

## Session completion and context limits

V2 prompt admission is asynchronous. The adapter admits one exact literal prompt,
waits for session settlement, reads active context, and verifies that the final
assistant response belongs to that prompt. It accepts only a successful session
ending in a complete text response with `finish: "stop"`. A tool-call turn,
interrupted session, provider error, filtered/length finish, or mismatched context
is not a complete review.

The V2 context API returns active context after compaction, not an unlimited
transcript. If the exact admitted prompt disappears or becomes ambiguous, the
adapter refuses the answer. It does not infer identity from a compaction summary
or accept a nearby assistant message. This is a remaining large-context limit
without a plugin iteration or character budget.

Private compaction now fails at the V2 model-request boundary before any summary
request is sent. Transient `session.generate` and title requests are also denied
for private reviewers. A missing exact input remains a failure even if a later
host or plugin changes compaction behavior. Ordinary sessions are unaffected.

Review inputs come from native command `prompt.text`. They remain literal text;
there is no Markdown command template or placeholder sentinel. Attached files,
agent mentions, and skills are rejected for these commands. Reviewers cannot be
resumed with an ordinary prompt after their grant expires.

## Output and report presentation

V2 uses JSON text only. `structuredOutput` is not a setting and there is no native
StructuredOutput fallback. An ordinary response must be one JSON object, optionally
inside one JSON fence, with the complete role contract. Duplicate keys, including
escaped equivalents, fail before field values are accepted. A response containing
only `status` cannot supply omitted evidence, coverage, or dispositions.

Normal initial/verifier output can receive narrowly defined local corrections:
ASCII whitespace around recognized finding keys; removal of exactly empty/null
unknown finding fields; one redundant matching V disposition; and trailing JSON
commas after complete members/values. Complete validation remains mandatory.
Content-bearing extra fields, key collisions, invented values, and generic JSON
repair are not permitted. Checks, comments, and amendments do not receive the
trailing-comma tolerance.

`outputFormatCorrections` records accepted changes. Trailing-comma offsets are
zero-based UTF-16 offsets within the selected JSON body. The original response
is retained. `rejectedOutputFormatCorrections` means a locally normalized candidate
still failed validation; it cannot unlock another model request. An initial
finding can omit only its separate location under the existing coverage rules;
`pendingLocations` carries that unresolved work to the verifier. Final confirmed
findings still require exact locations.

The final report renders validated findings and dispositions once. Its model
`report` field should be a short overview of checks, exclusions, and limitations.
Check separately for unsupported claims about permanence, recovery, ordering,
and business impact; JSON validation cannot establish those facts. Equivalent
inputs and explicit counterexamples help expose factual errors that a successful
run status does not reveal.

`returnReport` changes the returned receipt/full report, not source collection or
review models. Reports are queued through V2 synthetic input with `resume: false`.
That operation requests no formatting model call. Queue acknowledgement does not
prove that every host interface displayed the entire report. Use the saved report
or inspect the existing session without prompting it again. Model output can
also become context for a later, separately requested ordinary conversation.

## Bounded output amendments

`outputRetries` defaults to `0`. Explicit `1` permits one eligible amendment per
stage, shared between these alternatives:

- A status-only spelling amendment in a fresh session using the same model.
- Missing final locations supplied from the stopped verifier's retained context.
- Missing MERGED dispositions for original IDs, pointing only to existing
  confirmed originals and supported by the verifier's retained evidence.
- One complete final-content resubmission when a parsed COMPLETE verifier result
  failed validation but its identity, path set, and observed current versions
  match the expected PR and remain frozen.

Narrow amendments require every other applicable contract to pass. All recovery
requires active authorization, a completed tool observation, and confirmed
session settlement. The adapter replaces only the authorized repair instructions,
removes tools for that request, enforces one model request, preserves the original
failure, and validates the complete result again. It never fills missing content
from another reviewer or guesses a disposition from prose.

No recovery chains, new source reads, deadline reset, initial full-review
regeneration, comment retry, provider-error retry, or recovery after unconfirmed
cancellation are allowed. Inspect `attempt`, `retryOf`, `retryKind`, the original
failure, and both submissions. Model-authored resubmission is extra usage and
changed content, not independent proof of correctness.

## Tool observations and permissions

Private roles block V2 `execute`, shell, editing, delegation, and other restricted
native tools. `shellToolPermission: "ask"` retains that permission choice while
the runtime still blocks shell execution. It does not enable CodeMode. Set the
MCP connection to `codemode: false` so reviewers can use direct MCP tools. See
[the CodeMode boundary and MCP limitations](AZURE_MCP.md).

A forbidden native attempt is prevented before execution. Two distinct blocked
attempts in a stage stop the run. These observations must remain visible even
when no forbidden operation executed. They are different from MCP tool failures
and provider rejection before any tool request.

An authorized 2.0.22 live test received a provider HTTP 403 before any tool call
with `shellToolPermission: "deny"`. The same selected models were admitted after
using the existing `"ask"` option in an isolated test profile; the runtime guard
still blocked shell execution and the installed personal settings stayed intact.
This matches [upstream reports about permission-dependent free-tier rejection](https://github.com/anomalyco/opencode/issues/51241).
It is a provider admission limitation, not an Azure authentication failure or
proof that shell ran. Inspect the original error before changing permissions;
never change models, spoof client headers, or grant native execution to recover.

If initial snapshots disagree, inspect the original metadata and labels before
retrying. The common label uses `organization/project-id/repository-id`, with
both stable IDs from the same PR metadata response. Project display names and
project IDs are not interchangeable strings in this contract. The runtime keeps
strict identity/commit comparison and does not guess or normalize equivalence.

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

## Timing, cancellation, and large output

`requestObservations` separates primary, compaction, generate, title and unknown
request-kind hooks, authorized primary preparations, rejections, and host retry
proposals. It records no request bodies, headers or provider error text. These
are observations of hooks, not a count of network requests or billed usage.
Normal review retains the host's retry decision. Revoked grants and output
amendments do not receive host retries; no new retry policy is added.

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
