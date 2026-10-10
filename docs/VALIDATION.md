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

`npm run check` and `npm test` pass: 253 tests across settings (including the
`mcp` → `azure` migration), host helpers, session transport, the shared queue,
the REST client (change paging, merge base, error classes, retries, timeouts
that abort requests, binary and oversized files, the per-run cache, PAT never
logged, commit messages, the repository zip with a streaming size limit),
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
| `/pr-review` | COMPLETE; reviewers read HEAD through `azpr_read_file` and searched HEAD's file contents through `azpr_search_code` (one repository zip for the run); `shell`, `execute` and the foreign MCP tool were absent from every private model request; the verifier was corrected by one repair turn in the same session; the runtime read the change list and rechecked versions; PROGRESS notices reached the conversation; the review was persisted. |
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
| Changed files | 120, reviewed in 5 shards of 24 per role; functional reviewers read whole files, risk reviewers read diffs |
| Context overflow | One functional shard reported a nearly full context; the host attempted compaction, AZPR refused it, and the shard was split into `1/5a` and `1/5b`, both COMPLETE |
| Verification | 30 findings in 2 verification sessions; the second verifier moves one high finding into a file of the first |
| Duplicate check | One `dedupe` session for that file, which merges the moved duplicate |
| Planning | 8 pages of at most four findings (29 findings) |
| Publication | 20 threads (19 inline, 1 summary; 10 low findings in the summary); a second publish wrote nothing |
| Largest provider request | 31,136 characters (27,185 before the duplicate rules and the diff and search tools) |
| REST calls | 74 |

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

## Not yet validated

- A defect whose evidence spans a test and unchanged code in different shards
  is found by gpt-6.1-sol (2 of 2 runs on PR #4) and missed by gpt-5.6-luna and
  gpt-6-luna; other PRs are not yet measured.
- A live publication with this revision: the rule against skips that rely on
  another finding.
- A PAT limited to Code (Read) and Pull Request Threads (Read & write); the live
  run used an existing PAT whose scopes were not inspected.
- Azure DevOps Server, and repository files that are not UTF-8 text.
- Rendered comments and anchors in the Azure DevOps UI were not inspected.
