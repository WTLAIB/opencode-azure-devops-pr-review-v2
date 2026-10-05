# AI development guide

This repository targets only `@opencode/cli@2.0.22`, `@azure-devops/mcp@2.9.0`,
and Ubuntu 22.04. Public source and documentation use English. Follow the user's
conversation language and current authorization scope.

## Before changing anything

Confirm the actual Git root, branch, HEAD, working tree, and installed paths.
Read README, architecture, roadmap and task-relevant docs. Read a local
`.local/HANDOVER.md` when present; it is historical private context, not proof of
current state or new authorization. Preserve unrelated changes, credentials,
private settings, existing backups and failure records. Never upload `.local/`.
The independent V1 repository and installation are outside this project's scope.

## Product boundaries

- Use the exact V2 plugin definition and domain transforms/hooks. Do not add a
  V1 adapter, command template, native StructuredOutput path or migration layer.
- Both normal/deep modes have functional and risk full-scope initial reviewers,
  followed by an independent source-verifying verifier. Do not add model rounds,
  fallback models or model-specific/PR-specific/MCP-version-specific fixes.
- Source checks use separate readiness rules. Explicit native commands alone
  authorize private sessions. Preserve ordinary agents, provider configuration,
  auxiliary model selections and host permissions.
- V2 prompt returns an inbox admission. Wait for idle, then correlate its exact
  ID, literal text, metadata and selected role/model against authoritative
  context. Fail closed after compaction or interleaving. Do not accept truncated,
  filtered, failed or interrupted execution as a completed answer. A successful
  initial/final session may include the pinned host incomplete-stream text
  continuation: verify the failed-text/retry/synthetic/final-stop sequence, keep
  raw fragments, join literal text only, then apply ordinary review validation.
  No plugin retry or continuation recovery for comment/check roles. Successfully
  completed PARTIAL reviews and prose are useful inputs. Exclude reasoning.
- The exact Promise adapter does not forward cancellation request options.
  Revoke grants synchronously, interrupt then wait, bound cleanup, and disclose
  unconfirmed settlement. Do not infer cancellation from local promise rejection.
- Host agent configuration applies after external plugin transforms. Preserve
  global/project permissions and session inheritance. Pin validated resolved
  roles before first use and reject later changes. Never borrow Build-only rules
  or introduce a wildcard permission grant.
- Initial reviewers, the verifier and comment roles may use shell/read/glob/grep in the current
  OpenCode project under inherited host permissions. Do not add a second execution
  platform, repository mapping, command allowlist or plugin permission switch.
  MCP is the source for the remote PR; local Git history or a checkout is not
  required. Do not clone/fetch for review. Model-chosen reproductions may use
  needed MCP-returned files in fresh temporary directories with version provenance.
  Preserve parent location and permissions, active role/model binding and grant
  revocation. Standalone readiness still denies native execution/search. Comment
  tools support local verification; remote reads and saved publication use MCP.
- Deny native editing/delegation/public web and host session/model control in
  private roles, including CodeMode execute. Require MCP codemode:false. Do not
  silently rewrite host configuration or claim filesystem/network isolation:
  authorized shell commands have ordinary host authority and can have side effects.
  Models choose verification methods, preserve user work and disclose the tested
  source provenance and any local changes, failures and limitations. No mandatory tests,
  extra review round or execution-based completion gate.
- No fixed MCP tool catalog, direct Azure/model client, patched server, or
  name/action classifier. MCP read-only behavior is prompt policy, not a write
  firewall. Denied native attempts and observed tool failures are not evidence.
  Plain multiline tool text may receive a numbered model-facing display through
  the public result hook. Preserve raw output, wrappers, errors and truncation;
  numbering is not provenance or a new source/eligibility gate. Successful
  multiline review tool observations may be shared with same-origin comment roles
  together with original arguments. Keep them as untrusted temporary data;
  exclude native tool output and flagged errors/truncation, deduplicate identical
  observations, and do not introduce cloning, source classification or model calls.
  Startup may observe direct-tool registration through public host namespaces;
  this is metadata synchronization, never MCP action classification or a source
  certificate. The bounded observation grace period must not become a refusal,
  model retry, hidden review-stage budget or permission override.
