# Validation

The target environment is `@opencode/cli@2.0.22`, official
`@azure-devops/mcp@2.9.0`, and Ubuntu 22.04. This is a V2-only repository.
Validate the installed package, actual binary, MCP process, resolved dependencies,
permissions, and model services separately; a package label or passing mock suite
is not a live compatibility certificate.

The initial rewrite was tested on Ubuntu 20.04. On 2026-10-04, installer
regressions and installed-package host fixtures also passed on Ubuntu 22.04.5
with Node.js 22.23.3 and OpenCode 2.0.22. No live Azure/model review or PR publication
is implied by the source audit or offline checks. Record any later host smoke
result with its exact scope instead of promoting it to full service acceptance.

## 2026-10-06 direct comment commands and planning diagnostics

A retained real COMPLETE review had three confirmed medium findings, but its
planner returned an unexplained empty INCOMPLETE response after 38 successful
read operations, including 35 empty comment collections. No publisher started.
Confusion about historical empty threads is plausible, not a proven account of
the model's decision; the original response contained no reason.

The updated shared guidance distinguishes complete empty collections and explicit
deletions from omitted summary fields, incomplete pagination and unavailable
non-deleted comment bodies. An optional planner reason is exposed locally without
becoming a new eligibility field or a published comment. Missing/non-text reasons
do not invalidate an otherwise usable READY plan. No Azure tool/schema classifier
or automatic model retry was introduced.

`/pr-comment --publish` now plans and publishes in one explicitly requested
workflow when no saved preview exists; preview remains optional. The ID may be
omitted in the originating conversation, and the completed report and comment
result sessions can route commands back to that origin. Full and receipt reports
include exact commands. Review retention remains the latest 20 completed reviews
in process memory, with no TTL or restoration from history/diagnostic files.

Syntax checks and 430/430 offline tests passed. The final source's actual OpenCode
2.0.22 fresh/replacement fixtures each passed with 65 loopback provider requests,
13 fixture MCP calls and four one-time host permission approvals. They exercise
direct publication from a report session, exact saved-plan transfer, an explained
planning failure with no publisher, stop-on-publisher-error, and unavailable cache
after restart. Unit tests also cover optional preview, full report commands,
origin isolation, eviction, empty plans, cancellation and explicit replanning.

An initial fixture run reached the new flows but failed an outdated MCP count
assertion (12 instead of 13 after adding a planning-failure case). Its evidence
was retained and the expectation corrected. A later change ensured malformed
optional diagnostic reasons cannot discard usable plans; final fixtures cover
the resulting source. No real model/Azure request, live publication, UI rendering
check, or daily installation is implied by this validation. Live adherence to
the clarified empty-thread policy remains unmeasured.

## 2026-10-05 snapshot argument labels

The next live pair had one successful three-comment delivery, independently
matched and deleted, with six publisher tool calls and no repeated source reads.
Its counted anchor location was restored before preview and matched actual Azure
coordinates. The other profile reversed base/head in both initial reviews and
the verifier, copied base code into its claimed head tests, and produced a valid
empty plan. Fourteen exact-commit reads matched independent bytes; correct bytes
did not prevent incorrect version reasoning. A separate operator metadata read
also failed, and no publication started. Empty plans must not invent findings.

Numbered tool displays now label exact argument-value matches to an already
admitted snapshot as HEAD (PR source) or BASE (PR target reference). The labels
do not certify tool selector semantics, returned content or merge-base ancestry.
Independent initials receive no invented snapshot. No required model field,
model stage, permission rule or completion gate was added.

Syntax and 420/420 offline tests passed. Actual OpenCode 2.0.22 fresh/replacement
fixtures each passed with 63 loopback provider requests, 12 fixture MCP calls
and four one-time host permission approvals. They observe a snapshot label in
the real result hook and preserved planner handoff. Offline display replay of
the failed verifier's six original observations labels three HEAD and three BASE
argument matches without changing raw bytes. This is not a model rerun or proof
that version reasoning is fixed for every future review.

## 2026-10-05 publication batch and original-error diagnostics

A later live pair completed both reviews but failed publication. One publisher
created two of three saved comments before a tool error; independent Azure reads
confirmed those two matched saved text and coordinates, and both were deleted.
The other publisher failed a discussion read before writing. Cancellation replaced
both original tool errors with interruption outcomes in host history. The original
causes cannot be established from those records; a later identical read succeeded,
which does not prove that the first error was transient. All failure records remain
private. Twenty-two individual historical-comment reads and a host model-request
retry also made the first publisher slow; neither proves an Azure service defect.

Publisher input now contains only the saved target, snapshot, language and comments.
Planning retains full review/source context. Mutable PR/discussion checks are
batch-scoped, and immutable anchors can be reused without mandatory source rereads.
Opt-in diagnostics preserve scalar execution errors before interruption. Immediate
grant revocation, publication uncertainty and the prohibition on write retries remain.

Syntax and 416/416 offline tests passed. Actual OpenCode 2.0.22 fresh/replacement
fixtures each passed with 63 loopback provider requests, 12 fixture MCP calls and
four one-time host permission approvals. They verify the reduced publisher payload,
preserved planner observations, original MCP error retention, private receipt
handling and zero subsequent requests after the publisher error. These fixtures
do not establish live model adherence to the batch-read guidance or Azure behavior.

## 2026-10-05 comment-plan extraction and tool registration

