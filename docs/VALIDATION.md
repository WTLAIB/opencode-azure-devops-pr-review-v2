# Validation

This page records what the current revision (branch `stability-hardening`, the
Azure DevOps REST revision) was tested with. Host integration, provider
admission, source fidelity, model quality and publication are separate claims; a
passing fixture establishes only the first. Earlier revisions and their live
acceptance runs, including the MCP-based runs, are preserved in
[validation history](VALIDATION_HISTORY.md).

## Environment

Ubuntu 22.04.5 LTS (WSL2, kernel 6.18), Node 22.23.3, OpenCode CLI 2.0.22,
Azure DevOps Services REST api-version 7.1. Date: 2026-10-10.

## Offline tests

`npm run check` and `npm test` pass: 234 tests across settings (including the
`mcp` → `azure` migration), host helpers, session transport, the shared queue,
the REST client (change paging, merge base, error classes, retries, timeouts
that abort requests, binary and oversized files, the per-run cache, PAT never
logged), the reviewers' tools, output acceptance and correction prompts
(including verifier rows judged by their own fields and confirmations that move
a finding to another file), comment validation and markers (including skips
that rely on another finding), planning and publication, review sharding,
persistence, rendering, installation (including an output pipe closed
mid-install, which used to leave the lock and a staged copy of the previous
settings) and the runtime integration (fake host plus a fake Azure DevOps REST
service).

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
| `/pr-review` | COMPLETE; reviewers read HEAD through `azpr_read_file`; `shell`, `execute` and the foreign MCP tool were absent from every private model request; the verifier was corrected by one repair turn in the same session; the runtime read the change list and rechecked versions; PROGRESS notices reached the conversation; the review was persisted. |
| `/pr-comment` | PREVIEW, then `--publish` POSTED one summary and one inline comment with markers and file context. |
| Restart | After restarting the host, `/pr-comment --publish` returned POSTED with ALREADY_PRESENT, no new writes and no model request. |
| Tool scopes | An ordinary conversation's model request carried the foreign MCP tool and no `azpr_*` tool. |
| Unattended approvals | A reviewer's native `grep` on the repository path `/scale_lab` was refused with a pointer to the azpr tools (`permission.rejected`) instead of waiting; no approval request remained open. |
| `/pr-stop` | A review hanging at the provider was CANCELLED. |
| Private sessions | Generate and compaction on a private session sent no provider request; ordinary generation still worked. |
| TUI | New and existing TUI sessions kept their origin and cancelled from the same TUI. |

The first smoke attempt failed: AZPR's tools were registered without
`codemode: false`, so OpenCode placed them behind CodeMode `execute`, which
private reviewers may not use, and reviewers saw no AZPR tool. The tools are now
registered with `codemode: false`, and the test tool registry applies the same
rule so the offline runtime tests catch a regression.

`tests/host-v2-comment-scale.mjs` passed on the same host:

| Property | Observed |
| --- | --- |
| Changed files | 120, reviewed in 5 shards of 24 per role |
| Context overflow | One functional shard reported a nearly full context; the host attempted compaction, AZPR refused it, and the shard was split into `1/5a` and `1/5b`, both COMPLETE |
| Verification | 30 findings in 2 verification sessions |
| Planning | 8 pages of at most four findings |
| Publication | 21 threads (20 inline, 1 summary; 10 low findings in the summary); a second publish wrote nothing |
| Largest provider request | 27,911 characters (27,185 before the prompt rules on moved findings and skips) |
| REST calls | 71 |

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

## Not yet validated

- A live run of the corrections above; they are validated offline and with the
  exact-host fixtures only.
- A PAT limited to Code (Read) and Pull Request Threads (Read & write); the live
  run used an existing PAT whose scopes were not inspected.
- Azure DevOps Server, and repository files that are not UTF-8 text.
- Rendered comments and anchors in the Azure DevOps UI were not inspected.
