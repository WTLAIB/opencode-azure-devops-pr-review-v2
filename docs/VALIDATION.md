# Validation

This page records validation of the Azure DevOps REST implementation and the
0.1.0 distribution. Host integration, provider
admission, source fidelity, model quality and publication are separate claims; a
passing fixture establishes only the first. Earlier revisions and their live
acceptance runs, including the MCP-based runs, are preserved in
[validation history](VALIDATION_HISTORY.md).

## Automatic comments after a review (unreleased, 2026-10-22)

Environment as below (Ubuntu 22.04.5 under WSL2, Node 22.23.3, OpenCode CLI
2.1.2). `afterReview`, the review commands' `--preview`, `--publish` and
`--no-comment` flags, the safeguards of automatic publication and the setup
problem messages were added on top of 0.1.0; review prompts were unchanged.

- `npm run check` and **384 offline tests** passed. The new tests cover the
  setting (defaults, partial objects, values never echoed), the flag parser
  (one flag right after the URL, refused typos, dashes and second flags,
  `/pr-check` taking none, context starting after the flag), the hand-off
  (a COMPLETE review previews or publishes in a run of its own; STALE and
  cancelled reviews hand on nothing; a review without findings gets one
  notice and no model request; a flag overrides the setting both ways), the
  safeguards (a quick review's high-severity finding or incomplete coverage;
  links, `@<…>` mentions, images and HTML in the summary or an inline comment,
  while generics, decorators and AZPR's marker pass), a PR held by another
  comment command, `/pr-stop` of the automatic step, the `/pr-check` row, the
  installer adding `afterReview` and setup naming the problem without values.
  Removing any one safeguard, the no-findings check, the busy-lock handling,
  the typo refusal or the setting itself makes a test fail.
- All four real-host fixtures passed on OpenCode 2.1.2 with fake model and
  Azure services: fresh, replacement and native installation, and comment
  scale. The smoke fixture additionally ran `/pr-review <URL> --preview`
  (COMPLETE, then a PREVIEW in a run of its own, nothing posted),
  `/pr-quick <URL> --publish` with a high-severity finding and
  `/pr-review <URL> --publish` with a link in the planned text (both held back
  to PREVIEW with the reason), a quick review without findings (one notice and
  no further provider request), and, after a restart with
  `afterReview.review: publish`, a plain `/pr-review` whose automatic
  publication was POSTED and read back (VERIFIED=2).
- **Live** with this revision installed in the user's OpenCode 2.1.2 service:
  gpt-6-luna for every role, `afterReview` none for every mode and `--preview`
  on the command, so nothing was posted. Times are from first stage start to
  last stage end.
  - The one-file test PR: `/pr-quick <URL> --preview` was COMPLETE in 36 s
    with two REPORTED findings (two of the three known defects), and its
    automatic preview took 6 s.
    `/pr-review <URL> --preview` was COMPLETE in 93 s with the three known
    defects confirmed, and its automatic preview took 24 s. Both previews
    proposed no inline comment: each finding was skipped as `existing-thread`,
    naming the demo threads that already discuss it.
  - The 35-file test PR: `/pr-quick <URL> --preview` was COMPLETE in 44 s
    with no finding (both seeds missed). It got the one notice (`Automatic preview skipped: the
    review has no findings to comment on …`) and no planning session.
    `/pr-review <URL> --preview` was COMPLETE in 88 s with the seeded
    millisecond-format regression confirmed; the other seed was missed, as
    in earlier gpt-6-luna runs. Its automatic preview took 10 s and proposed
    one inline comment.
  - Each automatic preview started less than a second after its review's
    last stage, as a run of its own. Its STARTED notice and receipt named the
    source (`--preview`), and its Azure DevOps calls were reads only.
    `/pr-check` was READY with the new `Automatic comments` row
    (`afterReview: review none, deep none, quick none (no automatic
    comments)`).
  - Earlier attempts that day failed before any model request
    (`provider.auth`: the OpenAI sign-in could not be refreshed until it was
    renewed). Those INCOMPLETE reviews started no comment step.

## 0.1.0 release acceptance (2026-10-22)

Environment: Ubuntu 22.04.5 under WSL2, Node 22.23.3 and OpenCode CLI 2.1.2.
The native package entry and first-run setup were added on top of the merged
2.1.2 compatibility revision (`e1597ca`); review prompts were unchanged.

- `npm run check` and **367 offline tests** passed. The ten setup tests cover
  settings-path precedence, literal argument parsing, unavailable models and
  variants, private PAT-file validation, refusal to overwrite without
  `--replace`, preservation of advanced settings, atomic saves and blocked
  review commands before setup. They make no model or Azure requests.
- All four real-host fixtures passed with isolated profiles and fake model
  and Azure services: fresh source installation, replacement installation,
  native package installation and comment scale. The native fixture packs the
  package, installs an isolated Git commit through `opencode plugin add`,
  configures it with `/pr-setup`, restarts the host and exercises the review
  and publication workflow. Both the default external settings path and
  explicit `options.settingsFile` work; the file remains mode 600 and is
  outside the package cache.
- A separate clean profile installed public GitHub commit `f323aaa` with the
  documented `github:WTLAIB/opencode-azure-devops-pr-review-v2#COMMIT` syntax.
  The actual cached entry loaded, setup blocked reviews until configuration,
  and restart enabled the review and quick agents with the external settings
  unchanged. This acceptance made zero model or Azure requests. A clean source
  archive also passed fresh and replacement installation, entry loading,
  license and prompt checks, and preservation of settings and unrelated files.
- The scale fixture reviewed 120 changed files, recovered one overflow split,
  used seven functional, five risk and two verifier sessions plus one duplicate
  check, and planned eight pages with at most two in flight. Its largest
  captured provider request was 33,488 characters. It created 20 fake Azure
  threads and re-published without duplicates. These are controlled fixture
  measurements, not a bound on arbitrary real PRs or model behavior.
- A separate **live** run used `openai/gpt-6-luna` for all three review roles
  against the dedicated one-file Azure test PR #2, head `e8fc383` and base
  `406f5b2`. Review `268cc3f3` completed in 65.0 seconds: six initial candidates,
  three CONFIRMED findings and three MERGED duplicates. The findings matched
  the fixture's seeded atomicity, snapshot-isolation and timestamp-ordering
  regressions. The reviewers did not execute the fixture's tests.
- Its comment preview completed in 15.6 seconds with three inline comments
  and no skipped finding. Explicit publication took 1.5 seconds and read back
  four VERIFIED threads (one summary and three inline comments). A repeated
  publish took 0.5 seconds and reported four ALREADY_PRESENT items. An
  independent Azure REST GET also found exactly those four active threads;
  they were retained on the test PR. No active comment existed before this
  run, and historical deleted comments were left alone.

The [demo](DEMO.md) uses the actual terminal output and actual Azure comment
read-back from this run. It shortens waits and navigation, as documented with
the recording. It is evidence of this workflow on this test PR, not a claim of
general model accuracy, and the Azure read-back is terminal output rather than
an Azure web UI screenshot. The live run used an isolated source installation;
native setup and package loading were tested separately by the host fixture.

The first CI native-package run failed before the TUI admitted its startup
command. Local failure traces and the OpenCode 2.1.2 source identified a startup
race: `--prompt` can run before plugin commands reach the TUI catalog and become
an ordinary model prompt. CI did not retain its raw terminal capture, so that
run's cause cannot be established from its log alone. The fixture now waits for the actual native command in
slash completion and submits it interactively, preserving both new/existing
conversation and same-TUI cancellation checks. The runtime was unchanged;
the [troubleshooting note](DEBUGGING.md#a-startup-slash-command-becomes-an-ordinary-prompt)
records the host limitation.

## Onboarding and source distribution (2026-10-19)

The `codex/project-launch` changes, based on `d7cd0ac`, add onboarding,
synthetic demo assets, an MIT license and release preparation. The installer
now includes the license in the installed package; the documented minimal
source package contains 31 files (30 since `deep.md` was dropped, see
[deep versus review](#deep-versus-review-2026-10-19)). Review and publication
runtime code and prompts are unchanged.

- `npm run check` and all **345 tests** passed, including the updated manual
  source-package list, directory loading and installed license contents.
- Fresh and replacement installation passed with **OpenCode 2.0.32**. The
  comment-scale fixture passed with 120 changed files, eight planner sessions,
  at most two planning sessions in flight and 20 fake Azure threads.
- These host tests use loopback fake Azure DevOps and model services in
  isolated directories. No live model or Azure publication was run for this
  documentation/distribution change.
- Local guide links and anchors were checked. The demo's synthetic finding
  passes the actual comment-plan validator and renderer; the SVG and GIF were
  inspected visually. They demonstrate presentation, not model accuracy or
  real Azure UI rendering.

At that point, the 0.1.0 release notes were still a draft. See the release
acceptance above for the subsequent native package and recorded live run.

## Environment

Ubuntu 22.04.5 LTS (WSL2, kernel 6.18), Node 22.23.3, OpenCode CLI 2.0.22,
Azure DevOps Services REST api-version 7.1. Date: 2026-10-10. From
2026-10-17 the tested host was OpenCode CLI 2.0.32
([below](#opencode-2032-2026-10-17)); since 2026-10-22 it is 2.1.2
([below](#opencode-212-the-tested-host-2026-10-22)).

## Offline tests

`npm run check` and `npm test` pass: 384 tests across settings (including the
`mcp` → `azure` migration, the proxy and TLS settings and `afterReview`), host helpers, session
transport, the shared queue,
the REST client (change paging, merge base, error classes, retries, timeouts
that abort requests, binary and oversized files, the per-run cache, PAT never
logged, commit messages, the repository zip with a streaming size limit, proxy
and TLS options on every request, certificate, proxy-authentication, gateway and
Bun connection errors, proxy credentials never logged),
content search (zip reading, refused ZIP64, encrypted and damaged archives,
literal, case and whole-word matching, path filters, result bounds, one archive
per run and commit), line diffs (minimal edits checked against brute force on random
inputs, context, enclosing blocks, folded repeats, and every changed line shown
in a hunk or a folded repeat on random inputs), the reviewers' tools
(diffs of edited, added, deleted and renamed files, paging, file and content
search, optional arguments sent as null or blank text),
output acceptance and correction prompts (including verifier rows judged by
their own fields, confirmations that move a finding to another file and the
same-file duplicate check), comment validation and markers (including skips
that rely on another finding, and skip causes checked against the finding, the
page's source excerpts and the live threads, and pages of a large PR carrying
only their own files and dispositions), planning and publication, review sharding,
persistence, rendering, installation (including an output pipe closed
mid-install, which used to leave the lock and a staged copy of the previous
settings) and the runtime integration (fake host plus a fake Azure DevOps REST
service, including session deletion when the host never confirms one, a host
retry that OpenCode prepares again, the stage inactivity watchdog stopping,
naming and retrying a stalled stage while steady activity, streamed output, a
slow AZPR tool and an announced retry wait are never stopped, a PR without changed files, a
review without candidate findings that still gets its verifier, the token usage
kept per request in stage records, the project boundary for private roles
whatever the host's default for external directories, and the `/pr-check`
warning on a host without the permission hook).

The quick review (2026-10-18) adds tests for: one reviewer per shard and no
verifier; REPORTED and NEEDS_INFO decided by the runtime's form and source
checks (deleted, renamed, unchanged and binary files, line ranges, and reads
counted only for the session that made them, never another shard's or the
runtime's own, and only for versions whose source the answer showed, so a
line, column or hunk past the end, an empty file or identical versions are no
read; a diff showing only removed or only added rows, cut before the other
version's rows or showing only folded repeats reads just what it showed, and
an answer cut to the tool-output limit reads nothing);
different defects on the same line kept apart while only
records identical in every field are merged; a parsed answer without a usable
review giving PARTIAL; zero findings with incomplete coverage (a failed shard,
reviewer gaps, a partial change list); a usable PARTIAL answer that names
unfinished work getting one follow-up turn in the same session (completed, a
second PARTIAL that stands, none for COMPLETE answers, without turn budget or
in the verified pipeline, and an unusable, failed or watchdog-stopped
follow-up keeping the answer it followed while an overflow still splits the
shard); the quick disclosure line, report and
receipt; quick inline comments needing a changed HEAD file and an anchor found
in the source; a saved quick review commented on after a restart, and saved
records without a verification field trusted only for review and deep;
quick-then-review publication where only an identical complete marker is
ALREADY_PRESENT (the same anchor with a second defect posts ordinal 1); an
unavailable quick model or a changed quick agent blocking only `/pr-quick`;
the installer adding an empty `models.quick.reviewer`; and the review and deep
system prompts byte-identical to the previous revision (SHA-256 per role).
Combining cross-shard duplicates in comment planning adds tests for: candidate
groups only across sessions, with one severity and overlapping lines (never
within a session, across files, for summary-only or low findings, or beyond a
page); groups kept on one page and oversized groups planned apart; the
combination rules (a chain of overlaps with no common line or two members of
one session refused, a missing reason, an anchor outside the shared lines,
verified reviews never combining); a refused combination keeping valid single
comments and accounting for every ID; separate comments on one line staying
separate; summary rows and counts following accepted combinations only;
`findingIds` in the ledger with older plans still readable; and, end to end,
one comment for a duplicate pair that a refreshed preview and a second
publish leave alone, a later `/pr-review` finding the combined comment by its
ordinal-0 marker, and a combination that never meets the rules leaving both
findings in the summary index.
Planning two pages at a time (2026-10-19) adds tests for: a plan identical to
planning one page at a time, finding by finding and marker by marker, when page
2 finishes first (including two pages quoting the same line, whose ordinals
follow page order); at most `parallel` pages in flight and two lanes that do
overlap; only the first page writing the summary note, a note from another page
dropped without a correction turn while its details stay, and the first page's
continuation still allowed to write it; a continuing page whose checkpoint and
continuation evidence ignore another page's reads and details; after a failure
no new page or continuation, a page still preparing its input starting no model
work, the running page finishing before the failure is thrown, and the lower
page's failure winning; anchor checks that see exactly the HEAD source of the
page's own and earlier pages whichever fetch finishes first (review and quick);
and, in the runtime, two planner sessions at once but one when
`workflow.parallelSessions` is 1, session titles and evidence carrying the page,
a failed page whose running neighbour finishes before INCOMPLETE, and `/pr-stop`
cancelling both running pages and keeping no plan. Removing one rule at a time
from a copy of the code (assembly in page order, the page's own observed
source, page-scoped evidence, the check before a model call, the summary rule,
waiting for running pages, two lanes, the `parallelSessions` cap, page labels,
page-tagged evidence) made the matching tests fail; their waits are bounded, so
a broken lane fails a test instead of hanging it.
Dropping the deep-only prompt text (2026-10-19) changes the prompt test: every
deep role must have the review role's system prompt and permissions with a
different model, and the review roles keep their SHA-256 hashes; the installer
and the manual copy list no longer carry `src/prompts/deep.md` (30 files with
the license). New tests cover `/pr-check` saying that `/pr-deep` is off (no or
only some deep models), would repeat `/pr-review` (the same models in all three
roles, not when one differs) or lacks a model (a WARNING that leaves the check
READY and `/pr-review` running), the command descriptions OpenCode lists and
the error of an unconfigured `/pr-deep`.
The PAT file (2026-10-21) adds tests for: `azure.patFile` as an absolute path in
place of `azure.pat` and never both; a PAT read from an owner-only file that the
fake service accepts, while neither the PAT nor the path appears in a receipt;
a file that is missing, a symbolic link, a folder, readable by others, larger
than 4 KB, empty, holding two tokens or a placeholder stopping the load with an
error that never contains the content; a FIFO refused at once instead of
waiting for a writer, which would hang loading and every later command; a replaced or newly shared file blocking
new commands while the running review completes; and the installer adding an
empty `azure.patFile` without printing the PAT. Removing each check from a copy
of the code (mode, symbolic link, recheck before a command, the file's PAT
used for requests, both settings at once, the content check, the non-blocking
open) made its test fail.
Comments deleted on the PR (2026-10-22) add tests for: a thread recognized as
deleted when Azure DevOps lists it flagged deleted or with its first comment
deleted and without content (a deleted reply leaves it live); a created item
whose thread is deleted reported as `DELETED`, counted as settled and never
posted again, by the same review or another one with the same marker, also
when a run in between saw the comment and when the comment was found without
a record of its own; a thread already deleted at read-back; and the receipt
saying that `DELETED` items are not posted again and that `UNVERIFIED` items are
never posted twice. The host fixture deletes the inline comment after the
re-run and expects `DELETED` without a write. Reading back without the deleted
check, or dropping the record of a comment once it is seen (the earlier
behaviour, which posted it again after a deletion), made the matching tests
fail.
The move to OpenCode 2.1.2 (2026-10-22) adds tests for: a used-up provider
quota (`provider.quota`) or OpenCode free-model limit (`provider.free-limit`)
named in the stage error, with or without a valid HTTP status and without the
provider's own text, classified as permanent, and, end to end, a 429 quota
failure that starts no second session and says why in the receipt; and the
tested host version. Removing the quota rule from a copy of the code made
these tests fail.

## REST API version check

Read-only requests against a live Azure DevOps Services organization: every
resource AZPR uses reports a minimum version of 1.0 or 3.0, a released version
of 7.1 and a maximum of 7.2. The PR, iterations, iteration changes, threads,
item (raw and JSON) and folder requests returned identical fields on 5.0, 5.1,
6.0, 7.0, 7.1 and 7.2-preview. An invalid PAT or a missing credential returns
HTTP 203 with an HTML sign-in page, an out-of-range version returns 400
`VssVersionOutOfRangeException`, and a missing PR returns 404 `TF401180`. Thread
creation with 7.1 was exercised in the live run below.

## Exact-host fixtures

`tests/host-v2-smoke.mjs` (fresh install and `--replace`) runs the real OpenCode
2.0.22 binary with a loopback fake model provider, a loopback fake Azure DevOps
REST service and one foreign stdio MCP server. Both passed:

| Scenario | Observed |
| --- | --- |
| `/pr-check` | READY with zero model requests; REST reads only. |
| `/pr-review` | COMPLETE; reviewers read HEAD through `azpr_read_file` and searched HEAD's file contents through `azpr_search_code` (one repository zip for the run); `shell`, `execute` and the foreign MCP tool were absent from every private model request; the verifier was corrected by one repair turn in the same session; the runtime read the change list and rechecked versions; PROGRESS notices reached the conversation; the review was persisted. |
| `/pr-comment` | PREVIEW, then `--publish` POSTED one summary and one inline comment with markers and file context. |
| Restart | After restarting the host, `/pr-comment --publish` returned POSTED with ALREADY_PRESENT, no new writes and no model request. |
| Deleted comment (2026-10-22, OpenCode 2.0.32) | After the inline comment was deleted the way Azure DevOps deletes one (thread listed, flagged deleted, comment without content), `/pr-comment --publish` returned POSTED with that item `DELETED` and no new write. Fresh and `--replace` runs. |
| Tool scopes | An ordinary conversation's model request carried the foreign MCP tool and no `azpr_*` tool. |
| Unattended approvals | A reviewer's native `grep` on the repository path `/scale_lab` was refused with a pointer to the azpr tools (`permission.rejected`) instead of waiting; no approval request remained open. Since 2026-10-17 the fixture also greps `/etc`, an existing directory outside the project, which is refused with the same pointer on 2.0.22, 2.0.31 and 2.0.32 (see [OpenCode 2.0.32](#opencode-2032-2026-10-17)). |
| `/pr-stop` | A review hanging at the provider was CANCELLED. |
| Provider retry (2026-10-14) | The fake provider answered the risk reviewer's first request with HTTP 503. OpenCode retried it in the same session after its backoff (1.6–2.3 s in eleven runs, two of them in CI); AZPR's `retry` hook allowed it (attempt 2), the resend passed the primary-request check (4 authorized primary requests, none rejected) and the review was COMPLETE without a new session. Fresh and `--replace` runs. |
| Stalled and long streams (fresh run, 2026-10-15) | With `workflow.stageIdleSeconds` 60, two reviews ran at once. In the first, the fake provider sent the functional reviewer's response headers and then nothing. After 60.0 s the watchdog stopped the stage: `failure=idle`, error `Stage inactivity watchdog stopped this stage: no activity for 60 s after model request 1 was sent (workflow.stageIdleSeconds).`, an inactivity notice and a PROGRESS retry notice naming it. AZPR interrupted the session, OpenCode closed the provider stream and confirmed settlement (no cancellation warning), and a new session completed the review. In the second, the functional answer streamed one chunk per second for 66.0 s, longer than the window, and ran on without a stop or a new session. Both were COMPLETE 66.3 s after the commands. |
| Private sessions | Generate and compaction on a private session sent no provider request; ordinary generation still worked. |
| TUI | New and existing TUI sessions kept their origin and cancelled from the same TUI. |
| Proxy (fresh run, 2026-10-13) | The fake service served HTTPS with a certificate from a fixture CA, reachable through a CONNECT proxy that demands Basic credentials. With `azure.proxy` (credentials containing `@` and a space, percent-encoded) and `azure.caFile`, `/pr-check` was READY over one tunnel; the proxy saw the percent-decoded credentials and no `Authorization` header. Without the CA file: NOT_READY with the certificate message, no retry, no request reached the service. Without proxy credentials: NOT_READY explaining HTTP 407. `verifyTls: false`: READY with a WARNING row. The proxy password appeared nowhere in the fixture except the installed `settings.json`. |

The first smoke attempt failed: AZPR's tools were registered without
`codemode: false`, so OpenCode placed them behind CodeMode `execute`, which
private reviewers may not use, and reviewers saw no AZPR tool. The tools are now
registered with `codemode: false`, and the test tool registry applies the same
rule so the offline runtime tests catch a regression.

`tests/host-v2-comment-scale.mjs` passed on the same host:

| Property | Observed |
| --- | --- |
| Changed files | 120, reviewed in 5 shards of 24 per role; functional reviewers read whole files, risk reviewers read diffs |
| Context overflow | One functional shard reported a nearly full context; the host attempted compaction, AZPR refused it, and the shard was split into `1/5a` and `1/5b`, both COMPLETE |
| Verification | 30 findings in 2 verification sessions; the second verifier moves one high finding into a file of the first |
| Duplicate check | One `dedupe` session for that file, which merges the moved duplicate |
| Planning | 8 pages of at most four findings (29 findings); since 2026-10-19 two at a time: the fake provider holds the first page until a second arrives, and at most two planning requests were in flight |
| Publication | 20 threads (19 inline, 1 summary; 10 low findings in the summary); a second publish wrote nothing |
| Largest provider request | 31,136 characters (27,185 before the duplicate rules and the diff and search tools) |
| REST calls | 74 |

## OpenCode 2.1.2, the tested host (2026-10-22)

Since 2026-10-22 the tested host is OpenCode CLI 2.1.2, which the user's
company runs (`TESTED_HOST_VERSION`; CI runs the exact-host fixtures with it).
2.1.0 and 2.1.1 were not tested. Reviewing the 146 commits from `v2.0.32` to
`v2.1.2` of the OpenCode source found nothing AZPR depends on changed:

| Area | 2.0.32 → 2.1.2 |
| --- | --- |
| Plugin context | `session.list` was added (paged, 50 per page); every method AZPR calls is unchanged. Session archiving exists only in the HTTP API. |
| Hooks AZPR uses | `prompt`, `context`, `model.request` (its `kind`), `retry` (`attempt`, `decision`), `permission.evaluate` and the tool hooks keep their shapes; the retry schedule moved into a shared module with the same event. |
| v2.1 breaking changes | Provider replay data renamed to `native`, compactions referencing kept messages, `session.compacted` removed, credential form answers in `metadata`: AZPR reads none of them. A session that 2.1 compacts cannot be loaded by 2.0.x, so a downgrade needs the database backup taken before the upgrade. |
| Host constants | The continuation text, the streamed event names and the embedded Bun 1.4.2 are unchanged; permission defaults are unchanged. A built-in `todowrite` tool exists behind an experimental flag; private roles see only their allowlist. |
| Errors | Provider session errors may carry `retryAfterMs`, and OpenCode's free models report `provider.free-limit`. AZPR now treats it and `provider.quota` as permanent (see offline tests); before, a 429 status made them look transient and a new session repeated the failure. |
| Idle locations | 2.0.32 interrupted the sessions of a location without session events for 60 minutes; 2.1.2 keeps a location with running sessions or background jobs (`experimental.location_idle_timeout` changes the period). A review's sessions emit events throughout, and AZPR's stage inactivity watchdog stops a silent stage after 600 s by default, long before either host would. |

- Exact-host fixtures: `host-v2-smoke.mjs` fresh and `--replace` and
  `host-v2-comment-scale.mjs` passed on 2.1.2 twice: first with the previous
  revision changed only in its tested version (2.1.2 installed into a
  disposable prefix), then with this revision on the upgraded system
  install. Every scenario passed, including the provider 503 retried in place
  (4 authorized primary requests, none rejected), the inactivity watchdog, the
  refused compaction and shard split, publication with a deleted comment, and
  the proxy.
- Upgrade: with the background service stopped, its database was copied
  first; then `npm install -g @opencode/cli@2.1.2` and a start. The previous
  revision's `/pr-check` on the 1-file PR was READY on 2.1.2 with a host
  notice; with this revision it was READY without one.

Live on the upgraded background service with this revision (gpt-6-luna for
quick and review, `workflow.parallelSessions` 8, each review followed by a
comment preview; nothing was posted):

| PR | Mode | Review | Sessions / requests | Input (cached) | Findings | Preview (inline) |
| --- | --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | quick | COMPLETE, 35 s | 1 / 4 | 26 K (63 %) | the 3 known defects | 20 s (3) |
| | review | COMPLETE, 79 s | 3 / 14, 1 correction | 100 K (72 %) | the 3 known defects | 19 s (3) |
| PR #4, 35 files | quick | COMPLETE, 52 s | 2 / 7 | 176 K (61 %) | the seeded regression in the diff | 8 s (1) |
| | review | COMPLETE, 86 s | 5 / 25 | 684 K (72 %) | no candidate for either seeded regression; the verifier rightly rejected the one other candidate | 3 s (0) |
| PR #3, 316 files | quick | COMPLETE, 134 s | 13 / 56 | 2.07 M (71 %) | policies 23 of 24 (not `queue_priority`), not the configuration defect | 65 s (23, 3 combined) |
| | review | COMPLETE, 370 s | 39 / 151, 2 corrections | 4.68 M (71 %) | policies 24 of 24, not the configuration defect, one false low finding on a test file (summary index only) | 87 s (25; 3 low skipped) |

- The 12 runs had no AZPR retry, failed stage, inactivity stop, tool timeout,
  blocked native tool, host retry, Azure DevOps retry or warning, and every
  session was confirmed stopped; one reviewer tool call on PR #3 returned an
  error. `/pr-check` was READY before each review, without a host notice.
- The results stay within gpt-6-luna's earlier runs on 2.0.32: the PR #4
  regression outside the diff is still missed, and the quick miss of one
  policy and the false test-file finding occurred before. PR #3's review took
  longer than earlier runs (226–300 s); it ran eight duplicate checks, for
  verified findings that ended up in the same files.

## OpenCode 2.0.32 (2026-10-17)

From 2026-10-17 to 2026-10-21 the tested host was OpenCode CLI 2.0.32, the release the
user's company ran (`TESTED_HOST_VERSION` in `src/host.mjs`; CI runs the
exact-host fixtures with it), and receipts add a host notice for any other
version. Other results on this page used 2.0.22 unless noted; 2.0.31 was
checked on the way. The published 2.0.31 and 2.0.32 binaries embed Bun 1.4.2
like 2.0.22:

| Check | Observed |
| --- | --- |
| Exact-host fixtures | `host-v2-smoke.mjs` fresh and `--replace` and `host-v2-comment-scale.mjs` passed on 2.0.32 (and on 2.0.31 and 2.0.22 with the same checks): every scenario of the tables above, plus token usage in the debug stage records for every model request of the review. Since 2026-10-18 the smoke fixture also runs `/pr-quick` (one quick session, no verifier, the session's reads recorded) and its comment preview with the zh-TW quick disclosure line; fresh, `--replace` and the scale fixture passed on 2.0.32. Since the quick follow-up, two more `/pr-quick` runs have a fake reviewer that answers PARTIAL first: its one follow-up prompt reaches the same session and completes the review, or gives no usable answer and the earlier answer with its finding stands (receipt `follow-up=completed` / `unusable`); fresh, `--replace` and the scale fixture passed on 2.0.32. With planning two pages at a time (2026-10-19) fresh, `--replace` and the scale fixture passed on 2.0.32, the scale fixture with two planning requests in flight at once (8 planner sessions, 20 threads, a second publish writing nothing). |
| Project boundary | 2.0.31 dropped the `external_directory: ask` rule that 2.0.22 put in every new agent's default permissions, and 2.0.32 keeps it out, so external paths fall under `*: allow`. AZPR's permission hook only turned `ask` into `deny`, and on 2.0.31 a private reviewer's native `grep` on `/etc` ran and returned file contents. The hook now decides `external_directory` for private roles itself: allowed only when every resource is in AZPR's private data directory, otherwise refused with the pointer to the azpr tools. No live run used a native read tool outside the project; the one live review on 2.0.31 before the fix used only AZPR's tools. |
| Missing local paths | 2.0.31 and 2.0.32 answer a native `grep` on a path that does not exist locally, such as the repository path `/scale_lab`, at once with `Search path does not exist`, before any permission request; 2.0.22 asked, and AZPR refused with the pointer. Neither waits. |
| Host constants | The continuation text, foreign message types and streaming event names in `host.mjs` are unchanged in 2.0.31 and 2.0.32; both send `session-id`, `thread-id` and `x-client-request-id` on the ChatGPT token-sharing route (below). |
| Live, after upgrading the user's background service from 2.0.22 to 2.0.31 | `/pr-check` of the 1-file PR was READY; a review-only `/pr-review` was COMPLETE in 75 s with the same three confirmed findings as on 2.0.22. With the boundary fix installed, `/pr-check` was READY again. |
| Live on 2.0.32 (the service upgraded again, this revision installed) | `/pr-check` was READY without a host notice; a review-only `/pr-review` of the 1-file PR was COMPLETE in 75 s with the same three confirmed findings. The debug stage records held one token row per model request (4, 5 and 4 requests), and 54.4% of the run's input was read from the cache. |

## Prompt cache with a ChatGPT subscription (2026-10-16/17)

OpenCode reports for each assistant message `input` (without cached input),
`cache.read` and `cache.write`; stage records keep these numbers as `tokens`
([debugging](DEBUGGING.md)), and the cached share is
`cache.read / (input + cache.read + cache.write)`. Measured with real models
through the user's OpenCode service, with OpenAI signed in through "Sign in with
ChatGPT" (token sharing: `api.openai.com/v1` over HTTP), gpt-6-luna unless
noted:

| Host and workload | Cache |
| --- | --- |
| 2.0.22, the same 2.8K-token prompt sent four times (`/generate`), on two days | 0 of 3 repeats each time |
| 2.0.22, one ordinary session with 8 growing turns (gpt-6-luna, gpt-5.6-luna, gpt-6.1-sol) | 1, 0 and 1 of 7 follow-up requests read the previous prompt |
| 2.0.22, review-only `/pr-review` of the 1-file PR, two runs | 4.4% and 4.6% of input |
| 2.0.22 with a test build of AZPR that set `session_id` and `session-id` to each private session's ID | 51.9% and 61.4%; 17 of 20 follow-ups read 75–99% of the previous prompt |
| 2.0.31, the same prompt four times | 2 of 3 repeats |
| 2.0.31, one ordinary session with 8 turns | 7 of 7 follow-ups, 92–98% each |
| 2.0.31, the same 1-file PR review with AZPR unchanged | 47.6% of input; 7 of 10 follow-ups |
| 2.0.32, the same prompt four times | 2 of 3 repeats |
| 2.0.32, one ordinary session with 8 turns | 7 of 7 follow-ups, 92–99% each |
| 2.0.32, the same 1-file PR review (this revision, from the debug token records) | 54.4% of input; 7 of 10 follow-ups |

AZPR's requests keep a stable prefix: with a loopback fake Responses provider,
every follow-up's input extended the previous one, and instructions and tools
did not change between requests. The low share came from the host: on 2.0.22
the token-sharing route sent no session headers
([anomalyco/opencode#53765](https://github.com/anomalyco/opencode/issues/53765)),
which [anomalyco/opencode#53767](https://github.com/anomalyco/opencode/pull/53767)
fixed with `session-id`, `thread-id` and `x-client-request-id` before 2.0.31.
The Codex sign-in route (device code, in an isolated environment) already cached
on 2.0.22: 3 of 3 repeats and 50% over 8 turns. Before 2026-10-10 the reviewers
used MCP tools whose definitions formed a long prefix shared by all sessions,
which most likely explains why the earliest live runs read 31–45% from the
cache (their sessions no longer exist, so this was not checked per request).

## Proxy and TLS behaviour of OpenCode's runtime

Measured on 2026-10-13 with the Bun runtime embedded in OpenCode 2.0.22 (Bun
1.4.2, run as `BUN_BE_BUN=1 opencode`), a local CONNECT proxy and a fixture CA;
`azure.proxy`, `azure.caFile` and `azure.verifyTls` are built on these results:

| Behaviour | Observed |
| --- | --- |
| `fetch(url, { proxy })` | HTTPS through a `CONNECT` tunnel and HTTP in absolute form, for loopback targets too; an `https://` proxy works as well. Credentials in the proxy URL are percent-decoded into `Proxy-Authorization: Basic`. |
| `tls: { ca }` | Replaces the built-in roots: with only the fixture CA, dev.azure.com failed with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. AZPR therefore appends to `tls.rootCertificates` (121 roots); a two-certificate bundle works. Host names are still verified (`ERR_TLS_CERT_ALTNAME_INVALID`). |
| `tls: { rejectUnauthorized: false }` | Skips verification, also through a proxy. |
| Proxy refusals | A 407 or a refused `CONNECT` (403) comes back as a `Response` with that status, not as an exception; it carries the proxy's headers only. |
| Errors | Thrown with `error.code`: `ConnectionRefused` (also for an unreachable proxy), `ENOTFOUND`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and other certificate codes. |
| Environment | `HTTPS_PROXY` and `NO_PROXY` are honoured without the `proxy` option; `NODE_EXTRA_CA_CERTS` and `NODE_TLS_REJECT_UNAUTHORIZED=0` work process-wide. |
| Azure DevOps answers | A 302 sign-in redirect and a 404 for an unknown organization both carried `X-TFS-ProcessId` (and `ActivityId`, `X-VSS-E2EID`); the fixture proxy's answers did not. |

The first symptom that led to this work came from a corporate network: `/pr-check`
reported `Azure DevOps PR failed: network error (ConnectionRefused) after 3
attempts.` because dev.azure.com is reachable there only through a proxy.
On 2026-10-14 `/pr-check` passed on that network with `azure.proxy` set to the
company's HTTP proxy and `azure.verifyTls` false (shown as a WARNING row); no
`azure.caFile` was set.

## Live run (Azure DevOps Services, real model)

PR kevin888y/OpenCode #2 (one changed file), `openai/gpt-5.6-luna` for all three
roles, `zh-TW`, through the user's OpenCode service with the installed package,
`azure.organization` and an existing PAT in AZPR's settings. The AZPR comments
of earlier runs were deleted first.

| Step | Result |
| --- | --- |
| `/pr-check` | READY, 5 s; 6 REST calls; head, merge base, 1 changed file, HEAD and BASE reads, 156 threads. |
| `/pr-review` | COMPLETE, 75 s; three medium findings confirmed; reviewers made 20 tool calls (file reads and root listings at exact commits) served by 9 REST requests thanks to the run cache; no correction turn, retry or tool error. |
| `/pr-comment --publish` | POSTED 4 items (summary and three inline), 25 s; planning took 1 model request and no tools. |
| Second publish | POSTED, all 4 ALREADY_PRESENT, no write. |

Independent REST read-back found the inline threads on `/fulfillment.py` at
right-side lines 19–24, 29 and 37, each with its marker; Azure DevOps attached
`pullRequestThreadContext` (iteration 1/1, change tracking ID 1) itself. The
four private sessions used about 54,500 input tokens (the two MCP-based runs used
about 241,000 and 80,000). All 34 REST calls of the four commands succeeded on
the first attempt. The test comments were deleted after the read-back.

`/pr-check` of PR #3 (316 changed files) returned READY with all 316 files as a
complete list and the merge base; through MCP 2.9.0 the runtime saw 100.

## Live run: large PR (Azure DevOps Services, real model)

PR kevin888y/OpenCode #3 (316 changed files), the same models, language and
service; `/pr-review` only, nothing was posted.

The first attempt stalled 45 seconds in: in four reviewer sessions the model ran
native `grep` on the repository path `/scale_lab`, OpenCode asked for
`external_directory` approval, and the unattended private sessions waited for
30 minutes until the run was stopped (about 950,000 input tokens were spent).
Private sessions now refuse at once any request that would wait for an approval
(shell excepted when the `shell` setting allows it) and point the model to the
azpr tools; the exact-host smoke test reproduces the `grep` and passes.

The second attempt was COMPLETE:

| Property | Observed |
| --- | --- |
| Duration | 626 s: initial review 541 s, verification 80 s |
| Initial review | 26 sessions (2 roles × 13 shards of up to 25 files), all COMPLETE; no correction turn, stage retry, overflow, tool failure or blocked tool; about 1,550 tool calls |
| Verification | 4 sessions, all COMPLETE without a correction turn; 48 candidates → 25 confirmed (7 high, 17 medium, 1 low), 23 merged duplicates, none rejected |
| Azure DevOps | 593 REST calls: 587 file versions each fetched once (the run cache served every other read), one 404 for a path the model guessed, no retry needed; median 259 ms, p95 1.0 s |
| Approval prompts | None |
| Tokens | About 7.44 million input tokens (about 280,000 per initial session, 32,000 per verification session) and 79,000 output tokens |

One duplicate remained in the report (`F-2001` and `R-2001`, the same cause in
`worker_capacity.py`): count-based verification shards had put that file's two
findings into different verifiers. Verification shards now end only between
files; a unit test reproduces the 48-finding distribution.

## Live run: large PR with publication (commit 68c1f7e)

PR kevin888y/OpenCode #3 again, at the same head, with the same models, language
and service, running the installed package of commit `68c1f7e` (the revision
before the verifier and planner corrections below). The 24 AZPR comments of an
earlier run were deleted first; the comments of this run were kept on the PR.

| Step | Result |
| --- | --- |
| `/pr-check` | READY, 9 s |
| `/pr-review` | COMPLETE, 719 s: initial review 589 s (26 sessions), verification 129 s (5 sessions); 66 candidates → 26 confirmed (6 high, 19 medium, 1 low), 40 merged duplicates, none rejected; one correction turn |
| `/pr-comment --publish` | POSTED, 157 s: 7 planning pages of one model request each and no tools (147 s), then 25 items (summary and 24 inline) created in about 5 s and all read back as VERIFIED |
| Second publish | POSTED, all 25 ALREADY_PRESENT, no write |

- 681 REST calls over the four commands, none retried; four 404s for paths that
  models guessed.
- About 7.60 million input and 88,000 output tokens; initial review sessions
  used 95 % of the input.
- Independent read-back: 23 of the 24 inline threads sit on changed right-side
  lines; the 24th reports a removed check and sits on the line after the
  removal, where HEAD has no line for it.
- The two `worker_capacity.py` findings that stayed separate in the previous run
  were merged, as file-grouped verification shards intend.
- Initial sessions used on average 3.71 of the 4 `workflow.parallelSessions`
  slots; the 26 sessions ran in about seven waves.

Two observations led to corrections in the current revision:

1. One verifier wrote four merges into `confirmed` (`{"id", "mergedInto",
   "reason"}`). They were treated as incomplete confirmations and cost one
   correction turn. A decision row is now judged by its own fields: an explicit
   status, or a merge target on a row without a finding.
2. A verifier moved R-12001, a test that asserts the wrong result, from the test
   file onto the implementation lines of F-1009 without saying so. The planner
   then skipped R-12001 as covered by F-1009's comment, so the test got no
   comment and the summary index showed the implementation file. A move to
   another file must now be declared with `movedFrom` (otherwise the verifier is
   asked to confirm or undo it, and an unconfirmed move is kept with a warning),
   the report shows the initial location, and the planner may not skip a
   finding because another finding of the review is commented (a prompt rule,
   plus a correction turn when a skip names another finding). Moves stay
   allowed: of the 60 confirmations in the live runs so far, 2 moved to another
   file, and the other one (R-4001, from a region JSON file to the code that
   drops its fields) was correct.

## Live runs: parallelism and the corrections (review only)

Two more `/pr-review` runs of PR #3 at the same head, same models, language and
service, nothing posted (the 25 comments above were unchanged afterwards). The
first used commit `628a78d` with `workflow.parallelSessions` 8 and
`azure.concurrency` 3; the second used this revision with 8 and 6.

| Property | 68c1f7e, 4 / 3 (above) | 628a78d, 8 / 3 | This revision, 8 / 6 |
| --- | --- | --- | --- |
| Review duration | 719 s | 460 s | 393 s |
| Initial review | 589 s; 3.71 sessions on average, peak 4 | 380 s; 6.07, peak 8 | 319 s; 6.71, peak 8 |
| Sum of initial session time | 2,187 s | 2,308 s | 2,143 s |
| Verification | 129 s, 5 sessions in two waves | 79 s, 4 sessions | 72 s, 5 sessions in one wave |
| Candidates → confirmed | 66 → 26 | 53 → 26 | 60 → 26 |
| Correction turns | 1 | 0 | 0 |
| Provider retries, stage retries | 0, 0 | 0, 0 | 0, 0 |
| REST calls (median, p95) | 616 (168 ms, 433 ms) | 646 (432 ms, 2.7 s) | 587 (90 ms, 244 ms) |
| Most REST calls issued in one second | 36 | 86 | 38 |
| Input tokens | 7.60 M | 9.17 M | 7.87 M |

- A call's duration includes waiting for a queue slot. Calls that started with
  fewer than three other calls in flight, so without waiting, took a median of
  73–75 ms in every run, so Azure DevOps did not slow down: with 8 sessions and
  a queue of 3, the queue was the bottleneck, and a queue of 6 removed it. No
  request was throttled.
- Token use varies between runs of the same commit (7.4 M to 9.2 M input so
  far) with the number of model requests and tool calls; it did not follow the
  parallelism.
- In the 628a78d run, a verifier declared two moves to another file with
  `movedFrom` in its first answer (from region JSON files to the normalization
  code that drops their fields); the report showed both initial locations.
- In the second run, a verifier again wrote merges into `confirmed` (nine
  `{"id", "mergedInto", "reason"}` rows and no `merged` list). They were
  classified as merges without a correction turn.
- No file held findings that different verifiers confirmed, so the duplicate
  check did not run; it is validated offline and with the exact-host scale
  fixture.

## Live A/B: reading diffs instead of whole files (review only)

Seven `/pr-review` runs of PR #3 at the same head, with the same models,
language and service; nothing was posted. Baselines A–C read whole files
(commits `68c1f7e`, `628a78d`, `fe0ee7b`; `parallelSessions`/`azure.concurrency`
4/3, 8/3 and 8/6). The variants used `azpr_read_diff`, `azpr_find_files` and the
reading rules, all with 8/6:

- V2 sent the diffs of all assigned files with the assignment;
- V1 let reviewers read diffs themselves, without folding;
- V3 (this revision) folds repeated changes and asks for few reading rounds.

| Run | Review | Input tokens | Requests per initial session | Candidates → confirmed | Policy defects found | Configuration defect |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline A | 719 s | 7.52 M | 5.08 | 66 → 26 | 24/24 | found |
| Baseline B | 460 s | 9.17 M | 5.42 | 53 → 26 | 24/24 | found |
| Baseline C | 393 s | 7.87 M | 5.35 | 60 → 26 | 24/24 | found |
| V2 | 419 s | 15.13 M | 5.31 | 107 → 25 | 24/24 | found |
| V1 | 451 s | 11.73 M | 5.58 | 74 → 27 | 24/24 | found |
| V3 | 381 s | 5.53 M | 5.54 | 84 → 25 | 24/24 | found |
| V3 | 429 s | 5.46 M | 5.54 | 69 → 25 | 24/24 | found |

- Reviewers made about 5.5 model requests per session in every variant; cost
  follows how much each request carries.
- 240 of the 316 files are 300-line JSON region profiles with the same
  migration on every route, so their plain diffs are 80 % of HEAD plus BASE.
  V2 put 25 such diffs into every request of a shard, and reviewers still read
  whole files: tokens roughly doubled, so sending diffs upfront was removed.
  V1's plain diffs and the new reading rules cost 49 % more than baseline C.
- Folding repeated changes brings PR #3's diff volume to 29 % of whole-file
  reads (measured offline over all 316 files). V3 used 27–41 % fewer input
  tokens than the baselines in two runs, with all 24 policy defects and the
  configuration defect found each time. These runs used a diff renderer that
  dropped the middle of long change blocks (see "Diff defect" below); the
  offline ratios here are measured with the corrected renderer.
- Offline over the latest 182 pydantic commits that modified source files (618
  files), diffs are 5.3 % of whole-file HEAD and BASE reads (median per commit 4
  %, 90th percentile 11 %), so code-centric PRs should save more.
- The duplicate check ran on a real model: in V1 it merged five duplicates that
  different verifiers had confirmed in one file and kept two different
  configuration findings apart.
- Severity varies between runs of every variant (high findings: 4 to 12).
  `azpr_find_files` was used 19–28 times per run, but guessed-path 404s did not
  drop (1–5 per run).

## Live run: real code (review only)

PR kevin888y/OpenCode #4 was created for this test from pydantic (MIT): a
snapshot at `125921fdc9` as the base and the changes of the next 20 upstream
commits as the source (35 files, +1,074/−293 lines, Python and Rust; 13 changed
source files have more than 1,000 lines). Two regressions were seeded: one in a
changed hunk (`json_schema.py` declares millisecond temporal values as strings
although they serialize as numbers) and one outside the diff (a bare
`MutableSequence` still uses the sequence schema while the PR's new test expects
a list; the test and the implementation fell into different shards). Offline,
its diffs are 7.4 % of whole-file HEAD and BASE reads. Both revisions ran with
`parallelSessions` 8 and `azure.concurrency` 6; nothing was posted.

| Property | Whole-file reading (`fe0ee7b`) | This revision (`c1de65c`) |
| --- | --- | --- |
| Review | 331 s | 115 s |
| Initial sessions | 10: three sessions filled their model context and their shards were split | 4 |
| Input tokens | 6.15 M | 0.79 M (−87 %) |
| Seeded regression in a changed hunk | found and confirmed | found and confirmed |
| Seeded regression outside the diff, test and code in different shards | missed | missed |
| Other confirmed findings | none | none |

Diff-based reading kept the result of whole-file reading on real code at an
eighth of the input tokens and without context overflow. Neither revision
connects a new test with unchanged code in another shard.

## Live run: content search and commit messages (PR #4, review only)

`azpr_search_code` (literal search over the repository zip of HEAD or BASE) and
the PR's commit messages were added for the seeded regression outside the diff.
PR #4 has one commit with a generic message, so the messages carried no
evidence here. Two runs, same models and settings, nothing posted:

| Property | Run 1 | Run 2 (diff and argument fixes below) |
| --- | --- | --- |
| Review | 135 s | 135 s |
| Input tokens | 0.64 M | 0.55 M |
| Requests per initial session | 5.25 | 4.25 |
| Tool calls (diff / file / search) | 70 / 52 / 31 | 70 / 29 / 28 |
| Failed tool calls | 5 (4 searches with `path: ""`, one 404) | 0 |
| Repository zips (HEAD, BASE) | 4.10 MB in 1.5 s, 4.09 MB in 1.7 s | same |
| Seeded regression in a changed hunk | found and confirmed | found and confirmed |
| Seeded regression outside the diff | missed | missed |

Reviewers used content search for callers, definitions and the code behind
changed tests (for example `ser_json_temporal`, `as_ser_schema`, `SecretStr`),
but in both runs the reviewers of the test shard read the new
`test_bare_mutable_sequence` and never searched for `MutableSequence`; in run 1
a search for the test's name failed on the blank path. Searching is available
but not applied to every new test. Offline, a lexical cross-reference from the
identifiers on added test lines to the non-test files that use them (identifiers
found in at most three files) points at the seeded line
(`_generate_schema.py:375`, `MutableSequence` mapped to the sequence schema) and
adds about 15,600 characters for the whole PR, along with noise from comments.

## Live run: models and reasoning effort (PR #4, review only)

All three review roles on one model, same revision and settings, nothing
posted. "default" is the model's default variant, which AZPR always used before
`provider/model#variant` was supported; `#high` asks for high reasoning effort.

| Model | Seeded regression outside the diff | In the diff | Other confirmed | Review | Input tokens | Reasoning tokens | Searches |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-luna (default) | 0 of 2 | 2 of 2 | 0 | 130 s | 0.55–0.64 M | 3.9–5.4 K | 28–31 |
| gpt-6-luna (default) | 0 of 2 | 2 of 2 | 0 | 65–75 s | 0.24–0.27 M | 0.2–0.4 K | 5 |
| gpt-6-luna#high | 0 of 2 | 2 of 2 | 0 | 125–150 s | 0.58–0.79 M | 4.7–4.9 K | 25–27 |
| gpt-6.1-sol (default) | 2 of 2 | 2 of 2 | 3, the same in both runs | 261–306 s | 1.47–1.53 M | 2.1–2.3 K | 49–60 |

- gpt-6.1-sol searched for `MutableSequence` in both runs and explained the
  defect: the bare type is mapped to the sequence schema while the
  parameterized one uses the list schema the new test expects. Its suggested
  fix is the upstream fix.
- Its three other confirmed findings: validation JSON Schemas take the
  serialization temporal format (fixed upstream later in pydantic #13711);
  chained length constraints in the experimental pipeline now overwrite each
  other (the PR dropped the extra length check); and JSON Schema generation
  ignores the core schemas that the PR allows as serialization schemas (still
  so upstream). None is a false positive; the last two are debatable in
  severity.
- gpt-6-luna#high also searched for `MutableSequence` in one run and received
  the defective line next to the parameterized one, then reported no defect.
  A runtime hint would have added exactly that evidence, so the hint was not
  built: the miss is a limit of the model, and a stronger model finds the
  defect with the general tools.
- The default variant reasons little for some models (gpt-6-luna: 193 and 445
  reasoning tokens per review); `#high` raised that tenfold without finding
  the defect.
- Verification does not find what the initial reviews miss: over 21 live runs,
  59 verifier sessions decided 616 candidates and added 1 new finding.

### Diff defect

Run 1 showed `test_list.py` with HEAD lines 297–298 missing. Hunks were built
from the first and the last line of each change block, so a block longer than
the context before and after it (9 lines by default) lost its middle, and a
repeated block that reached into a hunk was cut instead of folded. In PR #4's 32
edited files, 451 of 1,111 changed lines (41 %) were not shown; reviewers
partly compensated with whole-file reads. Every changed block is now shown
whole (long hunks are still cut at 60,000 characters with a pointer to
`azpr_read_file`), a repeat that reaches into a hunk is shown in it, and a test
checks on random inputs that every changed line appears in a hunk or a folded
repeat. The corrected diffs of PR #4 are 23 % larger; run 2 still used fewer
tokens because reviewers made fewer whole-file reads. Tool arguments sent as
`null` or blank text now count as not given.

## Live A/B: filing rules in the reviewer prompts (PR #3 and PR #4, review only)

2026-10-11, OpenCode 2.0.22, api-version 7.1, `parallelSessions` 8,
`azure.concurrency` 6, `outputLanguage` zh-TW, all three review roles on one
model, nothing posted. Baselines are the runs of the sections above (prompts
of commit 56bc5d7).

Cause found before the change: with gpt-6-luna, both roles read all 25 diffs of
PR #3's shard 2 (22 policy modules), but the risk reviewer filed 4 findings and
described five more defects in `report` "because they are outside this
review's focus", and the functional reviewer filed 6 and listed 16 in `report`.
Only `findings` reach verification, so 9 of 24 defects survived; the 15 → 9
step in verification was six functional/risk duplicates merged correctly.

Prompt variants:

- v1: every concrete defect is its own finding (no maximum, one per defect and
  location); a role's focus orders attention and is not a filter; `report`
  never describes a defect; COMPLETE requires following the reading leads;
  "plan reads in few rounds" replaced by "never skip a read to save a round";
  the first verification shard checks defects described only in prose.
- v2: v1 plus "one entry per root cause" (code that is wrong once and affects
  many files or records is one finding at that code; separately wrong modules
  are separate findings).
- v3: v2 with "plan reads in few rounds" restored and the tool prohibition
  that the runtime enforces anyway removed from the prompt.
- v4: v3 without "followed the leads it raised" in the COMPLETE definition of
  the initial roles.
- v5: v4 with the scope rule "every changed file has its own reviewer: follow
  your assigned files' leads wherever they go; a defect you reach in unchanged
  code is yours to file; other changed files are context only", and "in any
  area" replaced by "of any kind".
- final (this revision): v5 without the verifier's prose check (removed after
  review, see below). gpt-6-luna and gpt-5.6-terra ran v5, gpt-5.6-luna ran
  the final revision four times (the last three with the merge-target
  checks), gpt-6.1-sol last ran v3.

PR #3 (316 files, 24 policy defects and one configuration defect):

| Model | Prompts | Policy defects | Config defect | Candidates → confirmed | Duplicate confirmations | Review | Input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-luna | old | 9 of 24 | no | 15 → 9 | 0 | 250 s | 2.85 M |
| gpt-6-luna | v1 | 24 of 24 | no | 76 → 24 | 0 | 316 s | 3.90 M |
| gpt-6-luna | v2 | 24 of 24 | no | 60 → 25 | 0 | 286 s | 3.85 M |
| gpt-6-luna | v3 (2 runs) | 24 of 24 both | 1 of 2 | 65 → 25; 64 → 42 | 0; 17 | 271–296 s | 3.49–3.68 M |
| gpt-6-luna | v4 | 24 of 24 | no | 54 → 24 | 0 | 366 s | 3.94 M |
| gpt-6-luna | v5 | 24 of 24 | no | 56 → 24 | 0 | 321 s | 3.87 M |
| gpt-5.6-luna | old (2 runs) | 24 of 24 both | yes | 69–84 → 25 | 0 | 386–431 s | 5.46–5.53 M |
| gpt-5.6-luna | v1 | 24 of 24 | yes | 200 → 48 | 23 (the config defect once per region file) | 606 s | 7.73 M |
| gpt-5.6-luna | v2 | 24 of 24 | yes | 62 → 26 | 0 | 366 s | 6.30 M |
| gpt-5.6-luna | v3 | 24 of 24 | yes | 104 → 25 | 0 | 446 s | 7.43 M |
| gpt-5.6-luna | final (4 runs) | 22 of 24 (see below); then 24 of 24 three times | yes | 53 → 23; 58 → 26; 65 → 26; 59 → 25 | 0 | 351–406 s | 5.35–6.35 M |
| gpt-5.6-terra | old | 24 of 24 | no | 101 → 24 | 0 | 566 s | 4.59 M |
| gpt-5.6-terra | v2 | 24 of 24 | no | 126 → 24 | 0 | 581 s | 6.18 M |
| gpt-5.6-terra | v3 | 24 of 24 | no | 117 → 24 | 0 | 621 s | 4.92 M |
| gpt-5.6-terra | v5 | 24 of 24 | no | 76 → 24 | 0 | 496 s | 5.33 M |

PR #4 (35 files, two seeded regressions):

| Model | Prompts | In the diff | Outside the diff | Other confirmed | Review | Input tokens |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6-luna | old (4 runs) | 3 of 4 | 0 | 0 | 65–75 s | 0.22–0.29 M |
| gpt-6-luna | v1, v2 | 0 of 2 | 0 | 0 | 65–70 s | 0.42–0.57 M |
| gpt-6-luna | v3 (2 runs) | 2 of 2 | 0 | 0 | 80 s | 0.39–0.62 M |
| gpt-6-luna | v4 | 1 of 1 | 0 | 0 | 80 s | 0.33 M |
| gpt-5.6-luna | old (2 runs) | 2 of 2 | 0 | 0 | 130 s | 0.55–0.64 M |
| gpt-5.6-luna | v1 / v2 / v3 | 1 / 0 / 1 of 1 | 0 | 0 / 1 / 0 | 120–145 s | 0.76 / 0.92 / 0.86 M |
| gpt-5.6-terra | old (2 runs) | 2 of 2 | 0 | 0 | 180–196 s | 0.69–0.82 M |
| gpt-5.6-terra | v2, v3 (3 runs) | 3 of 3 | 0 | 0 | 170–185 s | 1.01–1.05 M |
| gpt-5.6-terra | v4 (2 runs) | 2 of 2 | 0 | 0 | 186–211 s | 0.96–1.04 M |
| gpt-5.6-terra | v5 (2 runs) | 2 of 2 | 0 | 0 | 180–181 s | 0.69–0.85 M |
| gpt-6.1-sol | old (2 runs) | 2 of 2 | 2 of 2 | 2 | 261–306 s | 1.47–1.53 M |
| gpt-6.1-sol | v2 / v3 | 1 / 1 of 1 | 1 / 1 of 1 | 3 / 5 | 406 / 351 s | 3.50 / 2.14 M |

- The filing rules are what helped. gpt-6-luna's functional reviewer on PR #3's
  shard 2 filed 22 findings in two model requests after the same 25 diff reads
  that had produced 6 findings and 16 sentences of prose; all five new-prompt
  runs of gpt-6-luna on PR #3 found 24 of 24.
- "One per defect and location" made gpt-5.6-luna file the configuration
  defect once per affected region file; "one per root cause" removed those 23
  duplicates and kept the defect at `configuration.py`.
- "Never skip a read to save a round" cost tokens without a measurable gain:
  gpt-6.1-sol 1.5 → 3.5 M on PR #4 (2.1 M after the revert), gpt-5.6-terra
  6.2 → 4.9 M on PR #3 after the revert. No variant made gpt-5.6-luna or
  gpt-6-luna find the regression outside the diff.
- The prose check by the first verification shard added one finding in
  fourteen runs (v5, gpt-6-luna: a pagination defect another candidate
  already covered; the same-file duplicate check merged it). Once reviewers
  file their defects, nothing is left in prose. It was removed after review:
  its work grows with the number of initial reports, not with the shard's
  candidates, and every overflow split of the first shard (labels `1/N`,
  `1/Na`, ...) repeats the same sweep, so an overflow during it would leave
  that shard's candidates UNREVIEWED, and a shard without candidates cannot
  split at all.
- gpt-5.6-terra had no filing problem with the old prompts (both roles filed
  all 22 defects of shard 2) and gains nothing measurable: 24 of 24 and the
  regression inside the diff with every prompt set, the configuration defect
  and the regression outside the diff with none. v3 cost it 7 % more input on
  PR #3 and about 35 % more on PR #4: the sessions assigned the test files
  read and reviewed the implementation of other shards ("in any area"). v4
  changed nothing for it; the scope rule of v5 brought PR #4 back to the old
  0.69–0.85 M and PR #3 candidates from 117 to 76 (verification shards 9 → 6,
  496 s), with input inside the run-to-run spread of the old prompts
  (4.6–5.3 M).
- For gpt-6-luna, "followed the leads it raised" was what made its PR #4
  sessions read more (0.39–0.62 M → 0.33 M without it); PR #3 stayed at
  24 of 24 in v4 and v5. Its PR #3 reviews cost about 35 % more than with the
  old prompts (3.9 M) because they now file 24 defects instead of 9 and
  verification runs in 4–5 shards instead of 1.
- Under the scope rule a defect reaches verification two or three times
  (gpt-6-luna v5: 16 policy files with 2 candidates, 8 with 3; gpt-5.6-luna
  final: exactly 2 for all 24) instead of four, so the verifier has fewer
  same-line duplicates to merge.
- gpt-5.6-luna's final-revision run lost two defects in verification, not in
  review: both roles filed `worker_capacity` and `write_permissions`, and the
  verifier of that shard answered in 2,132 characters, merging R-2001 and
  R-2002 into F-2001 and F-2002 while listing those two under `rejected` with
  the reason "the candidate itself is a valid issue; see the F-2001
  confirmation", which it never wrote. Every assigned ID had one decision
  with a valid status and a reason, so no correction turn ran. It occurred in
  1 of 181 verification shards across all live runs; the runtime now treats a
  merge into a finding the same answer rejected as a contract problem (repair
  turn for the pair, UNREVIEWED if unresolved); a follow-up review showed the
  same gap across shards (a crowded or overflow-split file can put the pair
  in two verifiers), so the combined decisions are settled the same way with
  a warning; a verifier-added finding that survives counts as a confirmed
  target there, since the duplicate check may merge into it. Three repeat
  runs with the checks in place confirmed 24 of 24 and the configuration
  defect with no merge correction needed (58 → 26, 65 → 26 and 59 → 25;
  351–406 s; 5.4–6.1 M; the last one with a duplicate check and no false
  warning). The third run also saw the first provider
  stream interruption in these runs: the host's continuation message after a
  turn that had made tool calls is not accepted as the authorized answer, the
  shard was retried in a new session (`workflow.stageRetries`) and completed.
- Cross-shard discovery did not move with any variant: the regression outside
  PR #4's diff was found by gpt-6.1-sol with the old prompts and with v2/v3
  (4 of 4, filed from the test shard) and by no other model in any run.

### Live publication with this revision (gpt-5.6-terra)

After the earlier 25 comments on PR #3 were deleted, `/pr-review` and
`/pr-comment --publish` ran once per PR with gpt-5.6-terra on all three roles.
PR #3: 24 of 24 policy defects confirmed (57 candidates, 461 s, 4.3 M input);
24 items published, all VERIFIED on read-back (one summary, 23 inline; the
low-severity finding appears in the summary index only); a second
`--publish` reported ALREADY_PRESENT for all 24. PR #4: the regression inside
the diff confirmed (195 s, 0.6 M); 2 items VERIFIED (summary and
`json_schema.py:874`), the second `--publish` ALREADY_PRESENT for both. No
skip relied on another finding. On 2026-10-17 the maintainer inspected these
comments in the Azure DevOps web UI (the summary and 23 inline comments on
PR #3, the summary and the inline comment on PR #4) and found no problems with
their rendering or anchors.
- Risk: those same-line duplicates must be merged by the verifier.
  gpt-5.6-luna and gpt-5.6-terra merged them in every run; gpt-6-luna did in
  three of four runs and in the fourth confirmed 17 duplicates on the same
  lines (two of five verification shards merged nothing). Publishing that
  review would post two to four identical comments per line. A deterministic
  runtime merge of candidates with the same path and lines is the proposed
  fix; it is not part of this revision.
- The regression inside PR #4's diff was missed by gpt-6-luna in three
  consecutive runs around the prompt change (one of them with the old
  prompts) and found in both v3 runs, although every session had read the
  defective lines and the test asserting the opposite: model variance, not a
  prompt effect.
- The configuration defect of PR #3: gpt-5.6-luna 4 of 4 new-prompt runs,
  gpt-6-luna 1 of 4, gpt-5.6-terra 0 of 2.

## Live runs: `/pr-quick` versus `/pr-review` (2026-10-18, review only)

OpenCode 2.0.32, every review role and `models.quick.reviewer` on
`openai/gpt-6-luna` (default variant), `parallelSessions` 8,
`azure.concurrency` 6, debug on. Both modes ran twice on each PR at the same
heads, alternating quick and review, review only; nothing was posted. Time is
from the command to its receipt; requests count model requests of the review
stages; input is uncached plus cached prompt tokens from the debug stage
records.

| PR | Mode | Time | Sessions | Requests | Input (uncached + cached) | Output | Findings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | quick | 45 s / 30 s | 1 / 1 | 5 / 4 | 32 K / 25 K (8 K uncached each) | 1.5 K / 1.0 K | 3 / 2 of the 3 known defects |
| PR #2 | review | 60 s / 60 s | 3 / 3 | 13 / 12 | 87 K / 82 K (41 K / 30 K) | 2.7 K / 3.0 K | 2 / 2 of the 3 |
| PR #4, 35 files | quick | 45 s / 40 s | 2 / 2 | 8 / 5 | 206 K / 114 K (70 K / 66 K) | 2.4 K / 1.8 K | seeded regression in the diff 1 of 2; outside the diff 0 of 2 |
| PR #4 | review | 70 s / 40 s | 5 / 5 | 15 / 11 | 268 K / 203 K (133 K / 125 K) | 4.4 K / 3.1 K | in the diff 1 of 2; outside 0 of 2 |
| PR #3, 316 files | quick | 115 s / 110 s | 13 / 13 | 60 / 42 | 1.79 M / 1.38 M (0.54 M / 0.56 M) | 23 K / 22 K | 24 of 24 policy defects both times; configuration defect 0 of 2 |
| PR #3 | review | 266 s / 230 s | 31 / 30 | 135 / 106 | 4.25 M / 3.38 M (1.25 M / 1.21 M) | 60 K / 50 K | 24 of 24 both times; configuration defect 1 of 2 |

- Cost: a quick review needed 36–50 % of the review's model requests and
  34–68 % of its input (42 % on the 316-file PR, 24–53 % of the uncached
  input). Time fell to 45–63 % on the 1-file and 316-file PRs; on PR #4 one
  review without candidates verified nothing and took 40 s, like the quick runs.
- Findings: no quick or review run reported a defect outside the known ones.
  Every quick finding passed the runtime's checks (no NEEDS_INFO, no correction
  turn); the location and read checks refused nothing in these runs. Severity
  agreed across all four PR #3 runs for 23 of the 24 policy files (one review
  rated `reservation_atomicity` high, the other runs medium).
- Duplicates across shards: on PR #3 the reviewer of the shard with eight
  policy tests followed them into the policy implementations (changed files of
  another shard) and filed the same defects there, so 7 and 8 of the 32 quick
  findings repeat another finding on the same lines. Restricting where a quick
  reviewer may file is not an option: the same path finds a defect whose test
  and code are in different shards (PR #4's seeded regression outside the
  diff). One review run also kept 13 same-line duplicates that its verifiers
  did not merge (38 confirmed findings for 25 defects); the other merged all
  of them. Single-shard PRs cannot produce cross-shard duplicates.
- Comment preview of a quick PR #4 review: the summary's disclosure line read
  "AI 審查，非人工審查或核准。審查方式：快速審查，未經獨立驗證。模型：" followed by
  the model ID, with the usual index and marker; the planner skipped the inline
  comment because thread 235 (the earlier publication) already covers the
  issue. Nothing was posted.
- Two runs per mode show how much both vary (the 1-file PR: 2 or 3 of 3; PR
  #4's seeded regression in the diff: 1 of 2 in each mode); they do not
  establish a quality difference.

After combining cross-shard duplicates in comment planning was added, two
more quick runs of PR #3 with a comment preview (nothing posted):

| Run | Review | Candidate pairs | Planning | Inline comments | Skipped |
| --- | --- | --- | --- | --- | --- |
| 1 | 160 s, 73 requests | 7 | 9 sessions, 12 requests (two correction turns on one page) | 1 | 31 |
| 2 | 120 s, 51 requests | 0 | 8 sessions, 9 requests | 2 | 30 |

- No combination was made, for two reasons outside the combination rules.
  PR #3 still carries the 24 comments published on 2026-10-11 (threads
  211–233, kept on purpose), and the planner skipped both members of every
  candidate pair because one of those threads already discusses the defect.
  In run 2 the reviewer of the shard with the policy tests located its eight
  findings on the line of a region file that enables each policy instead of
  the policy implementation, so they were in another file than their
  repeats and no candidate. The combination path is therefore covered by
  the offline and host fixtures only; a live check needs a multi-shard PR
  without earlier comments.
- Run 2's eight misplaced findings passed the runtime's checks (the file
  exists, the lines are in range, the session read it): the checks cannot
  tell that a location is the wrong place for a defect. The planner refused
  to anchor four of them on a region file, and the other four duplicate
  existing threads; in a summary index they would show the region file as
  their location. A verifier corrects such locations; a quick review does not.
- Run 1 reported one finding outside the known defects (a region route's
  fallback that differs from its destination), which is unverified. Its
  inline comment was refused after two correction turns because the planner
  quoted lines that are not in the file, so it would appear only in the
  summary index.

Two changes followed: the quick prompts now say to file a defect the
reviewer's files lead it to at that other changed file's defective lines (a
configuration entry, test or caller that only uses the code is evidence, not
the location), and the 24 earlier comments on PR #3 were deleted so that
existing threads no longer cover its defects. Three more quick runs with a
comment preview, nothing posted:

| Run | Review | Findings | Candidate pairs | Combined | Inline comments | Planning |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 130 s, 53 requests | 33: 24 of 24 policy defects and one unconfirmed region-fallback claim | 8 | 6 | 27 | 9 sessions, 10 requests, one correction turn |
| 2 | 120 s, 50 requests | 35: 24 of 24 | 9 | 9 | 25 | 9 sessions, 9 requests |
| 3 | 110 s, 63 requests | 32: 24 of 24 | 8 | 8 | 23 | 8 sessions, 9 requests, one correction turn |

- No finding sat on a line that only uses the defective code.
- 23 of 25 candidate pairs became one comment. In run 1 the planner kept two
  pairs apart, which the prompt allows when it is unsure, so those defects
  would each get two comments. The correction turns added a missing
  `mergeReason`. A combined comment keeps the usual layout and disclosure;
  the summary index lists its IDs in one row, and the counts follow the rows
  (run 3: 32 findings, 24 rows).
- Planning used one request per page of four findings, as without
  candidates: 8–9 sessions and 9–10 requests for 32–35 findings.
- The region-fallback claim (one of these three runs, and one run before) is
  not a planted defect, and neither review run reported it; it is
  unconfirmed.

## Live runs: three modes on main and the quick follow-up (2026-10-18, review only)

OpenCode 2.0.32, every role on `openai/gpt-6-luna`, `parallelSessions` 8,
debug on, nothing posted. Time is from the run's start to its end in the debug
records (without `/pr-check`); input is uncached plus cached prompt tokens.

Main at `33fb851` (the merged `/pr-quick`): quick and review twice per PR (the
first run of each followed by a comment preview), deep once.

| PR | Quick | Review | Deep |
| --- | --- | --- | --- |
| PR #2, 1 file | 34–36 s, 4 requests, 26–27 K input | 64–71 s, 12–13, 82–88 K | 68 s, 11, 77 K |
| PR #4, 35 files | 26–47 s, 4–7, 68–178 K | 60–62 s, 13, 203–212 K | 79 s, 18, 383 K |
| PR #3, 316 files | 119–151 s, 57–58, 2.07–2.18 M | 241–274 s, 127–147, 3.90–4.82 M | 245 s, 142, 4.44 M |

- Comment planning on PR #3: after quick 169 s, 10 sessions, 136 K input, 24
  inline comments (15 of them combined); after review 161 s, 8 sessions,
  162 K, 26 inline comments. On PR #2 and PR #4 existing threads already
  covered every finding (5–8 s).
- Planted defects: PR #3 policies quick 24 and 23, review 24 and 24, deep 24;
  its configuration defect quick 0 of 2, review 1 of 2, deep 0 of 1; PR #4's
  seeded regression in the diff quick 1 of 2, review 2 of 2, deep 1 of 1, the
  one outside the diff in no run.
- In the second PR #4 quick run the reviewer of the 25-file shard read the 25
  diffs in one request and answered PARTIAL in the next ("callers, related
  tests and function context not read") without a tool error, truncation or
  limit; the run reported incomplete coverage and no finding. In all recorded
  PR #4 initial sessions since 2026-10-11, those that answered after two
  requests found the seeded regression in 2 of 24, the others in 85 of 144. On
  PR #3, whose planted defects are visible in the diff, two-request sessions
  found all of theirs.

This revision adds the quick follow-up (a usable PARTIAL answer that names
unfinished work gets one more turn in the same session). The two AZPR comments
on PR #4 were deleted first (one described the seeded regression; earlier
quick runs had not read threads). Ten PR #4 and two PR #3 quick runs each: A
is this revision, B adds one sentence to `quick.md` ("If a check you need is
unfinished and the source it needs is readable with AZPR's tools, continue it
before you answer; if a limit remains, keep PARTIAL and state it in
coverage.gaps.").

| | PR #4 A | PR #4 B | PR #3 A | PR #3 B |
| --- | --- | --- | --- | --- |
| Time (mean) | 40 s | 45 s | 156 s | 116 s |
| Requests (mean) | 5.3 | 6.5 | 73 | 61 |
| Input (mean, uncached) | 124 K (55 K) | 170 K (64 K) | 2.22 M (0.62 M) | 2.27 M (0.58 M) |
| Sessions with at most two requests | 11 of 20 | 7 of 20 | 0 of 26 | 3 of 26 |
| Planted defects | regression 7 of 10 | 8 of 10 | policies 24, 22; configuration 0 of 2 | 24, 24; 0 of 2 |
| PARTIAL answers and follow-ups | 0 | 0 | 0 | 0 |

- No reviewer answered PARTIAL in these 24 runs, so the follow-up never ran
  live; its behaviour rests on the offline and exact-host tests.
- With B the reviewer of PR #4's first shard read past the diffs in every run
  (A: two runs answered after two requests), for 37% more input on PR #4 and
  about the same on PR #3, where B had more two-request sessions. One more
  regression hit in ten runs is within run-to-run variation (one A run on PR
  #3 spent 30 requests in one shard). B is not part of this revision.

## Live runs: skip causes and page-scoped planning input (2026-10-18, preview only)

Same setup. The AZPR comments on PR #2 and PR #4 were deleted first (PR #3 had
none), so every PR's planning writes real comments; nothing was posted. One
quick and one review run per PR with a comment preview, compared with the
preview runs on `33fb851` above (PR #2 and PR #4 skipped every finding there
because earlier threads covered them).

| PR #3 planning | `33fb851` quick | this revision quick | `33fb851` review | this revision review |
| --- | --- | --- | --- | --- |
| Payload per page (mean) | 27.8 K characters | 11.0 K | 27.8 K | 11.1 K |
| Input (uncached + cached) | 136 K (93 K + 43 K) | 67 K (44 K + 23 K) | 162 K (86 K + 76 K) | 80 K (38 K + 42 K) |
| Time | 169 s | 140 s | 161 s | 163 s |
| Sessions, requests, correction turns | 10, 12, 3 | 9, 9, 0 | 8, 13, 1 | 9, 11, 0 |
| Inline comments | 24 (15 combined, 15 candidate pairs) | 24 (10 combined, 10 pairs) | 26 of 30 findings | 33 of 34 |
| Skips | none | 1 `low-severity` | 2 low, 2 "no source passage" with the file in the page | 1 `low-severity` |

- The page-scoped lists halved planning input on the 316-file PR; time did not
  follow the input, since a page's time goes to writing its answer.
- Every planner skip named a valid cause and none needed a correction turn. No
  planner claimed missing source this time, so the cause check did not trigger
  live; the offline tests and the planning test cover it.
- Every candidate pair of the quick runs became one comment, as before.
- PR #2 now gets its three comments in either mode (18 s of planning); PR #4's
  review gets one, and its quick run had no finding to plan.

## Live runs: gpt-6.1-sol on the old and new revision (2026-10-18, preview only)

OpenCode 2.0.32, every role on `openai/gpt-6.1-sol` (default variant), the
same settings, no AZPR comments on the three PRs, nothing posted. Each PR ran
`/pr-quick`, `/pr-review` and `/pr-deep` once on `33fb851` (old) and once on
this revision (new), each followed by a comment preview; old and new were
installed alternately per PR. Cost is the API equivalent at OpenAI's Standard
prices (gpt-6.1-sol $2.00 input, $0.10 cached input, $10.00 output per million
tokens; gpt-6-luna $0.10, $0.01, $0.50; reasoning counted as output); the
ChatGPT sign-in the runs used reports no cost. Every reported finding outside
the planted defects was checked against the source at both commits.

| PR | Mode | Review time (old / new) | Review input | Review cost | Planning (old / new) | Findings |
| --- | --- | --- | --- | --- | --- | --- |
| PR #2 | quick / review / deep | 42 / 43 s, 99 / 100 s, 93 / 93 s | 25 K, 85 K, 87 K | $0.04, $0.13, $0.11–0.13 | 23–24 s, 6 K input | the 3 known defects in every run |
| PR #4 | quick | 132 / 155 s | 0.61 / 1.11 M | $0.41 / $0.52 | 45 s, 15–16 K | both seeded regressions in every run, plus 1–2 confirmed and 1 debatable defect |
| PR #4 | review | 260 / 310 s | 1.74 / 1.87 M | $1.09 / $1.11 | 50 / 54 s | both seeds, plus 3 confirmed and 1–2 debatable |
| PR #4 | deep | 270 / 332 s | 1.82 / 2.25 M | $1.12 / $1.21 | 48 / 57 s | both seeds, plus 1–3 confirmed and 1–2 debatable |
| PR #3 | quick | 191 / 198 s | 2.06 / 2.12 M | $1.75 / $1.79 | 219 / 218 s, 153 / 97 K | 24 of 24 policies (50 findings, planned as 24 comments); configuration 0 |
| PR #3 | review | 355 / 382 s | 4.22 / 4.51 M | $3.81 / $3.84 | 156 / 150 s, 76 / 47 K | 24 of 24 (24 findings); configuration 0 |
| PR #3 | deep | 390 / 371 s | 4.58 / 4.62 M | $4.05 / $3.91 | 154 / 153 s, 82 / 47 K | 24 of 24 (24 findings); configuration 0 |

- Accuracy: none of the 250 reported findings was false. On PR #4 the model
  also found five real regressions of the PR besides the seeds (chained
  pipeline constraints overwrite each other, a case transform exceeds
  max_length, nested serialization schemas disagree with the JSON schema, a
  PEP 585 generic alias skips `__get_pydantic_core_schema__`, a resolved `Self`
  keeps a stale origin) and two real but debatable changes (validation-mode
  schemas follow `ser_json_temporal`, model ser schemas use the prebuilt
  serializer). No verifier rejected a planted or known defect. gpt-6-luna on
  the same day never found PR #4's second seed, reported two false PR #3
  findings on test files (in review and deep) and had one review reject a
  known PR #2 defect.
- Cost and time: each version's nine runs cost about $13.4 with planning
  (luna: under $0.6), a PR #3 review about $3.8 (luna $0.17–0.19). The input
  volume was close to luna's; time was 1.3–1.6 times luna's on PR #2 and PR #3
  and 3–5 times on PR #4, where the model read more (13–41 requests against
  4–18).
- Old against new: the review stages did not differ beyond run-to-run
  variation and no PARTIAL answer occurred, so no follow-up ran. Planning input
  fell by 37–43 % on PR #3 (planning time unchanged), every skip of the new
  revision named a cause (`low-severity`) and none needed a correction turn.

## Live runs: planning two pages at a time (2026-10-19, preview only)

OpenCode 2.0.32, every role on `openai/gpt-6-luna`, nothing posted. Three
saved reviews were planned again with `/pr-comment <review-id>`, which gives
every run the same findings, report and source: two of PR #3 (a quick review
with 35 findings and a review with 34, nine pages each) and one of PR #4 (a
review with 7 findings, two pages). `03fcf8a` (pages one at a time, with
`priorPages`) planned each once; this revision planned each once with
`workflow.parallelSessions` 1 (one page at a time, no `priorPages`) and twice
with the usual 8 (two pages at a time).

| Planning time | `03fcf8a` | this revision, one at a time | this revision, two at a time |
| --- | --- | --- | --- |
| PR #3 quick, 9 pages | 141 s (140 s on 2026-10-18) | 157 s | 76 s, 71 s |
| PR #3 review, 9 pages | 175 s (163 s on 2026-10-18) | 161 s | 90 s, 86 s |
| PR #4 review, 2 pages | 48 s | 47 s | 28 s, 27 s |

- Two pages at a time halved planning on the nine-page plans and cut the
  two-page plan by 42 %. Every two-lane run had two planner sessions in flight
  and never more; with `parallelSessions` 1 the pages ran one at a time, and
  removing `priorPages` alone did not change the time.
- Every two-lane run finished pages out of order (page 2 before page 1, page 4
  before page 3, page 8 before page 7). Rebuilding each plan offline from its
  pages in page order reproduced the saved plan exactly (every finding's
  marker, the comment texts and the summary) for all 14 plans compared,
  including the earlier ones.
- Every finding got the same decision (comment or skip, with the same cause)
  in all plans of a review. Anchor lines agreed on 34 of 34 PR #3 quick
  comments in every pair of plans and on 31–33 of 33 review comments; on PR #4
  the planner chose different lines for 1–5 of 7 comments between any two
  plans, including the two two-lane runs (4 of 7 equal), so this is the
  planner's own variation. The quick plans combined the same 10 candidate
  pairs in the two runs of `03fcf8a` and both two-lane runs; the one-lane run
  combined 6: it left apart the two pairs of page 4 and those of page 1, whose
  input carries nothing from other pages in either version.
- The first page wrote the summary note in every plan; no other page wrote one,
  so the runtime never had to drop one. One correction turn occurred, in the
  one-lane quick run (a page left a finding unaccounted).
- Input and output stayed at 63–80 K and 6–8 K tokens per PR #3 plan. The
  cached share of the input rose from 29–34 % in the first runs to 84–100 % in
  the two-lane runs because the same pages had just been planned, not because
  of the lanes.
- End to end on this revision, a new `/pr-quick` of PR #3 was COMPLETE in
  255 s and its preview planned 8 pages in 62 s (24 inline comments, 6 of them
  combined pairs); a new `/pr-review` was COMPLETE in 223 s and its preview
  planned 8 pages in 80 s (29 inline comments; one correction turn for a skip
  that relied on another finding, after which the planner commented on it).
  Both finished pages out of order and rebuilt exactly. On 2026-10-18 the same
  PR's previews had planned 9 pages in 140 s (quick) and 163 s (review).

## Deep versus review (2026-10-19)

No new runs: this compares the 2026-10-18 runs above. Until this revision a
deep agent's system prompt was the review agent's plus `deep.md` (854
characters, the same text for all four roles) asking for more scrutiny; most of
it restated `common.md`, `functional.md`, `risk.md` and `final.md`. Stages,
inputs, tools, shards and correction turns were already the same. gpt-6-luna
ran `/pr-review` five times per PR (twice on the `/pr-quick` branch, twice on
`33fb851`, once on the following revision) and `/pr-deep` once on `33fb851`;
gpt-6.1-sol ran each twice.

| PR | gpt-6-luna review | gpt-6-luna deep | gpt-6.1-sol review | gpt-6.1-sol deep |
| --- | --- | --- | --- | --- |
| PR #2, 1 file | 57–75 s, 82–93 K input; the 3 known defects in 2 runs, 2 of them in 3 (one rejected by the verifier) | 68 s, 77 K; all 3 | 99–100 s, 85–86 K; all 3 | 93 s, 87–88 K; all 3 |
| PR #4, 35 files | 37–68 s, 203–278 K; seeded regression in the diff 4 of 5, outside the diff 0 of 5 | 79 s, 383 K; in the diff only | 260–310 s, 1.74–1.87 M; both, plus 3 other real regressions in each run | 270–332 s, 1.82–2.25 M; both, plus 1 and 3 |
| PR #3, 316 files | 226–289 s, 3.38–4.82 M; policies 24 of 24, configuration 2 of 5, one false finding in five runs | 245 s, 4.44 M; 24 of 24, no configuration, one false finding | 355–382 s, 4.22–4.51 M; 24 of 24 | 371–390 s, 4.58–4.62 M; 24 of 24 |

- The deep text changed what gpt-6-luna read on PR #4, not what it found: the
  review's functional and risk sessions read the 35 diffs with 0–5 whole files
  and 0–3 searches, while deep's functional reviewer searched 10 times and its
  risk reviewer read 7 files and searched 8 times (8 requests against 4–5).
  That cost 38–89 % more input, and the regression outside the diff stayed
  missed. On PR #2 and PR #3 deep stayed within the review's run-to-run range.
- gpt-6.1-sol already reads past the diffs in a review, and deep made no
  difference beyond run-to-run variation (on PR #3 about 5 % more input).
- What changed results was the model: on 2026-10-18 gpt-6.1-sol found both
  seeded regressions in all six of its runs (quick, review and deep), while
  gpt-6-luna never found the one outside the diff, nor did it with high
  reasoning effort earlier (see the model runs above).

This revision drops `deep.md`: `/pr-deep` runs exactly the review's system
prompts with the models of `models.deep`, so the gpt-6.1-sol review runs above
describe a deep review with that model. Since the models are the only
difference, `models.deep` is for stronger models than `models.review`; with the
same models `/pr-deep` repeats `/pr-review`.

Live check of this revision (2026-10-19, `models.deep` on gpt-6.1-sol, review
and quick on gpt-6-luna, previews only): `/pr-check` was READY and listed the
deep models as checked; every deep stage's system prompt was the review
prompt byte for byte.

| PR | Review | Input (cached) | API cost | Findings | Preview |
| --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | COMPLETE, 86 s, 12 requests | 86 K (58 %) | $0.12 | the 3 known defects | 3 inline comments, 22 s |
| PR #4, 35 files | COMPLETE, 351 s, 41 requests | 2.29 M (83 %) | $1.22 | both seeded regressions, two findings on another real one (chained pipeline constraints) and two debatable ones; none false | 1 inline comment; 5 findings skipped because threads of an earlier publication covered them, 21 s |

No stage was retried, failed, stopped idle or hit a tool error; one PR #4
reviewer answer repeated a JSON key and was fixed in its correction turn.

## Live runs: the three modes after the deep change (2026-10-19, preview only)

Two batches on OpenCode 2.0.32 with `workflow.parallelSessions` 8 and
`azure.concurrency` 6, each review followed by a comment preview; nothing was
posted. `d7cd0ac` ran `/pr-quick` and `/pr-review` with every role on
`openai/gpt-6-luna`; `e673889` ran all three modes, `/pr-deep` with
`openai/gpt-6.1-sol` in `models.deep`. Later revisions changed only how the PAT
is read. The `e673889` batch:

| PR | Mode (model) | Review | Sessions / requests | Input (cached) | API cost | Findings | Preview (inline) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | quick (luna) | COMPLETE, 37 s | 1 / 5 | 32 K (70 %) | < $0.01 | the 3 known defects | 18 s (3) |
| | review (luna) | COMPLETE, 84 s | 3 / 15, 2 corrections | 115 K (66 %) | $0.01 | 2 of the 3; the verifier rejected the partial reservation with a reason that confirms it | 22 s (3) |
| | deep (sol) | COMPLETE, 100 s | 3 / 12 | 86 K (64 %) | $0.11 | the 3 known defects | 22 s (3) |
| PR #4, 35 files | quick (luna) | COMPLETE, 47 s | 2 / 9 | 240 K (70 %) | $0.01 | the seeded regression in the diff only | 10 s (1) |
| | review (luna) | COMPLETE, 58 s | 5 / 14 | 342 K (64 %) | $0.02 | no candidate for either seeded regression | 3 s (0) |
| | deep (sol) | COMPLETE, 249 s | 5 / 36 | 1.61 M (78 %) | $1.07 | both seeded regressions, 2 other real ones, 1 debatable, none false | 32 s (5) |
| PR #3, 316 files | quick (luna) | COMPLETE, 107 s | 13 / 53 | 1.91 M (67 %) | $0.09 | policies 24 of 24, not the configuration defect, nothing else | 56 s (25) |
| | review (luna) | COMPLETE, 239 s | 31 / 143 | 4.60 M (71 %) | $0.19 | 24 of 24 (one rejected candidate was covered by another), not the configuration defect, nothing else | 51 s (23; 1 low skipped) |
| | deep (sol) | COMPLETE, 394 s | 32 / 145 | 4.51 M (70 %) | $3.80 | 24 of 24, not the configuration defect, nothing else | 75 s (24) |

- Execution: the 18 runs of this batch (nine reviews, nine previews) had no
  AZPR retry, failed stage, inactivity stop, PARTIAL answer (so no quick
  follow-up), tool error or timeout, blocked native tool, Azure DevOps retry or
  warning, and every session was confirmed stopped. The only correction turns
  were two for the PR #2 luna verifier: it merged a duplicate into a finding it
  had rejected, then confirmed that finding without its fields. When the eight
  gpt-6.1-sol functional shards of PR #3 started together, OpenCode resent each
  first request once after about 2 s; no stage needed a second attempt.
- All nine plans rebuilt exactly from their pages in page order; four had
  finished pages out of order.
- The `d7cd0ac` batch (12 runs) was as clean, without a correction turn. PR #2
  had the 3 known defects and PR #3 24 of 24 in both modes. On PR #4 quick
  found the seeded regression in the diff; in the review the risk reviewer
  found it too, but the verifier rejected it with a reason ending "so the
  candidate's claim does in fact hold". PR #3's 8–9 planning pages took
  71–72 s (140–175 s one page at a time on 2026-10-18).
- The `e673889` batch took 12.2 minutes and $0.33 API-equivalent for the six
  luna runs (reviews and previews), and 14.5 minutes and $5.19 for the three
  sol runs, $0.20 of it planning.
- Prompt cache: the 316-file PR read 67–71 % of its input from the cache in
  all three modes (11–21 % on OpenCode 2.0.22).

## PAT scopes and `azure.patFile` (2026-10-21)

A new PAT for the test organization, organization-scoped with an expiry and only
**Code (Read)** and **Pull Request Threads (Read & write)**, replaced the earlier
token on OpenCode 2.0.32 with `e673889` installed.

- Reads: `/pr-check` was READY on PR #2 (PR metadata, changed files, HEAD and
  BASE reads, 164 threads), and `/pr-quick` with a comment preview was COMPLETE
  (PR, iterations, changes, commits, files and a folder listing). The repository
  archive that content search downloads answered HTTP 200 with a zip.
- Write: thread creation, the only Azure DevOps write AZPR makes, answered
  HTTP 200 on the same PR; the comment read back and was then deleted, which
  the same scope allows. `/pr-comment --publish` could not show the write on
  that PR: AZPR records each thread it created by marker and never sends that
  marker again, and the PR's earlier AZPR comments had been deleted by hand, so
  all four items stayed UNVERIFIED without a request.
- `azure.patFile`: with this revision installed, `settings.json` set `pat` to
  empty and `patFile` to the PAT file (mode 600). `/pr-check` was READY and
  showed "PAT from azure.patFile" without the path, `/pr-quick` with a preview
  was COMPLETE, and a scan of the configuration, state and OpenCode data
  directories found the PAT only in that file.
- An external review found that a FIFO named by `azure.patFile` made opening it
  wait for a writer, so loading hung (even process exit waited for the blocked
  thread). Opened without blocking, a FIFO is now refused in 5 ms under
  OpenCode's Bun 1.4.2 and 7 ms under Node 22, and `/pr-check` with the PAT
  file stayed READY on OpenCode 2.0.32.

## Verifier decisions on known defects (debug records, 2026-10-10 to 2026-10-19)

The saved results and debug records of the 108 review and deep reviews of the
three test PRs, earlier revisions included, were checked offline: for every
functional or risk candidate that matches a known defect, the verifier's
decision, and whether the defect was still among the publishable findings
afterwards.

| Verifier | Reviews | Known defects among the candidates | Lost at verification |
| --- | --- | --- | --- |
| gpt-6-luna | 48 | 423 | 3, in 3 reviews |
| gpt-6.1-sol | 21 | 158 | none |
| gpt-5.6-luna | 22 | 373 | 2, in 1 review |
| gpt-5.6-terra | 15 | 135 | 5, in 5 reviews |

- gpt-6-luna lost PR #2's partial reservation in 2 of 14 reviews and PR #4's
  regression in the diff in 1 of 18, and none of 371 on PR #3. In two of the
  three the rejection's own reason establishes the defect ("so the candidate's
  claim does in fact hold"; "contradicts the README's contract that a rejected
  batch leaves stock and history unchanged"): the answer filed a defect it had
  checked under `rejected`. In the third the verifier described the base's
  validate-then-deduct order as the head's. All three came from the first
  answer, not from a correction turn. Two reviews with gpt-6-luna#high lost
  none.
- gpt-5.6-luna lost two policies in one review: it rejected two candidates as
  "a valid issue; see the confirmed item with the same root cause" and merged
  their duplicates into them. A merge into a rejected finding now gets a
  correction turn.
- gpt-5.6-terra rejected the configuration defect in all five reviews whose
  reviewers found it, each time because no code reads the routing settings the
  change drops, so no failure is reachable: a stricter bar for evidence, not a
  contradiction.

### A stronger verifier behind gpt-6-luna reviewers (2026-10-22, review only)

OpenCode 2.0.32 with this revision; `models.deep` held gpt-6-luna functional
and risk reviewers and a gpt-6.1-sol verifier, so `/pr-deep` ran the review
with only the verifier changed, alternating with `/pr-review` on gpt-6-luna.
All 28 reviews were COMPLETE; nothing was posted.

| PR | Verifier | Reviews | Review | API cost per review (verifier) | Known defects kept | Correction turns |
| --- | --- | --- | --- | --- | --- | --- |
| PR #2, 1 file | gpt-6-luna | 8 | 58–82 s | $0.006 ($0.002) | all 3 in 7 runs; in the 8th no reviewer proposed the partial reservation | 1 |
| | gpt-6.1-sol | 8 | 75–88 s | $0.049 ($0.046) | all 3 in all 8 | none |
| PR #4, 35 files | gpt-6-luna | 4 | 41–69 s | $0.016 ($0.002) | the regression in the diff in 2 | none |
| | gpt-6.1-sol | 4 | 39–95 s | $0.065 ($0.050) | the regression in the diff in 3 | none |
| PR #3, 316 files | gpt-6-luna | 2 | 245–300 s | $0.19 ($0.02) | policies 24 of 24 | 3 |
| | gpt-6.1-sol | 2 | 266–335 s | $0.66 ($0.41) | policies 24 of 24 | none |

- Neither verifier lost a known defect this time. The gpt-6-luna verifier once
  more rejected PR #2's partial reservation with a reason saying that it should
  not be rejected; a duplicate candidate that it confirmed kept the defect. The
  gpt-6.1-sol verifier rejected no known defect; on PR #3 it rightly rejected a
  luna candidate claiming that schema-1 routes lose their retry fields.
- The PR #4 difference came from the reviewers: in the other runs no candidate
  named the regression in the diff. Neither combination found the one outside
  the diff.
- The gpt-6.1-sol verifier cost 8, 4 and 3.4 times the luna review on the
  three PRs and added 9–29 s; a gpt-6.1-sol deep review costs $0.11, $1.07 and
  $3.80 there.

With the debug records above, the gpt-6-luna verifier lost 3 known defects in
62 reviews and the gpt-6.1-sol verifier none in 35. A stronger model in
`models.review.verifier` keeps more of what the reviewers find at a few times
the luna cost; it does not change what they find.

## Live publication with this revision (2026-10-22)

OpenCode 2.0.32 with this revision, gpt-6-luna for review and quick.

- PR #3, 316 files: `/pr-review` was COMPLETE in 271 s (policies 24 of 24;
  66 candidates, 24 publishable; $0.18 API-equivalent). `/pr-comment
  --publish` planned 6 pages in 67 s without a correction turn and posted the
  summary and 23 inline comments, all VERIFIED; the one low finding went to
  the summary index. No skip relied on another finding (the correction turn
  for one was seen live in a preview on 2026-10-19). A second publish found
  all 24 ALREADY_PRESENT.
- Deleting three of those inline comments in Azure DevOps left their threads
  listed, flagged deleted, with the comments flagged deleted and without
  content. The next publish was POSTED with 21 ALREADY_PRESENT and 3 DELETED,
  using four GET requests and no write.
- PR #2, 1 file: a `/pr-quick` (35 s) planned exactly the four items that AZPR
  had posted there on 2026-10-11 and that were later deleted by hand; on
  2026-10-21 publishing them had given four UNVERIFIED items and FAILED. This
  revision reported four DELETED items, the receipt POSTED, with four GET
  requests and no write. With that PR's publication record moved aside, the
  same quick review then posted its summary and three inline comments, all
  VERIFIED and each naming the quick method in its disclosure line; a second
  publish found all four ALREADY_PRESENT.
- PR #4: two quick reviews (25 and 34 s) reported no finding, so nothing was
  posted there.

## Reviewer rounds and session cleanup (debug records, offline tests)

A stability review proposed batch parameters for `azpr_read_diff` and
`azpr_read_file`, because one gpt-6-luna session under the earlier prompts had
made 28 model requests with about one tool call each. The debug records of all
133 live runs above show that this was an outlier: reviewers already batch by
making several tool calls in one response. With the final prompts:

| Model | Sessions | Model requests per session (most) | Tool calls per round |
| --- | ---: | ---: | ---: |
| gpt-5.6-luna | 123 | 5.4 (10) | 10.5 |
| gpt-5.6-terra | 78 | 4.4 (6) | 12.2 |
| gpt-6-luna | 30 | 4.4 (9) | 9.3 |

The first round reads every assigned diff at once (25 in a full shard); later
rounds follow leads that depend on what was read. gpt-6-luna makes 29 of its 71
later rounds with a single call, so a batch parameter could save it about one
request per session at most. Batch parameters were not added. The comment
planner's forced final answer (tools removed and an instruction added after 12
requests) never triggered in 21 live planning sessions (18 needed one request,
the most was 9), so its effect on prompt caching was left as is. Only 1 of
those 21 sessions returned CONTINUE (an early revision that made the planner
read the PR threads; a second session finished the page). A page now gets at
most three continuation sessions, so a planner that keeps reading without
finishing cannot open sessions without end; an offline test shows the fourth
session ending the page while the next page is planned as usual. Cache reads
stay at 11–21 % of input in these runs; see the roadmap.

Reviewer sessions of an evicted review or an unfinished run are now deleted
eight at a time, each deletion still limited to five seconds. A host that
stalls on deletion delays the receipt by one limit per eight sessions instead
of one per session: about 20 s instead of 2.5 minutes for the 30 sessions of a
PR #3 review. An offline test uses a host that never confirms a deletion.

## Host retries and stage inactivity (OpenCode 2.0.22, debug records)

A stability review asked whether OpenCode's own retry of a failed provider
request is refused by AZPR's `model.request` hook, which accepts a primary
request only after an authorized `context` hook, and noted that a stage could
wait without limit. Checked on 2026-10-14 in the OpenCode 2.0.22 binary, the
debug records of the live runs above and the exact-host fixture:

| Question | Observed |
| --- | --- |
| How OpenCode retries | `SessionRunner.runStep` handles a retry before any output, a continuation after partial output and a WebSocket recovery the same way: it waits, then prepares the request again, and `SessionModelRequest.prepare` triggers `context` and then `model.request`. A resend therefore always follows an authorized context. Backoff starts at 2 s and is capped at 10 s, at most 10 retries; `Retry-After` of rate-limit and provider-internal errors is honoured up to 15 minutes; transport timeouts are retried at most 3 times. |
| Host retries in live runs | 1,101 stage records of 71 live runs (2026-10-10 to 10-14): 10 stages saw a host retry (attempt 2, allowed by the `retry` hook). In each, the authorized primary requests equalled the observed ones and none was rejected; 9 completed and 1 failed for an unrelated reason (a continuation after a turn with tool calls, which is refused by design and retried in a new session). The only rejected requests, in 3 stages, were compaction requests. The stability review had counted no host retry. |
| How long OpenCode waits for a provider | An HTTP (SSE) response is aborted after 5 minutes without headers or data (`headerTimeout` and `chunkTimeout` default to 300,000 ms). OpenCode's OpenAI integration uses the WebSocket session transport by default, whose wait for data defaults to 30 minutes, and a timed-out read can be retried. |
| Normal quiet time | In the 1,097 live stages that ended normally, the longest stretch without a prompt admission, model request, tool start or end or host retry was 151 s, while a final answer was written; the 99th percentile was 120 s and the median 23 s. These stretches include answers being streamed, which count as activity too (next row), so the quiet time the watchdog sees is shorter. The 4 other stages are the 2026-10-10 run in which native `grep` calls waited for an approval for 1,688–1,813 s (such requests are refused at once since). |
| What a plugin sees while a model streams | A probe plugin on OpenCode 2.0.22, while a fixture provider streamed one chunk per second: the projected session context kept the answer text empty until the step ended and `session.get` did not change, but `event.subscribe()` delivered one `session.text.delta` event per chunk, carrying the session ID. The feed also has reasoning and tool-input deltas, tool progress and step events, and `return()` on its iterator ends the subscription at once. An external review of this revision showed why it matters: before streamed output counted as activity, an answer streaming one chunk per second through a 60 s window was stopped at 60.9 s, 0.9 s after its last chunk. AZPR now follows these events while a stage is watched. |
| Reviews without candidates | 3 of 71 runs (PR #4, gpt-6-luna) produced no candidate finding. Their verifier sessions took 6–14 s with 1–3 requests and added no finding, but they condensed the four initial reports into the report's checks and limitations; one checked and relayed a narrowed test assertion, the same advice that comment planning turned into the published PR #4 summary. Without the verifier that section would be empty or four unedited reports, so it still runs. No PR without changed files occurred; such a PR now stops before any session. |

So host retries needed no change. The watchdog's default of 600 s is four
times the longest quiet stretch observed; a stopped stage is retried like a
transient failure, and its error names the last activity.

## Not yet validated

- Automatic publication (`afterReview: publish` or `--publish` after the PR
  URL) and its safeguards with a real model and real Azure DevOps: they were
  validated with the fixture services only. The live runs of the automatic
  step used `--preview`.
- A defect whose evidence spans a test and unchanged code in different shards
  is found by gpt-6.1-sol (2 of 2 runs on PR #4) and missed by gpt-5.6-luna and
  gpt-6-luna; other PRs are not yet measured.
- Azure DevOps Server, and repository files that are not UTF-8 text.
- `azure.caFile` with a real proxy: the corporate network above ran with
  `verifyTls: false`; whether its proxy inspects TLS, and trusting its root CA
  instead, were not checked. `azure.caFile` was validated with the fixture
  proxy and CA above only. Proxies that require NTLM or Kerberos are not
  supported directly.
- The stage inactivity watchdog with a real provider: no live stall has
  occurred since it was added. It was validated with the fixture provider's
  stalled HTTP stream; a stalled OpenAI WebSocket stream was not produced on
  purpose.
- Streamed reasoning from a real reasoning model: the fixture streams answer
  text only. A model that thinks without streaming anything looks silent to
  the watchdog for that time.
- Planning more than two pages at a time (not measured), and `/pr-stop` while
  pages are planned side by side with a real provider (only the fixtures and
  offline tests cancel running pages).
- `/pr-quick` beyond these runs on three test PRs with one model: its
  false-positive rate and misses on other PRs and models, a published quick
  review of a multi-shard PR (only the 1-file PR's was posted), and combining
  duplicates on a real multi-shard PR other than the test PR.
