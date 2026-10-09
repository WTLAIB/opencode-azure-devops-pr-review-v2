# Human-readable Azure PR comments

`/pr-comment` turns a completed review into one PR summary and actionable inline
discussions. Review and planning do not authorize PR writes or changes to existing
project files; optional local verification follows the
[project-tool policy](VERIFICATION.md). MCP permissions remain host-owned.
Planning and publication use the originating review's risk model:
`models.review.risk` or `models.deep.risk`. This profile stays attached to the
saved review even if another mode runs afterward. Comments do not rerun reviewers
or switch profiles. A configured role does not imply a pricing tier.

## Policy and rationale

The policy draws on three public practices:

- [Google's review-comment guidance](https://google.github.io/eng-practices/review/reviewer/comments.html): explain the reason, be constructive, and distinguish important changes from optional advice. Here, comments describe the triggering condition and impact, then suggest a focused correction or test.
- [Conventional Comments](https://conventionalcomments.org/): structured labels make feedback easier to scan. This project uses the compact `🔴 high:` and `🟡 medium:` severity labels for actionable defects. These are project-specific labels, not the Conventional Comments syntax, Azure votes or assertions that a merge is blocked.
- [Microsoft's Azure PR guidance](https://learn.microsoft.com/en-us/azure/devops/repos/git/review-pull-requests?view=azure-devops): use line-specific discussion for local code issues. Here, keep local issues inline and add a separate compact PR summary; the complete evidence, decision ledger and skip reasons remain in OpenCode.

The following limits are project choices, not universal standards:

| Rule | Behavior |
| --- | --- |
| Eligibility | Summary indexes confirmed findings and separately carries retained non-defect suggestions; inline comments require high/medium-impact defects |
| Volume | No numerical comment or suggestion quota; one publishing attempt per review |
| Comment size | Inline bodies and the optional summary introduction each allow 1,200 characters; additional summary details have no plugin length cap |
| Anchor | Smallest useful exact range in a changed HEAD file; no fixed line-count maximum |
| Structure | Observable issue title; 📝 Summary; 🔎 Evidence; 💡 Suggested fix |
| Language | Shared `outputLanguage` for the final report and comment prose; identifiers and machine-readable labels unchanged |
| Duplicates | One root cause per thread; skip non-deleted discussions, including resolved ones |
| Inline exclusions | Speculation, unanswered questions, cosmetic nits, optional refactoring, praise, and unsupported clean bills of health; supported improvements belong in the summary |
| Unlocatable findings | Explain the skip locally and retain the supported issue and its location limit in the summary; never invent coordinates |

An explicit deletion record is not an existing discussion or marker. Enumerate
all threads, ignore explicitly deleted comments, and still inspect any remaining
non-deleted comments in a partially deleted thread. Resolved discussions remain
duplicates. A missing body does not prove deletion. This distinction does not
clear the saved publication-attempt ledger or permit an uncertain write retry.
Deletion interpretation remains model policy, not an MCP response parser.

Example body (shown in English; the actual body uses the shared `outputLanguage` setting):

```text
🔴 high: **Missing records bypass the fallback**

**📝 Summary**

An empty lookup fails a previously supported request.

**🔎 Evidence**

When the lookup returns no record, this property access throws before the fallback runs. A previously supported request then returns an error.

**💡 Suggested fix**

Check for a missing record before dereferencing it, and add a regression test for an empty lookup result.
```

The final verifier's `verifiedFinding` for each `CONFIRMED` original and its
structured `newFindings` (`V-*`) are passed to the planner. These are the corrected,
verified claims, not the original candidates. `NEEDS_INFO`, `REJECTED`, and
`MERGED` originals are not published as separate defects. A new concern mentioned
only in free-form report text is not automatically converted into a finding ID
or inline defect. Supported non-defect recommendations retained in the final
report are carried separately into the summary. Every
supplied finding is either in the preview or explicitly skipped with a reason,
including low-severity findings that cannot be posted inline. The planner must preserve
the verified severity; the runtime rejects both promotion and demotion instead
of silently revising the verifier's conclusion. Preserve the trigger and all
qualifications when adapting a finding into a short comment. The model still
assesses relevance and semantic duplicates; the runtime cannot prove those
judgments or the comment's meaning correct. Inspect the preview.
If the verified claim cannot fit faithfully within the per-comment body limit, the planner
must explain the skip locally and preserve its useful explanation in the summary
rather than omit essential conditions to fit.

## PR summary and readable inline format

Each saved plan contains one general summary with no file coordinates or finding
ID, followed by eligible inline comments. The runtime renders counts and an
issue/location index from corrected findings, ordered by severity. The optional
planner `summary` text appears before the counts and index in outputLanguage.
In one or two sentences, it starts with the purpose supported by the PR description
or requirements, or a brief change overview when intent is unknown. It may then
connect related findings to their shared impact or identify a supported fix
priority. These are useful options, not required categories; limitations belong here only when
they materially qualify the conclusions. The section is labelled
Review notes in English and uses the corresponding Chinese label for Chinese
output. Review methods, test execution and reproduction results are not required
summary topics; relevant evidence belongs with the findings it supports.
The verifier carries useful initial-review execution reports into its existing
report with attribution; the planner does not receive raw native test output.
Those reports include actual pass/fail outcomes or observed behavior, rather than
merely acknowledging that earlier results exist.
Routine identity/anchor/discussion/deletion checks and generic merge-base caveats
stay out of public notes. Mention coverage or attribution limits only when they
materially qualify the conclusions. Publication checks remain required even when
omitted from the prose. Notes add
no findings, repeated counts, private diagnostics or new model round.
Missing/malformed optional prose leaves out the notes section, retaining the
summary without a process disclaimer or new completion gate. The summary includes
the disclosure and a unique marker bound to the review and exact HEAD. Review IDs
and commit SHAs remain in the saved review and local records, without a visible
metadata line in the PR summary. Low-severity findings appear in this index but
cannot be promoted into inline issues. The complete source/decision ledger and
private diagnostics remain local.

Optional planner `summaryDetails` Markdown follows the index, with sections only
when there is useful content:

- **Additional finding details** explains confirmed findings without a proposed
  inline comment, including low severity: affected code, supported trigger and
  impact, and a correction. A reference to an actual existing substantive
  discussion can avoid repeating that explanation. Material source/location
  gaps remain visible rather than becoming invented coordinates or certainty.
- **💡 Improvement suggestions** contains every distinct source-supported
  non-defect recommendation retained by the verifier. Each identifies affected
  code, the concrete benefit and a proportionate change, preserving conditions
  and tradeoffs. Duplicated logic, mixed responsibilities and test gaps are
  possible subjects, not a checklist to populate. A long function alone does
  not establish a defect. Suggestions have no finding IDs or defect severity
  and are excluded from defect counts.

For zh-TW, the example headings are `補充問題說明` and `💡 改善建議`.
Equivalent advice is combined without losing distinct concerns. No empty
heading, top-N selection or total character quota applies to these details;
the short introduction and each inline body retain their own 1,200-character
limits. A summary with suggestions and zero confirmed defects is valid.
The planner checks coverage across the proposed summary, inline comments and
existing discussions, using the existing review. It does not copy the private
report wholesale or resurrect rejected initial hypotheses.

Recommendations travel through the existing initial and verifier `report`
fields; only the final report reaches the planner. The verifier must evaluate
and carry useful advice forward, not leave it solely in an initial report.
`summaryDetails` is optional, so older plans and absent/malformed text do not
gain a new completion gate. The runtime preserves the provided detail without
the introduction's cap, displaying quoted HTML comments literally to preserve
one active runtime marker. It does not certify that the model retained every
recommendation or that the advice is sound. Check actual model output for loss
between stages, not just successful plan validation.

This summary guidance draws on the brief context and PR-wide feedback in
[n8n's review skill](https://github.com/n8n-io/n8n/blob/master/.agents/skills/human-like-code-review/SKILL.md),
the behavior and dependency context in
[CodeRabbit's walkthrough guidance](https://www.coderabbit.ai/blog/explainable-prs-and-smarter-reviewer-routing),
and the ordered actions in
[Anthropic's PR Review Toolkit](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/pr-review-toolkit/commands/review-pr.md).
Only those presentation ideas are adopted; they add no review stage or required field.
Separating suggestions from defects also follows the Toolkit's Suggestions
section and [Conventional Comments](https://conventionalcomments.org/), which
asks suggestions to explain both the change and its benefit.
[PR-Agent's review guidance](https://docs.pr-agent.ai/tools/review/) keeps findings
that cannot be anchored inline visible in the summary. These ideas do not add
mandatory topic sections, scores, praise or merge verdicts.

A general summary is saved during planning, including preview-only commands.
Its Azure thread is created only under `--publish`, as part of the same
publication-attempt ledger. Existing summaries are never edited/deleted.
The publisher returns `summaryThreadId` separately from
`posted` finding IDs. Every required item must be reported before the batch is
MODEL_REPORTED_POSTED; this is not independent provider verification. Partial
writes remain visible without retry. A new review's index does not
replace or reopen existing discussions, and contains no claimed write count
that could become false if later writes fail.

Inline titles describe an observable consequence. Compact bold 📝 Summary, 🔎 Evidence
and 💡 Suggested fix labels guide reading; prose follows outputLanguage. Use the
smallest useful example and correction; avoid redundant title repetition, long
code blocks, confidence percentages, mandatory praise or merge recommendations.
Basic Markdown headings, lists, tables and emphasis are used. Collapsible HTML
or one-click patch suggestions are not required. The 1,200-character inline body
limit still preserves essential conditions; formatting is guidance, not a new
model-output rejection gate.

Severity cues are 🔴 high, 🟡 medium and 🔵 low, alongside the text labels.
The runtime adds them to the issue index; inline titles start with
`🔴 high: ` or `🟡 medium: `. Other emojis are optional and left to the
planner's judgment.

Initial reviewers, the verifier and the planner compose explanations directly
in outputLanguage. For zh-TW, prompts request natural Taiwanese engineering prose,
clear triggers/impact/corrections and familiar Chinese descriptions, preserving
exact identifiers, source quotes, quantities, qualifications and version direction.
There is no English-first translation or additional polishing pass. The publisher
still sends the saved text exactly; style guidance cannot authorize rewriting it.

Design references: [Anthropic PR Review Toolkit](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pr-review-toolkit),
[CodeRabbit walkthroughs](https://docs.coderabbit.ai/pr-reviews/walkthroughs), and
[PR-Agent reviews](https://docs.pr-agent.ai/tools/review/). These inform presentation,
not this plugin's authorization, model topology or provider compatibility.

## Preview and publish

A COMPLETE review can enter comment planning from its original conversation or
its report/comment-result sessions in the same process. The ID is optional;
omitting it selects the latest completed review in that conversation. A report
session remains associated with its own review, even after a newer review runs
in the origin. Other conversations cannot select it.
Two COMPLETE runs in the origin select the second, even for different PRs. A newer
failed or PARTIAL run does not replace the cached COMPLETE review. Selection never
combines results or skips a review because it already had a publication attempt.
The planner may return one strict JSON plan surrounded by explanatory text or
code examples. Local extraction accepts that unique plan and retains the notes
in its session and optional stage diagnostics; notes are not appended to posted
comments. Competing or unfinished plan objects and duplicate JSON keys still
fail. This does not repair plan syntax, invent missing fields, change findings,
relax semantic validation or start another model request. Publication receipts
and configuration keep their existing parsing rules.

There is no additional veto based on initial coverage disclosures or incomplete
initial reviewers after the independent verifier passes the final evidence,
identity/version and original-ID checks. Retained limitations accompany the
planner, which still checks current source, anchors and existing discussions.
PARTIAL, STALE and interrupted final results remain readable but do not enter the
comment cache. COMPLETE is not automatic publication or a guarantee that an
eligible, nonduplicate inline comment exists.

Publication has no separate configuration switch. Explicit `--publish` uses an
existing saved preview, or completes the planning pages and saves the validated plan
before publishing in the same command. A separate preview command is optional.
Repeating `/pr-comment` reruns planning without rerunning review. Once planning
starts, the previous plan is discarded; a failed plan refresh cannot leave that
older preview available for publication.
An INCOMPLETE/failed plan starts no publisher and retains the completed review.
Comment roles inherit shell/read/search permissions from OpenCode for local
verification. They add no allow rule: host asks and denials remain effective.
A provider rejection creates no saved plan and starts no publisher; it does not
invalidate the completed review. See [provider diagnostics](DEBUGGING.md#tool-observations-and-permissions).
Set outputLanguage (for example, zh-TW) to control both final-report and comment
prose. Initial reviewers use the same language so the verifier does not need to
switch from an English handoff. Structured keys, identifiers and source quotes
remain unchanged. Language compliance is model behavior, not a completion gate.

From the original conversation or its report session, without remembering an ID:

```text
/pr-review https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/123
/pr-comment --publish
```

For an optional preview, use `/pr-comment` first. Both commands accept a specific
ID: `/pr-comment <review-id>` and `/pr-comment <review-id> --publish`. Every
COMPLETE report ends with these exact commands for that report. `returnReport`
only changes where the report is displayed, not eligibility or required steps.

The preview shows the comment count, complete saved content (body, AI/model
disclosure, marker), locations, and skip reasons even in receipt mode. There is
no numerical comment quota: all independently actionable eligible findings can
be included. Duplicate, low-severity or unsupported findings still need skip
reasons; absence of a quota does not relax evidence or anchor checks.
The comment planner receives references to successful multiline tool observations
from the same review, with original arguments and exact raw text. Identical
observations are stored once. Native review output and flagged failed/truncated
results are excluded from this source-sharing index. Observations remain untrusted;
match path/commit and obtain missing evidence through MCP. No checkout or clone is
required. Anchors have no arbitrary line-count maximum.

### Large PR work pages

The runtime keeps complete evidence in private files, separate from each model's
working context. This prevents accumulated source responses from becoming one
multi-million-character `pr-comment` admission. `inputCharacters` measures serialized
request characters, not actual tokens or just the human-readable report.

Each planning session receives:

- The exact review target, snapshot, language and assigned verified findings.
- One exact final-report segment plus a reference to the full report for boundary
  context. Final dispositions omit their duplicate `verifiedFinding` objects.
- References to source observations, prior completed plan fragments and original
  tool results from earlier comment sessions. Large fields and path lists are
  references too. Native read/search still requires inherited host permission.

Data files include SHA-256 and length, plus JSONL pages with UTF-16 offsets so even
one enormous source line can be read in bounded pieces. These offsets are not
source lines and hashes do not certify returned versions. The artifact preserves
complete wrappers, truncation flags and original bytes; it cannot make an incomplete
MCP response complete. Never load the whole evidence catalog just because it exists.

Findings, report segments and publication items are grouped around 12,000 serialized
characters. An indivisible large field is referenced rather than cut off. Tool
results larger than this are saved before the host adds their display to model
history. Smaller tool results are also retained for later sessions. A read-only
session asks for a successful `CONTINUE` checkpoint after roughly 48,000 visible
input/tool characters or eight primary requests. The next exact admission carries
remaining assignments, references and a cursor. This is explicit workflow progress,
not host compaction, recovery of failed execution, or a whole-review budget. There
is no aggregate cap on files, findings, sessions or retained advice. Repeated
checkpoints without progress fail visibly rather than loop forever.

The runtime validates completed fragments and accounts for every eligible finding
exactly once before saving the whole plan. It retains all authored detail. Semantic
advice completeness and duplicate judgments still depend on the model. A failed or
cancelled page saves no partially publishable plan; the completed review remains.

Before any write, fresh read-only sessions check current PR identity/HEAD and all
unfiltered discussions for every saved publication page. They can checkpoint while
paging large discussion collections. Only when every page passes does the runtime
mark the entire plan UNKNOWN and start sequential publisher sessions. A publisher
receives only its assigned saved items, target, language, relevant paths/coordinates
and page metadata. It rechecks mutable PR identity/HEAD and reuses immutable anchors.
It need not repeat the full discussion scan absent new uncertainty.

Large saved summary text uses a short whole-comment placeholder with its exact
marker. The existing pre-execution restoration copies the full approved bytes into
the tool argument. The publisher does not regenerate the summary. The complete
preview remains available for inspection. Model-reported thread IDs must be unique
across every page. A failed, incomplete or cancelled publisher stops remaining pages;
all unreported items stay UNKNOWN and the single-attempt lock remains. No checkpoint
or automatic retry resumes a write. Service limits, host tool catalogs and provider
behavior still apply; paging is not a promise of unlimited remote comment size.

When using preview, inspect it before publishing. The runtime derives `startOffset`
and `endOffset` from saved anchors using one-based, line-local UTF-16 positions.
The publisher maps those exact positions to the exposed MCP schema. Tool success,
checkpoint claims and MODEL_REPORTED_POSTED are not independent source or Azure
verification; inspect actual remote content and coordinates.

For matching plain-text tool responses, review and comment roles see a locally
numbered view with the original request arguments. This helps locate anchors
without manually counting blank lines and keeps the selected version visible.
When a stage already has a review snapshot, matching argument values are labeled
HEAD (PR source) or BASE (PR target reference). This display comparison does not
prove that the tool honored those arguments or returned the requested revision.
The raw tool output is preserved; `N |` prefixes are display aids, not anchor
characters. Numbering does not prove that a response is a complete file or repair
a model's selected location automatically. The narrow formatting restoration
described below can copy a uniquely matching captured range and correct a counted
location. The saved preview remains the exact
publication input, and its location still needs review.

Every saved comment includes one short disclosure: it is an AI-generated review,
not human review or approval, followed by the distinct selected provider/model IDs
from the review stages and comment preparation/publication. Repeated model IDs
appear once. The general summary starts with this disclosure, prefixed by 🤖,
before its title and issue list. Inline comments keep their existing disclosure
footer. For example, using placeholder IDs:

```text
AI-generated review; not human review or approval. Models: `provider/model-a`, `provider/model-b`
```

The disclosure follows the report's `outputLanguage`. The full report retains
the per-role model ledger and review method. The runtime generates attribution
from invoked review stages, not from the planner's prose; unused configured
models are not listed. This disclosure also applies when the MCP uses a personal
account. Check company policy before publishing. The publisher preserves the
entire saved disclosure. Exact remote content still depends on model/MCP compliance;
inspect Azure.

The workflow does not start a publisher without explicit --publish. This is not
a guarantee that a model cannot misuse a host-permitted tool during review or
preview: read-only behavior there is a prompt instruction.

## MCP calls

Configure the MCP server with `codemode:false`; private roles block CodeMode execute. Models use the direct tools and schemas actually exposed by OpenCode. There is no fixed
tool prefix, name, action list, read adapter, or create-thread adapter. The model
must find suitable operations to read exact-commit source, enumerate all threads,
check current PR identity/HEAD, and create an inline comment if authorized.

A tool listing comments in one thread is not enough to verify all PR discussions.
If a required capability is unavailable, the model must stop rather than guess,
skip verification, or substitute a long general comment. OpenCode and the MCP
server still enforce their own permissions; the plugin adds no MCP overrides.

Read-response truncation uses the shared output-reading policy: supported
pagination or bounded Read of a full output file saved and identified by OpenCode
in this same session, subject to host permissions. Runtime-supplied comment data
references additionally allow same-origin access across comment work sessions. Local project verification
also follows the shared [project-tool policy](VERIFICATION.md).
Saved response offsets are not source-file coordinates, and an
incomplete server response remains incomplete after saving. A partial duplicate
listing or missing source cannot qualify a comment for publication. Inspecting a
saved create result never grants another publishing attempt.

The target parser currently accepts canonical dev.azure.com and hosted
organization.visualstudio.com PR URLs. This identifies the intended target;
it does not independently verify the identity returned by an MCP operation.
On-premises Azure URLs are not currently supported for the comment workflow.

## What is enforced and what is instructed

The runtime checks plan structure: known confirmed finding IDs,
high/medium labels matching the verified finding, body length, changed-file paths, positive ordered line ranges, anchor
line count, and an explanation for every skipped eligible finding. It adds stable
markers. These checks are not proof that source lines or findings are correct.

### Ancillary notes and anchor formatting

The planner may retain skipped notes for known MERGED, REJECTED or NEEDS_INFO
verifier dispositions. They do not become publishable findings or satisfy the
accounting requirement for an omitted eligible finding. Unknown IDs, duplicate
entries, conflicting selections and missing reasons still fail validation.

Before saving a plan, the runtime may restore leading/trailing indentation and
one extra layer of escaped quotation marks in an anchor. It considers only the
original captured tool output, where argument string
values contain the exact selected path and HEAD SHA. No tool, action or argument
field names are classified. All matching observations must agree on one literal
range. A matching declared location stays preferred. Otherwise one uniquely
quoted range may correct a counted location before preview and marker/offset
calculation. The runtime never changes the claimed defect, path or commit, or
chooses between ambiguous alternative ranges. Missing/ambiguous matches leave
the planner text untouched; this is no additional completion gate.

Argument-value matching does not prove full-file content or source provenance;
numbered rows describe the observed text. Existing source
verification and publication checks still apply. Original model output remains
in response diagnostics; `anchorRestorations` records changed finding IDs, and
result/preview diagnostics contain the saved anchors. `locationRestorations`
retains original and restored coordinates. This cannot bypass attempted-finding
or duplicate-discussion policy. Offsets are computed from
that saved exact text. These formatting restorations do not alter comment body
claims or authorize publication.

### Saved text and publication attempts

Before a publisher tool executes, the runtime restores a whole comment string
with one recognized saved marker to the saved content. This prevents paraphrasing
during copying. It does not classify tool names, actions or argument field names,
and leaves other arguments, coordinates, marker-only searches and ambiguous or
unknown marker strings untouched. Diagnostic `savedTextRestorations` records
finding IDs without copying argument values. Host permissions still apply.
Compact severity titles and earlier `issue (severity):` titles, with or without
a leading severity icon, are recognized. Formatting guidance does not reject an
otherwise valid earlier title or rewrite saved text.

Reading source, checking HEAD/identity, finding duplicate discussions, using only
create operations, selecting the intended target/coordinates and verifying the
actual create response remain **model instructions**, not MCP-call guards.
Unrecognized or missing markers are not corrected. Independently inspect Azure;
text restoration is not evidence that a correct write happened.

Before starting a publisher, the runtime marks the whole batch UNKNOWN. A valid
publisher report with all planned IDs can produce MODEL_REPORTED_POSTED, showing
the reported thread IDs. This is explicitly model-reported, not independent Azure
verification. No completed tool call, a malformed report, missing posts, failure,
or cancellation leaves an incomplete or uncertain result. Generic completed tool
calls do not establish that a write happened or that it was correct.

Only one publishing attempt is allowed per completed review. After any attempt,
inspect Azure before starting a new review. The plugin cannot identify which
calls were writes. Any execution-hook error or explicit MCP error result during
publication immediately revokes the stage's grants and requests interruption.
No subsequent tool or model request is authorized, even if the failed call was
a read or parameter validation. Already dispatched calls cannot be recalled.
The plugin never retries the batch automatically. This is not an
exactly-once guarantee: the model, host, or server could still retry operations.
Prompts forbid blind retries. A push or new discussion can race the last check.
Cancellation cannot undo already dispatched operations; no remote rollback or
deletion is attempted.

## Retention

Completed reviews, source observations, prepared plans and attempt records are
bound to this plugin instance's process-memory cache, across its conversations.
Large source/tool bytes and work fragments live in private files. Without debug,
files are removed at eviction or unload after active commands release them. An
abrupt process termination may leave private temporary files for manual removal.
With debug enabled, artifacts are retained with the originating review diagnostics.
The cache holds the latest 20 completed reviews; the next completion evicts the
oldest. There is no elapsed-time expiry or run-ID authority database. Unloading the plugin or restarting the process clears the memory cache.
OpenCode retains its own history independently. Optional debug files have no
automatic deletion and must be removed deliberately by their owner.

An unavailable ID never falls back to another review. A plan with no inline
comments still contains a publishable general summary. It never asserts approval
or that zero findings proves defect-free code.
Optional debug files preserve a private diagnostic copy but cannot restore a
publication authorization or plan after restart.

## Empty discussions and planning failures

Duplicate checks compare remaining comment text. Explicitly deleted records
are ignored, while surviving comments in partially deleted threads and resolved
discussions still count. Historical IDs, status codes and line coordinates alone
are not duplicate findings. Prefer documented full responses over summaries that
omit comment bodies or deletion fields.

A successful, complete, unfiltered comment collection with zero items provides
no discussion text to compare; an empty thread may remain listed. Its absence of
a deletion flag does not block planning, and the model need not prove why it is
empty. Do not individually reread collections that are already complete. Missing
summary fields, unfinished pagination, truncation, denied reads, and a non-deleted
comment with an unavailable body still need a supported read or a specific
explanation. The runtime does not interpret MCP tool names or classify Azure
response schemas; this is shared planner/publisher guidance, not a write firewall.

An unsupported individual finding belongs in `skipped` with a reason, allowing
other comments to proceed. Zero eligible inline comments is a READY summary-only plan. A real
batch-wide verification gap may return INCOMPLETE with an optional `reason`.
The reason appears in the local receipt and private diagnostics, never in a PR
comment. INCOMPLETE output without a reason explicitly says the model did
not explain the gap; the plugin does not invent a cause. No failure launches an
automatic repair request. A fresh explicit comment command may replan the same
review if no publication attempt occurred.

## Customization

Installed comment instructions are in `plugins/azpr-v2/prompts/comment-policy.md`,
`comment-plan.md`, and `comment-publish.md`. Review stages also have shared and
role-specific prompts; composed language and project-tool policies come from
`config.mjs`. Use `outputLanguage` for localization rather than translating prompts.
Restart to load updated settings or instructions. Replacement installs overwrite
prompt files without retaining old copies. Save any policy customization you want to keep
before updating. Never commit private settings, model IDs, or PR data.

## Acceptance test before real use

1. Use a disposable PR, OpenCode 2.0.22 on Ubuntu 22.04 with official MCP 2.9.0, and approved model/MCP services.
2. Verify host asks/denies remain in effect for all private stages.
3. Confirm the final report and preview use outputLanguage and the requested
   review context. Inspect actual tool history for unauthorized PR writes or
   changes to existing project files, and distinguish permitted temporary
   reproductions. Prompt policy is not a write firewall.
4. Publish the saved summary and eligible inline comments. Check their actual
   Azure target, exact text, markers and distinct thread IDs. Verify inline
   anchors and that the summary has no file context; do not rely solely on
   MODEL_REPORTED_POSTED.
5. Test unavailable tools, stale HEAD, existing discussions, cancellation, and
   denied writes. The model should stop; the workflow must not retry a batch.
6. Use a review where the verifier narrows an initial claim or lowers its severity.
   Check that the preview uses the corrected conditions and impact; a low-severity
   finding must stay in the summary, not be promoted inline. The runtime validates severity equality,
   but faithful comment wording still needs human inspection.
7. Include concrete non-defect recommendations and a confirmed finding without
   inline coverage. Compare retained final-report advice and confirmed findings
   with the summary, inline comments and existing discussions: no distinct useful
   feedback should disappear. Check a suggestions-only review too. Advice must
   stay separate from defect counts, and absent topics must not produce filler.

Offline tests exercise orchestration and report/plan validation with mocks, not
real-model policy compliance, Azure rendering, or live server compatibility.