- Pursue exact PR identity/SHAs, full discovered-path coverage, counterevidence,
  original-ID decisions and a final version recheck. Review quality gaps produce
  visible limitations, not wholesale result loss. Preserve all useful observations
  and label missing decisions UNREVIEWED. A COMPLETE final verifier result enters
  same-origin comment preview; initial coverage disclosures, partial/unavailable
  initials and their warnings must not impose a second eligibility veto. The
  verifier still establishes final evidence, versions and original-ID decisions.
  PR target SHA is not a certified merge base. Tool success and model claims are
  not independent source proof.
- Prefer JSON text with local syntax/key/shape normalization. Retain ambiguous or
  unstructured output literally for the verifier and report. Extract a unique
  review object from prose/fences while retaining surrounding examples; incidental
  code braces are not competing review envelopes. Never silently choose
  duplicate keys, drop a finding or manufacture evidence. Partial/admitted failed
  initials do not cancel useful sibling work. Keep identity, admission, permission,
  configuration and cancellation guards. No extra review model requests for
  formatting or standalone readiness repair.
- Keep original response/failure records. COMPLETE must be actionable for comment
  preview in the same session/process; publication still needs a saved plan and
  explicit authorization. Normalized formatting warnings alone cannot downgrade
  validated final evidence. A readable PARTIAL report is useful, not fabricated
  completeness. Missing fields and execution failures remain explicit.
- No reviewer iteration or stage-character budgets, configurable or hidden.
  runTimeoutSeconds defaults null. Preserve explicit finite timeout, manual
  cancellation, lifecycle disposal and bounded SDK cleanup.
- Source-read recovery remains prompt guidance: one identical repeat only for
  explicitly transient logical reads, plus at most one unknown-cause idempotent
  read per stage with fixed arguments/target/version/deadline. Never retry writes,
  authorization/parameter/not-found failures, truncation or empty searches.
- Host-saved output may be read only under the documented same-session policy.
  Initial/verifier roles may also inspect their current project. Neither prompt
  policy proves file provenance; saved-response offsets are not source line numbers.
- Reports/receipts use synthetic notices with resume:false. Never run a model
  to reformat them. Queue acknowledgment is distinct from actual UI display.
- Comment publication needs a same-origin completed review, saved preview,
  explicit --publish. Preview has no numerical comment quota. The removed
  comments, auxiliaryModels and outputRetries settings must not return as hidden
  switches, caps or extra model requests. Track uncertainty before writes,
  revoke publication grants on any observed tool error, prohibit automatic
  retries and label results model-reported. Derive line-local offsets from saved
  anchors; do not ask the planner for additional coordinate fields. Publisher
  argument strings containing a whole comment with its unique saved marker may
  be restored to saved content. This copies approved text, not MCP operation,
  target or coordinate authorization. Preserve host permissions and uncertainty.
  Known non-confirmed dispositions may remain skipped notes, never eligible posts.
  Anchor formatting may be restored from one unambiguous captured literal range
  at the same lines when argument values include the selected path and HEAD.
  Do not interpret MCP fields/actions, relocate lines or invent source; preserve
  original output and disclose changed IDs. This is not source certification.

## Verification and delivery

Run `npm run check`, `npm test`, and diff/secret checks appropriate to changes.
Installer tests must preserve unrelated files and private current settings,
reject conflicts and obsolete layouts, and test rollback and archival uninstall.
Keep manual-copy file lists exact. Do not require npm installation for the plugin.

Actual-host fake-service tests and live Azure/model reviews establish different
claims. Record exact versions, OS, artifacts and limitations. A successful review
is not broad compatibility certification or proof of model factual quality.
Do not erase historical failures to make results look successful. Diagnose raw
evidence before adding prompts when a rule already exists but is inconsistently
followed. Document accepted model/MCP limits honestly.

Do not start live models, publish PR comments, change personal settings, upgrade
installed tools, or publish a repository without authorization for that action.
Keep authorization scoped to the current request; old approvals are not reusable.
