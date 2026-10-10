# AI development guide

This repository targets the OpenCode V2 plugin API (tested with
`@opencode/cli@2.0.22`), the Azure DevOps Services REST API (api-version 7.1)
and Ubuntu 22.04. Public source and documentation use English. Follow the user's
conversation language and current authorization scope.

## Before changing anything

Confirm the Git root, branch, HEAD, working tree and installed paths. Read
README, architecture, roadmap and the task-relevant docs. A local
`.local/HANDOVER.md`, when present, is historical context, not current state or
new authorization. Preserve unrelated changes, credentials, private settings,
backups and failure records. Never upload `.local/`.

## Design rules

**Deterministic facts are code; judgment is model work.**
- PR identity, commit SHAs, the changed-file list, version rechecks, existing
  threads and all Azure DevOps writes go through `azure.mjs`, which calls the
  REST API with `azure.organization` and `azure.pat` from AZPR's settings. Keep
  REST paths and the pinned api-version in `azure.mjs` only; never log, echo or
  persist the PAT, and send it only to the organization's REST endpoint.
- Models read the repository only through the read-only tools in
  `review-tools.mjs`, registered with `codemode: false`; private roles see an
  explicit tool allowlist and ordinary sessions never see AZPR's tools.
- Models review, verify and plan comment text. They never echo identity or SHAs
  and never write to Azure DevOps.

**Keep useful work; degrade per item.**
- Answers that break the output contract get a correction turn in the same
  session (`workflow.repairAttempts`) listing concrete problems. After that,
  degrade the affected item (UNREVIEWED, NEEDS_INFO, skipped comment) and keep the
  rest. Never discard a whole review for one bad item, and never invent a
  decision, evidence or a location.
- Transient execution failures retry once in a new session; overflow splits the
  shard. Permanent failures and cancellations are not retried.
- Only a changed source commit makes a review STALE.

**Bounded, recoverable execution.**
- All AZPR Azure DevOps traffic shares the queue in `tool-queue.mjs` (concurrency and
  per-call timeout). Release slots in `finally`; never depend on a hook running.
- Large PRs are handled by sharding, not by compaction: private sessions may not
  compact, and a compaction request means "split this shard".
- There is deliberately no default whole-run timeout and no per-stage step cap;
  see the roadmap's Deferred section before adding either.

**Authorization.**
- Only explicit commands start private sessions. Every private prompt is the
  exact runtime-pending text with a fresh nonce; private agents cannot be
  mentioned, delegated, compacted or used for auxiliary requests.
- Settings are read once; a changed file blocks new runs only. Hooks check the
  grant, not files or catalogs.
- Pin private agent definitions at first use and refuse later host changes.
- Shell for private roles follows the `shell` setting (default deny), enforced
  through the `permission` hook and by hiding the tool. Native edit, write,
  patch, delegation, web, question, session/model control and CodeMode execute
  stay denied. Allowed shell has real host authority; never call it a sandbox.
- `/pr-comment` and `/pr-stop` act only within the caller's conversation (or a
  session of that review).

**Publication is idempotent.**
- Recheck the PR (active, unchanged head) before writing; skip existing markers;
  save each result immediately; read markers back. Re-running is always safe.
- Inline markers are stable (PR, path, normalized anchor, ordinal); do not put a
  review ID or model wording into them.

**Persistence and privacy.**
- Completed reviews, plans and ledgers persist under the private state directory
  (owner-only permissions, newest 20). Clean only stale, unreferenced data.
- Diagnostics are opt-in and never record reasoning, headers or provider
  configuration.

**Compatibility.** Host response shapes and constants belong in `host.mjs`.
Detect capabilities; do not assume them.

## Verification and delivery

Run `npm run check` and `npm test`. For changes touching hooks, sessions, tools, Azure access or
publication, also run `node tests/host-v2-smoke.mjs <opencode binary>` (fresh and
`--replace`) and `node tests/host-v2-comment-scale.mjs <opencode binary>`.
Installer tests must preserve unrelated files and private settings, reject
conflicts and test rollback and archival uninstall. Keep the README manual-copy
list exact.

Fake-service fixtures and live Azure/model runs establish different claims;
record exact versions, environment and limitations in `docs/VALIDATION.md`, and
move superseded validation pages to `docs/VALIDATION_HISTORY.md` instead of
rewriting earlier results.

Do not start live models, publish PR comments, change personal settings,
upgrade installed tools or publish a repository without authorization for that
action. Authorization applies to the current request only.
