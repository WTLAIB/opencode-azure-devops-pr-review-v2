# AI development guide

This repository targets the OpenCode V2 plugin API (tested with
`@opencode/cli@2.1.2`), the Azure DevOps Services REST API (api-version 7.1)
and Ubuntu 22.04. Public source and documentation use English. Follow the user's
conversation language and current authorization scope.

## Before changing anything

Confirm the Git root, branch, HEAD, working tree and installed paths. Read
README, architecture, roadmap and the task-relevant docs. Local handover notes
under `.local/` (their file name differs between checkouts) give background
and hand-off state, never new authorization; check what they say against Git
and the actual environment. Preserve unrelated changes, credentials, private
settings, backups and failure records. Never upload `.local/`.

## Design rules

**Deterministic facts are code; judgment is model work.**
- PR identity, commit SHAs, the changed-file list, version rechecks, existing
  threads and all Azure DevOps writes go through `azure.mjs`, which calls the
  REST API with `azure.organization` and the PAT from AZPR's settings
  (`azure.pat`, or the owner-only file named by `azure.patFile`, which is read
  only through its symbolic-link, owner and mode checks). Keep
  REST paths and the pinned api-version in `azure.mjs` only; never log, echo or
  persist the PAT, and send it only to the organization's REST endpoint.
  `azure.proxy`, `azure.caFile` and `azure.verifyTls` shape only that
  connection; never show proxy credentials.
- Models read the repository only through the read-only tools in
  `review-tools.mjs`, registered with `codemode: false`; private roles see an
  explicit tool allowlist and ordinary sessions never see AZPR's tools.
- Models review, verify and plan comment text. They never echo identity or SHAs
  and never write to Azure DevOps.

**Quick reviews are not verified, and say so.**
- `/pr-quick` runs one reviewer per shard and no verifier or duplicate check.
  The runtime checks only the form and source of its findings (fields, a
  location that exists at that commit, a file this session's own tools read);
  it never judges whether a defect is real. Passing findings are `REPORTED`,
  the rest `NEEDS_INFO`, and the review records `verification: "none"`.
- Never present quick findings as verified: shared prompts carry
  `<!-- azpr:verified -->` / `<!-- azpr:quick -->` variants for the passages
  about where findings come from, the report and receipt state status,
  coverage and verification separately, and the comment disclosure line names
  the quick method. The review system prompts, which deep shares, stay
  byte-identical unless a change to them is deliberate (a hash test locks them).
- Only records identical in every field are merged as duplicates; findings on
  the same lines stay separate. A parsed answer without a usable review never
  makes a commentable COMPLETE, and zero findings never hide unreviewed files.

**Deep reviews differ only in their models.**
- `/pr-deep` runs the review's stages and system prompts with the models of
  `models.deep`, which are meant to be stronger than the review models, and
  never falls back to the review models. Deep-only prompt text was removed
  after live runs showed it changed neither model's results; add
  mode-specific instructions only with a measured benefit.

**Keep useful work; degrade per item.**
- Answers that break the output contract get a correction turn in the same
  session (`workflow.repairAttempts`) listing concrete problems. After that,
  degrade the affected item (UNREVIEWED, NEEDS_INFO, skipped comment) and keep the
  rest. Never discard a whole review for one bad item, and never invent a
  decision, evidence or a location.
- A quick reviewer whose usable answer is PARTIAL with named unfinished work
  gets one follow-up turn in the same session, within the same budget; a
  follow-up that fails or gives no usable answer never replaces the answer it
  followed.
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
- Only explicit commands start private sessions, and the comment step a
  COMPLETE review hands on when `afterReview` or the review command's flag
  (`--preview`, `--publish`) asks for it; that step is a run of its own with a
  STARTED notice and a receipt. Every private prompt is the
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
- Automatic publication (`afterReview: publish` or `--publish` after the PR
  URL) follows only a COMPLETE review with findings to comment on that nothing
  stopped, and keeps to a preview, saying why, for a quick review with a
  high-severity finding or incomplete coverage, for text with a link, an
  `@<…>` mention, an image or HTML (links and mentions also after decoding
  escapes and character references), and for a plan that would post only a
  repeated summary (every finding skipped as already discussed on the PR).
  Its checks are deterministic and prefer a false alarm; never relax them to
  model judgment. Commands the user types keep their behavior.
- Inline markers are stable (PR, path, normalized anchor, ordinal); do not put a
  review ID or model wording into them.
- Comment planning pages run side by side, so nothing a page sees or produces
  may depend on which page finishes first: only the first page writes the
  summary note, each page keeps its own continuation state and evidence, and
  pages are assembled in page order (ordinals follow page order).

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
For package entry points, first-run setup or settings-path changes, also run
`node tests/host-v2-smoke.mjs <opencode binary> --native`; this installs the
packed artifact through OpenCode's plugin manager in an isolated profile.
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
