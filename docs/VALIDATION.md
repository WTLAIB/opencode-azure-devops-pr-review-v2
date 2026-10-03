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
| Permissions and grants | Private role/model fingerprints, active command grants, blocked native execution, ordinary-agent preservation, permission inheritance, expiry and cancellation. |
| Review orchestration | Two concurrent initial reviews, continuation with partial/unavailable inputs, independent verifier, visible frame conflicts and omitted decisions, separate publication eligibility. |
| Output contracts | Local syntax/key/shape recovery, literal retention of ambiguous/prose output, no silent duplicate-key overwrite or lost findings, readable partial/stale reports, strict settings/checks/comments. |
| Comments | Same-origin completed review, exact saved preview, explicit opt-in/publication, model attribution, uncertain-attempt lockout. |
| Diagnostics | Private output handling, original response and correction records, value-free observations, timing uncertainty, safe path/write behavior. |
| Installation | V2 package discovery layout, complete manual file list, preserved current settings, old-layout conflicts, rollback/recovery, archival removal, unrelated-file preservation. |

Check source-only installation without touching an actual configuration:

```sh
azpr_test_root=$(mktemp -d)
sh install.sh --config-dir "$azpr_test_root/config"
sh install.sh --config-dir "$azpr_test_root/config" --replace
sh uninstall.sh --config-dir "$azpr_test_root/config"
```

The default example still contains generic model placeholders. Successful file
installation does not mean the plugin can start a review with those settings.
For an installation test, compare the eight modules and nine prompts to source,
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
entry symlink, rollback and archival uninstall. The installed fixture checks:

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

1. Private reviewers cannot run shell, write/edit/patch, delegation, native web,
   or CodeMode `execute`. Force calls as well as inspecting exposed schemas.
   A harmless marker/trace detector must have a separate positive control.
2. `shellToolPermission: "ask"` never allows shell execution, an approval bypass,
   or `execute`. Other native restrictions remain active.
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

Verify no shell/native execution or unexpected publication occurred. Record any
prevented attempts, output corrections, amendment request, provider error, or
uncertain cleanup. Confirm PR version/thread state after testing through an
independent read. Stop test servers and preserve source, private settings, and
failed evidence. Never retry an uncertain publication automatically.

## Report-quality acceptance cases

Assess execution integrity, factual quality, and presentation separately. A
COMPLETE status describes usable structured verifier output, not PR approval or
factual perfection. PARTIAL is a useful delivered result with limitations; assess
review content separately from parser recovery and publication eligibility.
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
`comments.enabled`, explicit `--publish`, same-origin/process state, correct
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
