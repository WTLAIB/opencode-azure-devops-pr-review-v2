# Validation

This page describes the current validation process and the latest recorded
runtime evidence. The target is `@opencode/cli@2.0.22`, official
`@azure-devops/mcp@2.9.0`, and Ubuntu 22.04. Validate host integration, provider
admission, source fidelity, model quality and publication separately.

Earlier counts, retired features, intermediate failures and revision-specific
pending status are preserved in [validation history](VALIDATION_HISTORY.md).
They do not override the current behavior documented in [README](../README.md).
Private raw artifacts, credentials and personal settings stay outside Git.

## Latest acceptance: general performance guidance — 2026-10-08

The shared reviewer/verifier prompt now considers performance and scalability
through time, memory and I/O costs, expected workload, existing safeguards,
source evidence and concrete impact. The guidance uses the existing finding and
improvement-recommendation rules. It adds no specific coding-pattern exemption,
required benchmark, configuration or model stage.

One normal review and direct `pr-comment --publish` cycle passed within a
five-cycle allowance, using `openai/gpt-5.6-luna` and `zh-TW`. Existing comments
were backed up and cleared first. Independent Azure readback confirmed one summary
and three medium inline comments, with exact saved text, markers, coordinates and
immutable HEAD anchors. The summary retained its leading robot/AI/model disclosure
and omitted visible Review/HEAD metadata. Inline titles began with `🟡 medium:`.
The published defect examples were independently checked; the successful batch
was retained and live testing stopped. No runtime or further prompt correction
was needed during acceptance. This record grants no further review, publication
or cleanup.

The sample retained no performance finding or independent non-defect
recommendation. It therefore checks the existing end-to-end workflow with the
new prompt; it does not measure performance-defect detection or demonstrate
positive advice publication. Existing offline fixtures cover retained advice,
suggestions-only summaries and confirmed findings without inline coverage.

An initial review gave the wrong timezone sort direction; the verifier corrected
it before publication. Seven successful decisive source reads matched independently
inspected bytes; two other decisive reads failed because of a misplaced project
ID, and a root-directory read also failed. These three tool errors and the
original initial response remain recorded. The summary still repeats the issue
count, and generic test suggestions overlap existing tests. This is not evidence
of zero model errors or uniformly polished prose.

Model reviewers did not execute tests. Three native comment-stage calls inspected
host-saved MCP responses. Separate operator checks used isolated immutable source
copies: all nine fulfillment tests passed on the target-reference source, and
three failed on PR HEAD. Focused published-example reproductions were checked
separately. These are operator checks, not model-run tests or the target project's
full suite.

Syntax and all 443 offline tests passed for the tested prompt. Documentation,
whitespace and private-data checks passed. Daily installation matches all 17
accepted runtime/prompt files; private settings remain byte-identical. Protected
host files and repositories remain unchanged, test hosts stopped, and no
dependencies were upgraded.

The actual environment was OpenCode 2.0.22, official Azure MCP 2.9.0, Node 22.23.3
and Ubuntu 22.04.5. The running MCP process resolved azure-devops-node-api 15.1.3,
Zod 3.25.76 and MCP SDK 1.29.0. Exact-host fake-provider fixtures were not rerun
locally for these bytes; CI runs fresh/replacement fixtures after push and must
be checked for the exact commit. Rendered-browser behavior was not checked.
Earlier acceptances, local-only snapshots and failures remain in
[validation history](VALIDATION_HISTORY.md).

## Known limits

- Correct source bytes and COMPLETE status do not guarantee correct reasoning.
  Initial arithmetic errors were corrected before publication, but false ancillary
  statements remain in some accepted local counterevidence. The public-output
  criterion does not certify every initial or local sentence.
- Minor repeated count/coverage wording, literal terminology and severity variation
  remain. Language guidance is not a semantic filter or a measured general gain
  in model accuracy.
- Earlier runs retained version reversals, missing original-ID decisions, lost
  reproduction outcomes, permission requests, provider failures and partial writes.
  These are distinct failures; later success does not erase them.
- Native commands have ordinary host authority. Temporary source copies, test
  provenance, side effects and detached-process cleanup require separate scrutiny.
- Host context limits, provider admission/quotas, incomplete MCP responses and
  races after final PR/discussion reads still apply. No plugin spending cap or
  exactly-once remote-write guarantee is provided.
- Other models, PR sizes, languages, host/MCP versions and operating systems need
  their own evidence. Actual TUI navigation and rendered Azure Markdown remain
  separate from headless/API checks.

## Offline checks

Run from the repository root with Node.js 22.12 or later in the 22.x line and
Python 3:

```sh
npm run check
npm test
git diff --check
```

No npm install, live model, Azure connection or Python package installation is
needed. Installer tests use disposable configurations. Record the actual test
count for the tested revision rather than copying an older count.