The next live round again completed both reviews. One retained an unavailable
initial review and reached preview, but its valid JSON plan was rejected because
following verification notes contained dictionary examples. No publisher started.
The other delivered three comments with exact saved text and source/line-local
coordinates; all were deleted and absence confirmed. The 29 review-stage commit
content reads matched independent reference bytes. Initial tool registration
still lagged connected status and caused unnecessary local troubleshooting.

The subsequent local changes extract one unambiguous strict comment plan and
observe direct-tool registration before inference. Syntax and 404/404 offline
tests passed. Actual OpenCode 2.0.22 fresh and replacement fixtures each passed
with 62 fake-provider requests, 12 fixture MCP calls and four one-time approvals.
The fixtures deliberately withheld tool registration for about half a second;
production readiness observed its return before reviewer inference. They also
exercised a comment plan followed by dictionary-bearing notes without publishing
those notes. Cancellation, permission and publisher-error checks still pass.
An offline replay recovered all three original failed-preview comments with
exact anchors; this neither changes the historical failure nor restores its
publication cache. Live acceptance of these latest changes remains pending.

## 2026-10-05 numbered source-display checks

A subsequent live round produced two COMPLETE reviews. One profile delivered
three comments whose exact text, line ranges and line-local offsets matched the
saved preview on Azure; all three test comments were then deleted and absence
confirmed. The other profile produced a READY preview with an off-by-one line:
the quoted statement was on the next line. Independent pre-publication auditing
withheld that write. The runtime had checked plan structure, not source bytes.
All 40 review-stage exact-commit content reads matched reference Git bytes.
Model base/head confusion, missed defects and overbroad impact claims remained.

The resulting display change adds computed row numbers and adjacent request
arguments to matching plain-text tool responses while preserving raw output.
Syntax and 396/396 offline tests passed. Actual OpenCode 2.0.22 fresh and
replacement fixtures each passed with 62 local fake-provider requests, 12 fixture
MCP calls and four one-time host approvals. The fixtures verify that numbered
text reaches reviewer and planner provider requests. Existing permission,
cancellation and publisher-error revocation cases still pass. These local
results do not yet establish live acceptance of the numbered display or Azure
UI placement. Earlier results below retain their original revision scope.

## 2026-10-05 post-comparison usability checks

Five authorized live cycles exercised one unchanged release: four reviews were
COMPLETE and one retained a useful PARTIAL result. Three previews were rejected
by the provider before any tool call. Another preview incorrectly treated an
explicitly deleted discussion as a duplicate and produced an empty plan; explicit
publication returned NOTHING_TO_POST without a publisher. The last review's new
finding ID spelling prevented preview. No live comment was created or deleted.
All 70 review-stage exact-commit content reads and 16 metadata reads matched independent
reference checks. Correct reads did not prevent model version confusion or
incorrectly reconstructed test source. These samples do not establish stability,
model quality, or inline-coordinate/UI acceptance.

Subsequent local changes assign tracking IDs to new verifier findings, clarify
deleted-discussion semantics, and let comment roles inherit host project-tool
permissions. Syntax and 392/392 offline tests passed. Actual OpenCode 2.0.22 fresh
and replacement fixtures each passed with 62 loopback fake-provider requests,
12 fixture MCP calls, and four one-time host shell approvals. Comment-stage
execution, inherited asks/denials and publisher error revocation were exercised.
The first offline run retained one stale prompt assertion failure before its
correction. An offline replay of the last raw verifier output now passes the
COMPLETE contract without changing evidence or original decisions; this does not
change that historical run, recreate its cache, or verify live publication.

