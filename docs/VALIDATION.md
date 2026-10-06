# Validation

This page describes the current validation process and the latest recorded
runtime evidence. The target is `@opencode/cli@2.0.22`, official
`@azure-devops/mcp@2.9.0`, and Ubuntu 22.04. Validate host integration, provider
admission, source fidelity, model quality and publication separately.

Earlier counts, retired features, intermediate failures and revision-specific
pending status are preserved in [validation history](VALIDATION_HISTORY.md).
They do not override the current behavior documented in [README](../README.md).
Private raw artifacts, credentials and personal settings stay outside Git.

## Latest runtime evidence

Recorded on 2026-10-06 for runtime and prompts committed as
[`b2047e1`](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/commit/b2047e11abf33a903343a6a21469fb3c783986fe).
Documentation-only changes do not imply a new live acceptance run.

| Check | Recorded result | Scope |
| --- | --- | --- |
| Syntax and offline tests | PASS; 436 passed, 0 failed | Local contract, runtime, output, permission and installer checks |
| Actual OpenCode fresh installation | PASS; 65 loopback fake-provider requests, 13 fixture MCP calls | Installed package discovery and host workflows on OpenCode 2.0.22 / Ubuntu 22.04.5 |
| Actual OpenCode replacement | PASS; 64 loopback fake-provider requests, 13 fixture MCP calls | Replacement and host workflows; private fixture settings preserved |
| Live review and direct publication | Final cycles 23-25 passed consecutively, out of 25 authorized review attempts | Identical runtime/prompt bytes, ordinary review commands and `openai/gpt-5.6-luna` on one disposable PR |
| Independent Azure readback | Saved text, markers, thread IDs and coordinates matched; inline anchors matched exact HEAD source | API content and coordinates, not browser rendering |
| Source correspondence | All 17 runtime files matched both host fixtures and all three accepted live installations | No claim that another installed copy has been updated |

The host fixture permits the cancellation sibling to make one or two requests;
that timing window accounts for the 65/64 totals. A private aggregation script
initially assumed 65 for both. Its failure was preserved and the report corrected
to the actual passing fixture results, without relaxing the test assertions.
Other earlier fixture and live failures remain in the history and private evidence.
Local results do not establish the status of a particular GitHub Actions run.

The live acceptance required COMPLETE review, a valid saved plan, direct
`pr-comment --publish`, independent remote readback, useful review notes and no
observed material false example or BASE/HEAD reversal in the published findings.
The final cycle posted one summary and two medium inline comments; its third
confirmed finding was rated low and remained in the summary. Earlier comments
were backed up and cleared under that task's explicit authorization. The final
batch was retained and testing stopped. This record grants no further reviews,
publication or cleanup.

The final three notes distinguish source/test inspection from execution. Those
reviews did not execute tests; one disclosed a failed test-file read. Earlier
reduced reproductions exercised attributed-result reporting separately. All owned
live test hosts stopped, while daily installation, private settings, dependencies
and the protected repositories remained unchanged in that acceptance task.

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
| Comments | Same-origin selection, optional preview/direct publish, saved summary and inline text, severity/anchor checks, uncertain-attempt lockout |
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

For readability, review notes should explain method, actual execution/results and
material evidence gaps, with attributed earlier results where appropriate. Inline
comments should preserve the verified trigger, impact and correction under compact
Summary, Evidence and Suggested fix labels. Assess these model instructions
against the actual text; headings and a successful write do not prove quality.

A release report distinguishes offline checks, exact-host fixtures, live service
behavior, factual/presentation quality and remote publication. Mark unexercised
cases explicitly. See [comment acceptance](COMMENTING.md#acceptance-test-before-real-use),
[project verification](VERIFICATION.md) and [debugging](DEBUGGING.md) for details.
