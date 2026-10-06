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
| Eligibility | Summary indexes confirmed findings; inline comments require high/medium-impact defects |
| Volume | No numerical comment quota; one publishing attempt per review |
| Comment size | At most 1,200 body characters, plus runtime AI/model disclosure and a hidden deduplication marker |
| Anchor | Smallest useful exact range in a changed HEAD file; no fixed line-count maximum |
| Structure | Observable issue title; 📝 Summary; 🔎 Evidence; 💡 Suggested fix |
| Language | Shared `outputLanguage` for the final report and comment prose; identifiers and machine-readable labels unchanged |
| Duplicates | One root cause per thread; skip non-deleted discussions, including resolved ones |
| Exclusions | Speculation, unanswered questions, cosmetic nits, optional refactoring, praise, and unsupported clean bills of health |
| Unlocatable findings | Explain the skip locally; never invent an inline location |

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
`MERGED` originals are not published. A new concern mentioned only in free-form
report text is not automatically converted into a publishable finding. Every
supplied finding is either in the preview or explicitly skipped with a reason,
including low-severity findings that cannot be posted. The planner must preserve
the verified severity; the runtime rejects both promotion and demotion instead
of silently revising the verifier's conclusion. Preserve the trigger and all
qualifications when adapting a finding into a short comment. The model still
assesses relevance and semantic duplicates; the runtime cannot prove those
judgments or the comment's meaning correct. Inspect the preview.
If the verified claim cannot fit faithfully within the per-comment body limit, the planner
must explain the skip locally rather than omit essential conditions to fit.

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
metadata line in the PR summary. Low-severity findings may appear in this index but cannot
be promoted into inline issues. Full source/decision details remain local.

This summary guidance draws on the brief context and PR-wide feedback in
[n8n's review skill](https://github.com/n8n-io/n8n/blob/master/.agents/skills/human-like-code-review/SKILL.md),
the behavior and dependency context in
[CodeRabbit's walkthrough guidance](https://www.coderabbit.ai/blog/explainable-prs-and-smarter-reviewer-routing),
and the ordered actions in
[Anthropic's PR Review Toolkit](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/pr-review-toolkit/commands/review-pr.md).
Only those presentation ideas are adopted; they add no review stage or required field.

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
existing saved preview, or runs the planner once and saves the validated plan
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
The comment planner receives successful multiline tool text captured during the same
review, with the original request arguments beside numbered rows. Identical
observations are shared once. This is temporary in-process review data; it needs
no checkout, clone, repository mapping or additional model request. Native
shell/read output and flagged failed/truncated results are not cached here.
Observed text is not certified provenance: select the matching commit/path and
check missing source and mutable PR/discussion state. It helps avoid inventing
anchor text from a finding description. Prefer a concise anchor; exact longer
ranges are accepted instead of failing on an arbitrary five-line maximum.

When using preview, inspect it before requesting publication. Direct publication
returns the prepared comments and any attempt outcomes; a publisher failure also
retains the exact prepared content for inspection. The publisher receives only the target,
snapshot, output language, saved general summary and inline comments, including their exact content,
anchors and coordinates. The full review, findings and tool-text collection stay
with planning. The publisher sends saved content without translation or relocation.
It checks current PR identity/HEAD and complete discussions once before the batch,
then creates comments sequentially. It reuses preview-verified immutable anchors;
additional reads are for missing or uncertain evidence, not a mandatory repeated
source/PR/thread scan for each comment. Complete returned discussions and explicit
deletion records do not need individual rereads. These remain model instructions,
not an independently enforced remote-state certificate.
The runtime derives `startOffset` and `endOffset` from the saved anchor using
the Azure SDK's one-based, line-local character positions. These are not file
byte offsets and do not add required fields to the planner's output. The
publisher maps the complete saved positions to the available tool schema;
actual remote coordinates still require independent verification.

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
in this same session, subject to host permissions. Local project verification
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
kept only in this plugin instance's process memory, across its conversations.
The cache holds the latest 20 completed reviews; the next completion evicts the
oldest. There is no elapsed-time expiry, background disk purge, or run-ID file
database. Unloading the plugin or restarting the process clears the memory cache.
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
   finding must be skipped, not promoted. The runtime validates severity equality,
   but faithful comment wording still needs human inspection.

Offline tests exercise orchestration and report/plan validation with mocks, not
real-model policy compliance, Azure rendering, or live server compatibility.
