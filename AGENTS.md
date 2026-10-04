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
  filtered, failed or interrupted execution as a completed answer. Successfully
  completed PARTIAL reviews and prose are useful inputs. Exclude reasoning.
- The exact Promise adapter does not forward cancellation request options.
  Revoke grants synchronously, interrupt then wait, bound cleanup, and disclose
  unconfirmed settlement. Do not infer cancellation from local promise rejection.
- Host agent configuration applies after external plugin transforms. Preserve
  global/project permissions and session inheritance. Pin validated resolved
  roles before first use and reject later changes. Never borrow Build-only rules
  or introduce a wildcard permission grant.
- Deny native execution/editing/delegation/public web and host session/model
  control in private roles, including CodeMode execute (its fetch bypasses the
  native tool boundary). Require MCP codemode:false. Do not silently rewrite
  the user's host configuration. shellToolPermission=ask does not relax guards.
- No fixed MCP tool catalog, direct Azure/model client, patched server, or
  name/action classifier. MCP read-only behavior is prompt policy, not a write
  firewall. Denied native attempts and observed tool failures are not evidence.
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
  formatting; outputRetries applies to eligible standalone readiness amendments.
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
  That prompt rule is not a programmatic file-provenance sandbox. Do not broaden
  local reads or treat saved-response offsets as source line numbers.
- Reports/receipts use synthetic notices with resume:false. Never run a model
  to reformat them. Queue acknowledgment is distinct from actual UI display.
- Comment publication needs a same-origin completed review, saved preview,
  enabled publication and explicit --publish. Track uncertainty before writes,
  revoke publication grants on any observed tool error, prohibit automatic
  retries and label results model-reported. Derive line-local offsets from saved
  anchors; do not ask the planner for additional coordinate fields.

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
