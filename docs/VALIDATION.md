# Validation

This page records what the current revision (branch `stability-hardening`, the
Azure DevOps REST revision) was tested with. Host integration, provider
admission, source fidelity, model quality and publication are separate claims; a
passing fixture establishes only the first. Earlier revisions and their live
acceptance runs, including the MCP-based runs, are preserved in
[validation history](VALIDATION_HISTORY.md).

## Environment

Ubuntu 22.04.5 LTS (WSL2, kernel 6.18), Node 22.23.3, OpenCode CLI 2.0.22,
Azure DevOps Services REST api-version 7.1. Date: 2026-10-10. Since
2026-10-17 the tested host is OpenCode CLI 2.0.32
([below](#opencode-2032-the-tested-host-2026-10-17)).

## Offline tests

`npm run check` and `npm test` pass: 294 tests across settings (including the
`mcp` → `azure` migration and the proxy and TLS settings), host helpers, session
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
that rely on another finding), planning and publication, review sharding,
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
| Tool scopes | An ordinary conversation's model request carried the foreign MCP tool and no `azpr_*` tool. |
| Unattended approvals | A reviewer's native `grep` on the repository path `/scale_lab` was refused with a pointer to the azpr tools (`permission.rejected`) instead of waiting; no approval request remained open. Since 2026-10-17 the fixture also greps `/etc`, an existing directory outside the project, which is refused with the same pointer on 2.0.22, 2.0.31 and 2.0.32 (see [OpenCode 2.0.32](#opencode-2032-the-tested-host-2026-10-17)). |
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
| Planning | 8 pages of at most four findings (29 findings) |
| Publication | 20 threads (19 inline, 1 summary; 10 low findings in the summary); a second publish wrote nothing |
| Largest provider request | 31,136 characters (27,185 before the duplicate rules and the diff and search tools) |
| REST calls | 74 |

## OpenCode 2.0.32, the tested host (2026-10-17)

Since 2026-10-17 the tested host is OpenCode CLI 2.0.32, the release the
user's company runs (`TESTED_HOST_VERSION` in `src/host.mjs`; CI runs the
exact-host fixtures with it), and receipts add a host notice for any other
version. Other results on this page used 2.0.22 unless noted; 2.0.31 was
checked on the way. The published 2.0.31 and 2.0.32 binaries embed Bun 1.4.2
like 2.0.22:

| Check | Observed |
| --- | --- |
| Exact-host fixtures | `host-v2-smoke.mjs` fresh and `--replace` and `host-v2-comment-scale.mjs` passed on 2.0.32 (and on 2.0.31 and 2.0.22 with the same checks): every scenario of the tables above, plus token usage in the debug stage records for every model request of the review. |
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

- A defect whose evidence spans a test and unchanged code in different shards
  is found by gpt-6.1-sol (2 of 2 runs on PR #4) and missed by gpt-5.6-luna and
  gpt-6-luna; other PRs are not yet measured.
- A live publication with this revision: the rule against skips that rely on
  another finding.
- A PAT limited to Code (Read) and Pull Request Threads (Read & write); the live
  run used an existing PAT whose scopes were not inspected.
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
- The prompt cache of a large PR on OpenCode 2.0.32: only the 1-file PR above
  was measured; on 2.0.22 the 316-file PR read 11–21% from the cache.
