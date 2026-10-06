# Roadmap

Target: OpenCode CLI 2.0.22, official Azure DevOps MCP 2.9.0 and Ubuntu 22.04.
This repository implements V2 only. [Current validation](VALIDATION.md) records
the latest tested runtime; [validation history](VALIDATION_HISTORY.md) preserves
earlier results without treating retired behavior as current requirements.

## Implemented

- Native V2 commands, hidden role/model-bound sessions, literal inbox correlation,
  active grants, cancellation and non-resuming report notices. Host-owned ordinary
  agents, permissions and auxiliary model choices remain intact.
- Two independent full-scope initial reviewers followed by one source-verifying
  verifier in both normal and deep modes. Architecture, behavioral tests,
  documentation promises, type invariants and failure visibility are part of
  their existing scope; no specialist model rounds are added.
- Local review-envelope and syntax/key/shape recovery, literal retention of
  ambiguous or partial output, explicit unavailable-stage notices and original-ID
  accounting. Missing decisions remain UNREVIEWED. Every validated COMPLETE review
  can enter same-origin comment planning despite disclosed initial limitations.
- Optional native project verification under inherited host permissions. MCP
  supplies remote PR source; no checkout, clone, repository mapping, custom
  execution platform or mandatory test quota is required.
- One deterministic issue index in the report and saved PR summary, with a leading
  robot/AI/model disclosure and optional brief purpose or change overview before
  the index. Review IDs and commit SHAs stay in local records. Test/process narration
  is not required in the summary. Existing stages author directly in outputLanguage,
  without an additional translation or polishing stage.
- Leading severity icons and compact Summary/Evidence/Suggested fix inline comments
  for verified high/medium findings. Low findings remain in the index. No numerical comment quota or
  automatic promotion of severity is used.
- Optional preview followed by explicit publication, or direct
  `/pr-comment --publish` that prepares and saves a plan first. Omitted IDs select
  the latest COMPLETE review in the origin, or the review associated with a result
  session. Saved content, explicit authority and uncertain-attempt lockout remain.
- Complete-empty-discussion guidance, visible optional planning-failure reasons,
  captured review text for planning, numbered source displays and narrow literal
  anchor restoration. These features do not certify source provenance or classify
  MCP operations.
- Latest-20 completed-review cache in process memory, no time TTL, no authority
  restored from history/debug files after restart. Optional diagnostics preserve
  visible failures without recording reasoning or full host configuration.
- Source-only standalone readiness, cancellable model/MCP preflight, a bounded
  direct-tool registration observation period, exact-role/native-tool guards and
  private auxiliary-request rejection, including after restart.
- V2 installation, current-layout settings preservation, conflict refusal,
  rollback and archival removal; offline tests and exact-host fresh/replacement
  fixtures in CI. Controlled live review/publication acceptance is recorded
  separately from fake-service and CI results.

## Remaining validation and quality work

1. Test additional authorized PRs, languages and model profiles. Priorities include
   BASE/HEAD interpretation, decisive arithmetic, original-ID completeness,
   severity consistency and accurate attribution of reproduced behavior.
2. Assess review-note usefulness and natural language across more examples.
   Notes should add PR-wide context beyond the findings, without generic process
   inventories; relevant execution evidence remains with findings and local reports.
3. Verify actual TUI notice rendering, result navigation and rendered Azure
   comments. Queue acknowledgement and API content/coordinate checks have narrower
   scope than a user-interface test.
4. Repeat environment acceptance for other installations/providers and any future
   host/MCP upgrade. Provider admission, quotas, source pagination and context
   limits need their own evidence; the current small-PR samples are not broad
   compatibility or reliability certification.

## Quality principles

Diagnose original evidence before adding instructions for a rule the model already
ignored. Preserve failed samples, initial errors and partial publications. Separate
execution success, source fidelity, factual quality and presentation; a COMPLETE
status or successful write proves none of the others by itself.

Prefer prompt clarity and useful results with honest limitations. Keep exact code
and version provenance, coherent corrections and attributed test outcomes. Do not
add model/PR/MCP-version exceptions, extra rounds, mandatory fields, hidden budgets,
comparison machinery or a second completion gate to conceal model limitations.

Native commands have real host authority; the plugin is not a sandbox. No live
review, publication, deletion, installed-host upgrade or repository publication is
implied by a local test. Follow the user's current authorization for each action.
