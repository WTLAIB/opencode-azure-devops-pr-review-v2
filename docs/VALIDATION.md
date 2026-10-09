# Validation

This page records what the current revision (branch `stability-hardening`) was
tested with. Host integration, provider admission, source fidelity, model
quality and publication are separate claims; a passing fixture establishes only
the first. Earlier revisions and their live acceptance runs are preserved in
[validation history](VALIDATION_HISTORY.md).

## Environment

Ubuntu 22.04.5 LTS (WSL2, kernel 6.18), Node 22.23.3, OpenCode CLI 2.0.22.
Date: 2026-10-10.

## Offline tests

`npm run check` and `npm test` pass: 225 tests across settings, host helpers,
session transport, the MCP queue, the Azure client and snapshot, output
acceptance and correction prompts, comment validation and markers, planning and
publication, review sharding, persistence, rendering, installation and the
runtime integration (fake host plus fake Azure DevOps MCP).

## Exact-host fixtures

`tests/host-v2-smoke.mjs` (fresh install and `--replace`) runs the real OpenCode
2.0.22 binary with a loopback fake model provider and a stdio fake Azure DevOps
MCP with persistent thread state. Both passed:

| Scenario | Observed |
| --- | --- |
| `/pr-check` | READY with zero model requests; runtime MCP calls only. |
| `/pr-review` | COMPLETE; the verifier missed one decision and was corrected by one repair turn in the same session; `shell` and `execute` were absent from every private model request; the runtime read the snapshot and rechecked versions; PROGRESS notices reached the conversation; the review was persisted. |
| `/pr-comment` | PREVIEW, then `--publish` POSTED one summary and one inline comment with markers and file context. |
| Restart | After restarting the host, `/pr-comment --publish` returned POSTED with ALREADY_PRESENT, no new writes and no model request. |
| `/pr-stop` | A review hanging at the provider was CANCELLED. |
| Private sessions | Generate and compaction on a private session sent no provider request; ordinary generation still worked. |
| TUI | New and existing TUI sessions kept their origin and cancelled from the same TUI. |

`tests/host-v2-comment-scale.mjs` passed on the same host:

| Property | Observed |
| --- | --- |
| Changed files | 120, reviewed in 5 shards of 24 per role |
| Context overflow | One functional shard reported a nearly full context; the host attempted compaction, AZPR refused it, and the shard was split into `1/5a` and `1/5b`, both COMPLETE |
| Functional coverage | All 120 files exactly once across the remaining shards |
| Verification | 30 findings in 2 verification sessions |
| Planning | 8 pages of at most four findings |
| Publication | 21 threads (20 inline, 1 summary; 10 low findings in the summary); a second publish wrote nothing |
| Largest provider request | 25,993 characters |

## Live runs (Azure DevOps, real model)

PR kevin888y/OpenCode #2 (one changed file), `openai/gpt-5.6-luna` for all three
roles, `zh-TW`, through the user's OpenCode service with the installed package.

| Run | `/pr-check` | `/pr-review` | `/pr-comment --publish` | Second publish |
| --- | --- | --- | --- | --- |
| 1 (commit 5f23776) | NOT_READY: MCP thread read failed with an empty error | COMPLETE, 186 s; a provider transport error interrupted the verifier, which restarted its answer and needed one correction turn | POSTED 4 items, 125 s; planning took 17 model requests | INCOMPLETE: thread read failed before any write; no duplicates |
| 2 (fixes for run 1) | READY, 5 s | COMPLETE, 75 s | POSTED 4 items, 25 s; planning took 1 request and no tools | POSTED, all 4 ALREADY_PRESENT |

Both runs confirmed the same three seeded defects; inline comments landed on the
expected HEAD lines (24, 29, 37) and were read back independently through the
REST API. Run 2 used about 80,000 input tokens against 241,000 in run 1.

## Not yet validated

- Large PRs on real Azure DevOps: PR #3 (316 files) is untested. Through MCP
  2.9.0 the runtime would see only the first 100 changed files.
- Real-model behavior of correction turns, shard sizes and verifier sharding is
  unmeasured; defaults may need tuning from live evidence.
- Rendered comments and anchors in the Azure DevOps UI were not inspected.