No additional live model review or publication tested these post-comparison
changes. Cold MCP tool-registration timing remains unresolved; see
[startup diagnostics](DEBUGGING.md#connected-mcp-before-tool-registration).

## 2026-10-05 remote-source guidance and provider diagnostics

Syntax checks and 389/389 offline tests passed on Ubuntu 22.04.5 / Node 22.23.3.
Actual OpenCode 2.0.22 fresh and replacement fixtures both passed, each with 56
loopback fake-provider requests and 12 fixture MCP calls. A new rejected-preview
case checks that an HTTP 403 is reported without leaking provider text, no repair
or fallback request starts, publication remains blocked without a saved plan,
and a later explicitly requested preview can reuse the COMPLETE review. Existing
permission, cancellation and publisher-error checks still pass.

Three harmless live admission probes used the existing selected comment-plan
model and production role/system, with all tool execution blocked. Each sent one
primary request after checking current model capability and zero catalog pricing.
The results were deny/403, ask/success, deny/403. The first probe ran while MCP
discovery was still settling and cannot isolate shell. In the last two probes,
the input, system and model matched, and the exposed tool catalogs differed only
by shell. Neither executed a tool. This is evidence of provider admission
sensitivity to role permissions/tool exposure, not proof of the provider's
internal classifier or general compatibility. Production denials were preserved.
Current catalog pricing is not a billing audit or a promise of future free use.

The review guidance now starts from MCP source without requiring local Git or a
clone. Optional experiments may materialize needed retrieved files with version
provenance. Source discovery follows operation-specific selector semantics and
avoids speculative argument variations after deterministic errors. The shared
quality guidance was consolidated around factual scope and coherent fixes; an
obsolete isolated-execution restriction was removed. No new fields, model rounds,
completion gate or tool-name classifier was added. These instruction changes
have not yet been measured in another real PR review.

One diagnostic startup failed before inference because its command was not yet
registered; the diagnostic runner now waits for registration. One focused test
initially used an inconsistent mock success outcome for a provider error; the
fixture now represents the host's failed terminal state. Three full-suite failures
were stale literal prompt assertions. All original failures and corrected results
remain private. The task changed no daily installation, private profile, PR
comments or source sandboxes, and ran no full live PR review or publication.

## 2026-10-05 native project verification acceptance

The custom isolated executor and its configuration have been removed. Syntax
checks and 386/386 offline tests passed on Ubuntu 22.04.5 / Node 22.23.3, with no
skips. Retired isolation tests were replaced by native-role, admission/model,
expiry and publisher-denial regressions. Installation tests reject the removed
settings, preserve private profiles and check the reduced manual-copy package.

Actual OpenCode 2.0.22 fresh and replacement fixtures both passed, each with 55
local fake-provider requests and 12 fixture MCP calls. All three review roles
executed real commands in the origin project, and a second project required no
repository mapping. Three shell approval requests paused execution until approved;
host denial prevented marker creation. A nonzero test exit still allowed a valid
COMPLETE result to enter same-origin preview. Cancellation cleared pending
approvals, rejected late approval, and stopped a real foreground command. Native
source-only denials, publisher-error revocation, ordinary auxiliary behavior and
private-role rejection after host restart remained effective.

Four initial offline failures were stale installer/prompt assertions. One initial
host run invoked review in the second project before its fixture MCP connected;
the fixture now waits for that project's startup. Original failure logs remain
private. No service-specific product retry was introduced.

These are local contract and actual-host fixture results, not real model/Azure
acceptance or TUI approval/rendering verification. No daily installation, private
settings, source sandbox or real PR comments were changed. Shell uses host authority;
these results do not certify isolation, arbitrary detached-process cleanup or
absence of command side effects. Historical custom-executor results below apply
only to their recorded revisions.

## 2026-10-05 configuration cleanup and live acceptance

Syntax checks and 390/390 offline tests passed on Ubuntu 22.04.5 with Node
22.23.3, with no skips. Tests cover twelve eligible comments reaching the complete
saved preview and explicit fixture publication, empty previews starting no
publisher, rejected obsolete settings without installation changes, and invalid
standalone readiness output retaining its failure without a repair request.
Same-origin grants, cancellation, auxiliary restrictions and immediate publisher
revocation after tool errors remain covered. Three initial installer-test failures
were stale role-count expectations after removing the publication config switch;
the corrected full run passed. All failure evidence is retained privately.

Fresh and replacement installations passed with the actual OpenCode 2.0.22
binary, each using 41 local fake-provider requests and 13 fixture MCP calls.
These fixtures include real isolated command execution and cleanup. They do not
establish real Azure publication or provider behavior.

One newly authorized live review then finished COMPLETE in 421 seconds. One
initial stream ended without a finish reason; the host inserted a synthetic
continuation, and the plugin correctly rejected the changed context. That
initial's output was not accepted. The sibling completed and the existing
verifier independently reread source and rechecked PR versions. All three
admitted original finding IDs were adjudicated, covering the three seeded defects.
The incomplete initial remains disclosed instead of becoming a second delivery
gate. No additional plugin output-repair round was started.

Independent auditing matched 16/16 exact-commit content reads to Git and 3/3 PR
metadata reads to unchanged snapshots. Four directory errors remain: the pinned
official MCP maps Commit directory selectors to Branch. Content reads were
audited separately; no server patch or tool-name special case was added. Initial
reviewers chose four isolated commands, including actual head/base test suites:
head had three failures among 23 tests, while base passed all 23. All commands
settled and cleaned up. Shell pipelines masked test failures in their exit codes,
so the test results above come from unittest output, not shell exit alone.

The main findings and overview are Traditional Chinese. Model content quality
remains PARTIAL independently of the COMPLETE workflow: the verifier incorrectly
describes initial-reviewer test execution as its own, one suggested test already
exists, and some correction wording is ambiguous. Original output, tool records,
failure analysis and quality assessment remain private and unchanged. No new
formatting gate, model round or prompt workaround was added for these limitations.

The daily installation was not updated in this cleanup task. An isolated install
used the current source and a private profile with only retired settings removed
and debug output redirected. Private model choices, host configuration and PAT
were preserved. No real comment preview/publication ran; all existing Azure thread
contents remained unchanged. Corrected inline coordinates and UI placement still
need a separately authorized real publication opportunity.

## 2026-10-04 isolated verification acceptance (historical)

This tested the former custom executor, since replaced by native project tools.
It does not certify the current execution behavior.

The isolated-verification working tree passed syntax checks and 387/387 tests on
Ubuntu 22.04.5 with Node 22.23.3. Real namespace tests used trusted, disposable
Node/Python toolchains and local fixture repositories. They checked exact committed
blobs despite a dirty worktree and export attributes, symlink containment, immutable
source, disposable edits, empty credential environment, inaccessible host files and
supervisor descriptors, local test networking, denied host/external networking and
VSOCK, dropped capabilities, seccomp, nonzero exits, output truncation, unavailable
environments, cancellation and detached-process cleanup.

Fresh and replacement installations passed against the actual OpenCode 2.0.22
binary. Each used 41 deterministic local fake-provider requests and 13 fixture MCP
calls. The added workflow executed model-selected commands through the installed
V2 tool, retained a nonzero test exit without losing COMPLETE or same-origin preview,
and cancelled a real sandbox process plus its detached child. Native permission,
publisher-error, auxiliary-model and host-restart checks still passed. Offline
runtime tests also check direct-call/admission/model guards and immediate publisher
grant revocation after a denied verification attempt.

These are offline/fixture execution results. No live model, official Azure MCP
service call, PR comment write, daily installation update or real project review
was performed for this feature. The new GitHub CI result is not established by
local tests. Other rootfs contents, languages, kernels, architectures and provider
schemas remained unvalidated. Historical resource limitations and failure records
are preserved with that revision; [verification](VERIFICATION.md) describes the
replacement behavior.

## Offline checks

Run from the repository root with Node.js 22 or later and Python 3:

```sh
npm run check
npm test
git diff --check
```

No npm install, Python package installation, model request, or Azure connection
is required for the repository tests. Installer tests use disposable configuration
directories. Record the actual result and count from the run; do not carry counts
forward from another repository or revision.

| Area | Required checks |
| --- | --- |
| V2 plugin and commands | Default definition and setup registration, native command invocation, literal text, rejected attachments/mentions, registration cleanup. |
| Session transport | Independent session identity and model binding, exact prompt admission, idle settlement, final-context correlation, successful text finish, compaction/mutation refusal. |
| Permissions and grants | Private role/model fingerprints, active command grants, role-specific native denials, ordinary-agent preservation, permission inheritance, expiry and cancellation. |
| Review orchestration | Two concurrent initial reviews, continuation with partial/unavailable inputs, independent verifier, visible frame conflicts and omitted decisions, COMPLETE-to-preview availability. |
| Output contracts | Local syntax/key/shape recovery, literal retention of ambiguous/prose output, no silent duplicate-key overwrite or lost findings, readable partial/stale reports, strict settings/checks/comments. |
| Comments | COMPLETE-to-preview after partial/unavailable initials, preserved warnings, same-origin scope, exact saved preview, explicit opt-in/publication, model attribution, uncertain-attempt lockout. |
| Diagnostics | Private output handling, original response and correction records, value-free observations, timing uncertainty, safe path/write behavior. |
| Installation | V2 package discovery layout, complete manual file list, preserved current settings, old-layout conflicts, rollback/recovery, archival removal, unrelated-file preservation. |
| Project verification | Inherited location/permissions, host allow/ask/deny behavior, model-chosen methods, nonzero/unavailable results, cancellation, active-grant enforcement and usable COMPLETE/preview delivery. No plugin isolation claim. |

Check source-only installation without touching an actual configuration:

```sh
azpr_test_root=$(mktemp -d)
sh install.sh --config-dir "$azpr_test_root/config"
sh install.sh --config-dir "$azpr_test_root/config" --replace
sh uninstall.sh --config-dir "$azpr_test_root/config"
```

The default example still contains generic model placeholders. Successful file
installation does not mean the plugin can start a review with those settings.
For an installation test, compare the eight JavaScript modules and nine prompts to source,
check the generated regular `server.js` entry and matching `package.json` export, and verify owner-only settings
permissions. No top-level loader or Markdown command files should be created.
The installer must reject a conflicting older integration without moving it.

## Exact-host checks without live models

The optional SDK/transport smoke fixture runs only when explicitly invoked:

```sh
node tests/host-v2-smoke.mjs /absolute/path/to/opencode-v2-binary
node tests/host-v2-smoke.mjs /absolute/path/to/opencode-v2-binary --replace
```

It creates private evidence under `.local/`, isolates host state, and uses a
loopback fake provider plus local fixture MCP. It is separate from `npm test`;
CI installs the pinned host in a disposable prefix and runs both installation modes.
The original Ubuntu 20.04 fixture copied source behind a top-level loader. It
validated runtime behavior but missed directory discovery: exports alone did
not load the installed package. That historical success was not installer proof.

On 2026-10-04, both fresh and replacement installations passed against the actual
2.0.22 binary on Ubuntu 22.04.5, each with 17 deterministic loopback provider
requests and exactly five fixture MCP reads. The fixture now invokes `install.sh`
and loads the installed package and session helpers. Replacement simulates the
previous exports-only layout and checks that private settings remain byte-identical.
With the old installer, the updated fixture failed at command discovery before
any provider request. Offline regressions also cover replacement of the temporary
entry symlink, rollback and archival uninstall. Those initial installed fixtures checked:

- Discovery of all five native commands and five enabled private roles.
- Native registration, exact literal prompt/context correlation, final text,
  idle interrupt/wait, and synthetic report queue acknowledgement.
- `/pr-check` READY and `/pr-review` COMPLETE with both independent initials,
  the verifier, and complete F-1/R-1 adjudication.
- A harmless ordinary-agent shell positive control that created its marker.
  Private review shell and `execute` each received two distinct forced attempts,
  stopped as INCOMPLETE, and disclosed `blocked-native-tools=2`. No private shell
  marker was created and the forbidden CodeMode fetch endpoint received no call.
- A hanging fixture request cancelled through `/pr-stop`, producing CANCELLED
  without restarting the workflow.

API inspection confirmed that the queued report description retained its full
text. It did not exercise actual TUI rendering. All spawned processes stopped;
private evidence from successful and failed fixture attempts was retained.
The stability regression extends each fixture to 21 loopback provider requests:
ordinary generation/compaction positive controls still work, while generation
and compaction on a revoked private session send zero requests, before and after
a host restart. Offline fault injection also checks cancellation during catalog
reads, origin-lock release, unavailable models and disconnected MCP servers.
This is exact-host integration evidence with deterministic fixtures. It does not
certify official MCP 2.9.0 connectivity, real model quality, Azure source fidelity,
or PR publication.

The 2026-10-04 comment-usability follow-up passed 371/371 offline tests and syntax
checks. Fresh and replacement installations on OpenCode 2.0.22/Ubuntu 22.04.5 each
passed with 29 loopback provider requests and nine fixture MCP reads. These
fixtures cover an initial coverage disclosure, a final JSON fence preceded by a
dictionary example, and COMPLETE followed by a same-origin `/pr-comment` PREVIEW.
Native permission, auxiliary-request, restart and cancellation controls still pass.

Two preserved live response sets were also replayed through the updated runtime
without external requests. A COMPLETE review previously blocked by initial gaps
now reaches preview; a PARTIAL result caused by surrounding dictionary braces now
parses as COMPLETE and reaches preview. The planner was deterministic and local:
this verifies the cache/preview path, not live source anchors or Azure publication.
The third recorded failure involved interrupted/failed sessions; its cause remains
unestablished. New terminal-state and clock diagnostics help investigation but do
not prove recovery. This follow-up made no new live review or publication request.

The subsequent publication-failure regression passed 375/375 offline tests and
syntax checks. Fresh and replacement 2.0.22 fixtures each passed with 30 loopback
provider requests and ten fixture MCP calls. The fake publisher would retry a
tool failure if allowed; the runtime now revokes its grants after the first error,
with zero subsequent model requests or tool attempts. The saved publisher payload
also contains line-local offsets derived from the existing anchor. This tests
failure containment and payload construction, not correct live Azure rendering.

Before using real services, exercise the actual V2 binary in a separate temporary
home/config/data/state/cache environment and a trusted fixture project. Keep the
ordinary user's environment and installation unchanged. Use the official package
version requested for validation; record the package version, binary version,
source revision, OS release, architecture, and relevant runtime versions.

A headless smoke test should establish package discovery, setup, native command
registration, agent compilation, command argument delivery, and unload cleanup.
A local fake model provider and fake MCP server can exercise full workflows
without contacting paid models or Azure. They must remain separate from real
credentials and use harmless fixture data.

For the exact target, relevant isolation controls include `OPENCODE_CONFIG_DIR`,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, and
`OPENCODE_TEST_HOME`. Disabling project config, model catalog fetching, watchers,
and optional indexing avoids unrelated environment activity in a disposable
smoke harness. Verify these switches against the exact binary/source before
using them. Changing only the installer `--config-dir` is not host isolation.

Test these native permission cases with the unmodified integration:

1. Initial reviewers and the verifier use shell/read/search in the origin's
   project. Verify two project locations without any repository mapping.
2. Host shell allow/ask/deny decisions remain effective. An ask must pause before
   execution, then run only after approval. Exercise both comment stages too;
   standalone readiness still blocks shell. All private roles block edit/write/patch, delegation, native web and
   CodeMode `execute`. Force calls as well as inspecting schemas.
3. The second distinct blocked native attempt in a stage revokes the run. The
   receipt/debug record discloses the prevented attempts without arguments.
4. MCP is exposed directly with `codemode: false`; host/account permission rules
   remain effective. Do not add an MCP wildcard grant just to pass the fixture.
5. Ordinary development agents and their settings behave as before. Private
   roles cannot be invoked through normal agent selection or delegation.
6. Cancellation revokes grants before cleanup. Delayed prompt admission, ignored
   AbortSignals, failed interrupt, and delayed settlement must not produce a
   falsely confirmed cancellation or a publishable completed review.
7. A synthetic report with `resume: false` starts no presentation model request.
   Verify visibility separately from queue acknowledgement.
8. Compaction removing the exact input, injected context, model/agent switching,
   and non-success terminal responses fail closed. Active context is not a full
   history API; do not weaken correlation to complete a large fixture.
9. Private auxiliary requests are rejected at `model.request`, including after
   completion and restart. Ordinary generation/compaction must have positive
   controls so a disconnected provider cannot masquerade as successful denial.
10. Pending command/agent/model/MCP catalog reads remain cancellable. No reviewer
    may start from a late result after cancellation or plugin disposal; an origin
    lock must not remain held by a read-only SDK promise that ignored cancellation.

CodeMode denial is necessary because the pinned runtime exposes a `fetch` global
outside ordinary web-tool permission checks. Inner tool hooks alone cannot make
that container safe for private reviewers. CodeMode-only resource helpers are
unavailable; validate that missing direct evidence remains a disclosed gap.
See [MCP setup](AZURE_MCP.md).

These checks establish only the behavior observed in that host fixture. A fake
provider cannot establish real provider schema acceptance, quotas, cost, model
accuracy, Azure authentication, or MCP response fidelity.

## 2026-10-04 stability acceptance (before review-tolerance changes)

The final local suite passed 311/311 offline tests, syntax checks and diff checks.
Fresh and replacement exact-host fixtures each passed with 21 loopback provider
requests, five fixture MCP reads, ordinary auxiliary positive controls, and
private generation/compaction denial before and after restart. The CI workflow
included these fixtures. Subsequent [CI for the committed stability change](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/actions/runs/37152458289)
passed; that historical run does not cover the later review-tolerance changes.

A separately authorized live test used OpenCode 2.0.22, official MCP 2.9.0 with
resolved Azure SDK 15.1.3, Ubuntu 22.04.5 and the existing three selected models.
Three whole-review attempts were made under a maximum-five authorization:

| Attempt | Outcome | Evidence and correction |
| --- | --- | --- |
| 1 | INCOMPLETE, about 5 seconds | Provider HTTP 403 before any tool call. The isolated profile changed the existing shell option from deny to ask while preserving the execution guard; see DEBUGGING. |
| 2 | INCOMPLETE, about 130 seconds | Initials used the same PR/SHAs but different project name/ID labels. The ambiguous common rule and examples were replaced with explicit stable project/repository IDs. Strict comparison remained unchanged. |
| 3 | COMPLETE, about 421 seconds | All three seeded defect classes found; all six original finding IDs adjudicated. |

In the completed attempt, all 19 content reads exactly matched the requested Git
commit bytes and all four review metadata reads matched the independently checked
PR identity/versions. Raw initial output, verifier handoff, accepted final output
and deterministic rendering agreed. There were 17 observed HTTP responses, all
200; zero native attempts, output corrections or amendment stages. The three
retained tool errors were unsupported directory lookups, not content-read or
Code Search failures. Earlier attempts retain their different error categories.

Execution acceptance passed; overall model/tool-policy quality remains PARTIAL.
The final equal-instant explanation was correct and did not repeat earlier
permanence overclaims. However, the overview repeated structured decisions, an
exclusive caller claim exceeded the verifier's own reads, and the last metadata
read ran alongside an additional supporting-file read rather than after all reads.
An independent post-run check found unchanged versions. The model also repeated
unsupported directory queries despite the existing policy. These limitations
were retained without extra model rounds, special cases or relaxed validation.

All raw successes/failures and assessments remain private under `.local/`. The
installed personal settings and credentials stayed byte-identical; the acceptance
profile used ask only in an isolated installation. Both sandbox repositories were
unchanged, test servers stopped, and PR threads remained zero. No PR publication,
paid-model substitution, host/MCP upgrade, large-PR certification or TUI rendering
certification is implied by this result.

## 2026-10-04 review-tolerance acceptance

The final local suite passed 350/350 offline tests and syntax checks. Fresh and
replacement fixtures passed on the exact 2.0.22 host, each with 27 loopback
provider requests and eight fixture MCP reads. The added cases exercise a
redundant JSON closing brace and entirely unstructured initial/final review
text. PARTIAL reports retain both stages' observations and omitted original IDs
without a formatting model request. Existing native denial, cancellation,
ordinary-agent and revoked/restarted private-session controls still pass.

Offline regressions cover punctuation and quoting recovery, duplicate-key
ambiguity, extra fields, missing evidence, repeated IDs, conflicting snapshots,
omitted decisions, and readable stale/partial results. They also reproduce and
fix three content-delivery bugs: non-text snapshot paths being silently removed,
incomplete confirmations hiding original observations, and a null legacy
`verifiedFinding` crashing report rendering. JSON examples inside prose and
commentary outside a review fence remain visible. Original failed checks are
retained privately.

A retained real response with one redundant final `}` was replayed read-only.
All three findings and their supplied values were recovered unchanged, without
another model request. Seven retained responses were also replayed: six yielded
review content, while a genuine provider-error response remained an execution
failure. These replays establish local recovery for those samples, not a measured
failure-rate reduction across providers or arbitrary malformed output.

A new maximum-five authorization used three whole live reviews, preserving the
existing model choices and checking their advertised zero rates before each run:

| Attempt | Outcome | Scope |
| --- | --- | --- |
| 1 | COMPLETE, about 1,056 seconds | Successful development snapshot; content-retention fixes were added while it ran. |
| 2 | COMPLETE, about 390 seconds | A risk reviewer stopped with only a progress statement. That PARTIAL input reached the verifier, which still verified all three defect classes. Publication eligibility stayed disabled. A separate null-rendering regression was fixed while this run was active. |
| 3 | COMPLETE, about 420 seconds | Final source and isolated installed files matched exactly; all three seeded defect classes found and all six original IDs adjudicated. |

The final run had 15 Commit-selected content reads, all byte-identical to the
requested Git versions, plus one Branch-selected test-file read whose bytes
matched both PR commits. That branch request was not an exact-commit read or an
identical retry of the earlier failure. The verifier independently read the test
file at the exact head SHA. All four metadata reads matched independent PR
snapshots; versions stayed unchanged. Raw answers, normalized results, verifier
handoff and rendered report agreed. All 16 observed provider responses were HTTP
200, with zero native attempts, output corrections or extra amendment stages.

Eight final-run tool errors remain: five Commit-selector directory queries,
two explicit missing-path content queries, and one generic test-file content
error. Their causes must not be collapsed into one MCP failure. The second run
separately retained one denied shell attempt (`executed: false`); a successful
workflow does not erase that attempted policy violation.

Review delivery and execution acceptance passed; model/tool-policy and
presentation quality remains PARTIAL. The final report still overgeneralized
caller compensation from the changed-file list and repeated findings in its
overview. An initial reviewer disclosed its branch fallback yet also claimed all
head reads used the exact SHA. Earlier samples retained a wrong equal-instant
example and an unsupported permanence claim, with counterexamples kept privately.
These limits were accepted without further model rounds or new prompt rules.

All three runs left PR threads at zero, preserved the sandbox repositories and
private settings, and stopped their test servers. The personal plugin installation
was not replaced; tests used isolated installations. No publication, paid model,
tool upgrade, broad compatibility or large-PR certification is implied.

## Later review/comment trial

Two separately authorized live reviews on the same target environment returned
COMPLETE. The first created three inline threads: independent Azure reads matched
their saved bodies and file/line ranges, but the publisher used cumulative file
offsets instead of line-local character positions. It also retried after an MCP
parameter-validation error despite the stop instruction. The original threads
and failed call remain recorded; this is PARTIAL publication-quality acceptance.

The subsequent correction derives offsets from the saved anchor and revokes the
publisher on any observed tool error, as covered by the 375-test/fault-injection
checks above. A second live review completed, its preview skipped all three
existing discussions and one low-severity finding, and publication returned
NOTHING_TO_POST without starting a publisher. This proves continued review and
duplicate handling; it does not validate corrected coordinates on a new Azure
create. Existing comments were not rewritten or duplicated. Factual review
quality still has recorded recovery/scope overclaims and remains PARTIAL.

## Authorized environment acceptance

Use a separately authorized test repository and PR with known expected findings
and clean controls. Keep the answer key outside reviewer-visible source and
instructions. Do not silently change personal model choices, host permissions,
MCP versions, server code, or the PR to make a run pass.

Before a live run, record privately:

- Exact OpenCode/MCP versions, MCP executable or package path, resolved Azure SDK
  and Node versions, OS release, and source/installed-file correspondence.
- The role models and relevant AZPR settings, with no credentials in artifacts
  intended for publication. Both normal and deep profiles need explicit choices.
- The existing host MCP configuration and permission semantics, including direct
  tool exposure through `codemode: false`; do not publish full host configuration.
- PR/repository identity, source and target SHAs, expected changed paths, seed
  defects, clean controls, and PR thread count before the run.
- The specific authorized operation: readiness check, review, preview, or actual
  publication. One operation is not standing authorization for the others.

An optional `/pr-check` verifies source readiness under its own policy. Normal
`/pr-review` and `/pr-deep` start their independent initial reviews directly and
do not inherit that check as proof or a source cache. Use a literal Azure PR URL
and text context. A small successful PR does not certify a large-company PR or
all models.

For the review itself, retain original model outputs, parsing/correction records,
verifier payload, final result, and rendered report. Independently compare actual
source reads with the designated repository/path/commit content; metadata and
completed tool states alone do not prove correct bytes. Check each initial
coverage ledger, the verifier's union of paths, all original finding IDs, exact
final locations, counterevidence, and both completion-time version reads.

Classify observed errors individually. A Commit-selector directory error, a
content-read failure, and a Code Search HTTP 400 use different operation paths.
Preserve an error followed by a successful identical read and disclose the
recovery; success does not prove a transient cause. For MCP 2.9.0, specifically
check PR-change pagination, branch-only directory hints, indexed search versions,
and the exact content selector. See the audited [MCP limitations](AZURE_MCP.md).

Audit authorized native commands, tested checkouts, their side effects and
cancellation separately from forbidden attempts or unexpected publication. Record any
prevented attempts, output corrections, amendment request, provider error, or
uncertain cleanup. Confirm PR version/thread state after testing through an
independent read. Stop test servers and preserve source, private settings, and
failed evidence. Never retry an uncertain publication automatically.

## Report-quality acceptance cases

Assess execution integrity, factual quality, and presentation separately. A
COMPLETE status means the final verifier passed its evidence/version checks and
the review can enter same-origin comment preview; it does not approve the PR or
prove factual perfection. PARTIAL retains results with incomplete final checks;
assess review content separately from parser recovery and comment readiness.
Define expected outcomes before changing prompts; inspect existing raw evidence
before adding instructions when an existing rule was ignored.

| Case | Acceptance criterion |
| --- | --- |
| Reachable defect and clean control | Identify independently known defects; reject guarded, equivalent, or clean changes without inventing an issue. |
| Numeric state and delta | Distinguish the final value, each operation's change, and total deviation using the actual trace. |
| Static test analysis | Identify the first predicted failing assertion; never describe unexecuted later assertions as observed failures. |
| Exact evidence and scope | Keep quotes exact, locations correct, and absence claims limited to inspected paths/versions. A branch listing is not commit-tree proof. |
| Permanence and recovery | Support permanent impact or recovery instructions with explicit evidence; disclose unknown restoration behavior or deployment scope. |
| Equal instants across time zones | Recognize equivalent timestamps as the same instant; distinguish ordering of instants from order-preservation of equal-key records. |
| Cross-file contracts | Read and verify changed call paths and supporting contracts at relevant versions, including contradictory guards. |
| Severity | Explain concrete affected state, authority, reachability, and recovery; a keyword or fixture label is insufficient. |
| Complete, concise presentation | Render one full evidence packet per confirmed issue, preserve distinct supported impacts, and adjudicate every original ID without duplicating the report in the overview. |
| Language and attribution | Apply outputLanguage to final human-facing prose, preserve source/identifiers, and retain the required AI/model disclosure. |

For each case, record pass, fail, or not exercised with the original claim,
supporting evidence or counterexample, and practical impact. Unsupported
permanence, incorrect equal-instant reasoning, and repeated summaries remain
quality failures even when execution passed. Keep factual errors distinct from
presentation defects and preserve failed samples when comparing revisions.

A publication test additionally requires an exact saved preview, explicit
A saved preview, explicit `--publish`, same-origin/process state, correct
threads/locations/body/disclosure, and independently inspected Azure results.
`MODEL_REPORTED_POSTED` is not independent publication verification. Review
validation does not authorize this write operation.

## Release evidence and remaining limits

A release report should identify what was run, what passed, what failed, and what
was not exercised. Keep these categories distinct:

- Offline contract tests and source/package audit.
- Exact-host discovery and fake-service workflows.
- Ubuntu 22.04 environment acceptance.
- Live MCP/provider execution and independent source/version checks.
- Model factual/presentation quality and, when authorized, publication.

Do not claim the Ubuntu target, large-context behavior, another model, or a newer
host version has passed without its own evidence. The plugin adds no iteration,
stage-character, or default whole-command timeout. Finite explicit timeouts and
manual cancellation remain available. Host compaction, service limits, incomplete
MCP responses, model mistakes, and provider costs remain real constraints.


## Successful host continuation and saved publication text (2026-10-05)

The transport now recognizes the pinned host's missing-finish text continuation
for initial/final reviews, preserving raw fragments and requiring a successful
final session plus ordinary review validation. A captured failed verifier
replays as COMPLETE offline after joining its literal text fragments; the
historical live result remains INCOMPLETE. Other interruption and identity
checks still apply. Comment/check execution keeps its strict path.

Publisher whole-comment strings with a unique saved marker are restored to saved
text through the public input hook. Fixture MCP independently receives the saved
text even when the simulated publisher adds wording; target/coordinate checks
remain distinct, and any publisher tool error still revokes further requests.

Syntax and 408 offline tests pass. Fresh and replacement actual OpenCode 2.0.22
fixtures pass with 12 MCP calls each and 63 loopback provider requests in the
recorded passing runs, including a real host-generated stream continuation. A
cancellation sibling may finish before or after its tool-result response; the
fixture accounts for that one-request race explicitly. Initial receipt-only
warning and fixed-total-count test assertion failures remain in private evidence.
These fixtures establish host integration, not real Azure publication or UI
rendering correctness.


## Captured review text for comments (2026-10-05)

A live COMPLETE review was followed by a zero-tool planner response that invented
three source anchors. Its first seven-line range also hit an arbitrary five-line
limit. No publisher ran. A separate same-release comparison completed review,
posted three exact saved comments and confirmed their deletion. These are
different outcomes; removing the line limit alone would not fix invented source.

Comment roles now receive successful multiline tool observations from their
completed review, including original request arguments and numbered rows. This
reduces source reconstruction from finding prose without a new model request,
source certificate or required-tool gate. The five-line maximum is removed;
positive ordered coordinates and matching anchor line count remain required.

Syntax and 409 offline tests pass. Fresh and replacement OpenCode 2.0.22 fixtures
each pass with 63 local provider requests and 12 fixture MCP calls. They check
that both comment roles receive deduplicated source observations while native
shell output remains excluded. Live model adherence, source-copy correctness
and Azure UI placement remain separate acceptance questions.


## Non-publishable notes and anchor formatting (2026-10-05)

A live free-profile planner produced three exact anchors from captured review
text but also listed four verifier-rejected IDs in skipped notes. Those harmless
notes blocked the plan. A same-release comparison produced correct line numbers
but omitted indentation and over-escaped one anchor's quotes; independent audit
withheld publication. Both historical failures and zero writes are preserved.

Known excluded dispositions can now remain skipped notes without becoming
eligible comments. At unchanged coordinates, a uniquely matching captured range
can restore indentation/quote formatting when its argument values contain the
selected path and HEAD. Ambiguity, other versions/paths and different code remain
untouched. This neither interprets MCP schemas nor certifies source provenance.

Offline replays preserve all three comments from each original plan; the second
replay restores three exact anchors and derives full-line offsets from them. No
model was rerun or historical cache restored. Syntax/413 offline tests pass.
Fresh/replacement OpenCode 2.0.22 fixtures each pass with 63 local provider requests
and 12 MCP calls, exercising rejected-ID notes, saved-anchor restoration and its
publisher input. Live model/Azure delivery still needs its own evidence.


## Counted-location recovery (2026-10-05)

A live free-profile cycle completed review and independently verified three
exact Azure comments, including one six-line anchor restored from captured text
and one publisher body restored to saved text. All three comments were deleted.
The paired comparison completed review but selected line 38 for a quote uniquely
present at line 37; independent audit withheld all publication. Original failures
and successful remote-write evidence remain separate.

Anchor recovery now prefers a matching declared location, or otherwise requires
one unique quoted range in captured text with matching path/HEAD argument values.
It retains original/restored coordinates and does not change claims, select
ambiguous locations or bypass duplicate/attempted-finding policy. Observed-text
matching cannot certify full-file content or provenance.

The original failed plan replays with all three exact anchors after 38 becomes 37;
this does not recreate a cache or run another model. Syntax/415 offline tests and
fresh/replacement OpenCode 2.0.22 fixtures pass (63 local provider requests and 12 MCP
calls each), including actual saved publisher coordinates after line restoration.