| Area | Checks |
| --- | --- |
| Registration and transport | Native commands, literal admission/context correlation, independent sessions, final text, cleanup and non-resuming notices |
| Permissions | Exact role/model binding, active grants, inherited host rules, native denials, ordinary-session preservation and cancellation |
| Review delivery | Partial/unavailable initials, independent verification, frame conflicts, original-ID accounting and readable incomplete results |
| Output | Local review recovery, retained ambiguity, no lost observations, strict settings/check/comment contracts |
| Comments | Same-origin selection, optional preview/direct publish, retained summary advice and non-inline details, saved text, severity/anchor checks, uncertain-attempt lockout |
| Diagnostics | Private output, original failures/corrections, safe paths, timing and source-validity limitations |
| Installation | Exact file list, generated package entry, current settings, conflict refusal, rollback and archival removal |

A disposable file-installation check can also be run without touching the daily
configuration:

```sh
azpr_test_root=$(mktemp -d)
sh install.sh --config-dir "$azpr_test_root/config"
sh install.sh --config-dir "$azpr_test_root/config" --replace
sh uninstall.sh --config-dir "$azpr_test_root/config"
```

The last command previews removal. Placeholder models do not make this package
ready for a live review. Compare the eight JavaScript modules and nine prompts
to source, inspect the generated regular `server.js` entry/package export and
check owner-only settings permissions. See the [manual file list](../README.md#manual-copying-without-git).

## Exact-host checks without live models

Use an already available absolute path to the exact OpenCode 2.0.22 binary:

```sh
node tests/host-v2-smoke.mjs /absolute/path/to/opencode-v2-binary
node tests/host-v2-smoke.mjs /absolute/path/to/opencode-v2-binary --replace
```

The fixture invokes the installer, isolates host configuration/data/state/cache,
uses a loopback fake provider and fixture MCP, and keeps private evidence under
`.local/`. It is separate from `npm test`. CI installs the pinned host into a
disposable prefix and runs both modes; a local pass is not a completed CI run.
Changing only the installer's `--config-dir` does not isolate an OpenCode host.

The fixture covers package discovery, commands, admitted-context correlation,
review/preview/direct-publication delivery, saved-text restoration, malformed
output and host continuation, provider rejection, explained planning failure,
publisher-error revocation, cancellation and restart behavior. Native project
checks exercise inherited allow/ask/deny decisions and more than one project.
Ordinary auxiliary requests have positive controls; revoked private roles cannot
resume or issue auxiliary requests, including after restart. Source-only readiness
keeps its stricter native-tool denials.

Keep failed fixtures and their actual counts. Do not fix a count mismatch until
the observed call groups and the test's timing allowances have been inspected.
Fake services cannot establish real provider admission, pricing, Azure source
fidelity, model accuracy or live publication.

## Authorized live acceptance

Use an explicitly authorized disposable PR with independently known defects and
clean controls. Keep the answer key outside reviewer-visible instructions and
source. A review request is not standing permission to publish or delete comments,
change private settings, switch models or upgrade installed tools.

1. Record the source revision, installed-file hashes, exact host/MCP binaries,
   resolved dependencies, OS, model selection and relevant settings privately.
   Confirm the actual catalog capability and host permissions without publishing
   credentials or full host configuration.
2. Record PR identity, source/target SHAs and discussion state. `/pr-check` is an
   optional separate diagnosis; it is not a prerequisite or a cache for review.
3. Retain original answers, tool failures, normalization records, verifier input,
   final findings and all original-ID decisions. Independently compare decisive
   source reads and any materialized test files with their claimed commits.
4. Audit model facts separately from completion: version direction, arithmetic,
   reachable triggers, counterevidence, first failing assertions, severity and
   test provenance. A source-derived prediction is not an executed test result.
5. When publication is authorized, inspect the saved summary and inline plan,
   then independently check Azure content, markers, coordinates and actual thread
   IDs. Record partial writes and uncertainty; never retry a create blindly.
6. Stop owned hosts and inspect final remote/local state. Preserve failed evidence
   and respect the requested retention or cleanup scope. Do not alter daily
   installations or unrelated repositories to make acceptance pass.

For readability, optional review notes should add useful PR-wide context beyond
the issue index. Review methods and test results are not required summary topics;
relevant evidence belongs with the findings it supports. Inline comments should
preserve the verified trigger, impact and correction under compact
Summary, Evidence and Suggested fix labels. Assess these model instructions
against the actual text; headings and a successful write do not prove quality.
Compare final retained improvement recommendations and confirmed findings with
the actual summary, inline text and existing substantive discussions. Check for
lost advice across stages, unjustified defect severity and filler topic sections.

A release report distinguishes offline checks, exact-host fixtures, live service
behavior, factual/presentation quality and remote publication. Mark unexercised
cases explicitly. See [comment acceptance](COMMENTING.md#acceptance-test-before-real-use),
[project verification](VERIFICATION.md) and [debugging](DEBUGGING.md) for details.
