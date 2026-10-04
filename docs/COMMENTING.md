# Human-readable Azure PR comments

`/pr-comment` is a separate, opt-in workflow for turning a completed review into a small number of actionable inline discussions. Review prompts instruct models not to modify anything; MCP permissions are governed by OpenCode. Planning and explicit publication use the originating review's risk model: `models.review.risk` or `models.deep.risk`. This profile stays attached to the saved review even if another mode runs afterward. Comments do not rerun the reviewers or switch profiles. Check the selected model's actual cost; no role implies a pricing tier.

## Policy and rationale

The policy draws on three public practices:

- [Google's review-comment guidance](https://google.github.io/eng-practices/review/reviewer/comments.html): explain the reason, be constructive, and distinguish important changes from optional advice. Here, comments describe the triggering condition and impact, then suggest a focused correction or test.
- [Conventional Comments](https://conventionalcomments.org/): structured labels make feedback easier to scan. Here, `issue (high):` and `issue (medium):` identify actionable defects. These are this project's severity labels, not Azure votes or assertions that a merge is blocked.
- [Microsoft's Azure PR guidance](https://learn.microsoft.com/en-us/azure/devops/repos/git/review-pull-requests?view=azure-devops): use line-specific discussion for local code issues. Here, publish inline only; keep the long report and all skipped findings in OpenCode.

The following limits are project choices, not universal standards:

| Rule | Default |
| --- | --- |
| Eligibility | Confirmed high/medium-impact defects only |
| Volume | At most 5 saved comments; configurable from 1 to 10; one publishing stage per review |
| Comment size | At most 1,200 body characters, plus runtime AI/model disclosure and a hidden deduplication marker |
| Anchor | Smallest useful 1-5 line range in a changed HEAD file |
| Structure | Short issue title; triggering condition and impact; correction or regression test |
| Language | Shared `outputLanguage` for the final report and comment prose; identifiers and machine-readable labels unchanged |
| Duplicates | One root cause per thread; skip existing discussions, including resolved ones |
| Exclusions | Speculation, unanswered questions, cosmetic nits, optional refactoring, praise, and no-issues summaries |
| Unlocatable findings | Explain the skip locally; never invent an inline location |

Example body (shown in English; the actual body uses the shared `outputLanguage` setting):

```text
issue (high): Missing records bypass the fallback

When the lookup returns no record, this property access throws before the fallback runs. A previously supported request then returns an error.

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
qualifications when translating a finding into a short comment. The model still
assesses relevance and semantic duplicates; the runtime cannot prove those
judgments or the comment's meaning correct. Inspect the preview.
If the verified claim cannot fit faithfully within the per-comment body limit, the planner
must explain the skip locally rather than omit essential conditions to fit.

## Preview and publish

A COMPLETE review can enter comment preview in its original session/process.
There is no additional veto based on initial coverage disclosures or incomplete
initial reviewers after the independent verifier passes the final evidence,
identity/version and original-ID checks. Retained limitations accompany the
planner, which still checks current source, anchors and existing discussions.
PARTIAL, STALE and interrupted final results remain readable but do not enter the
comment cache. COMPLETE is not automatic publication or a guarantee that an
eligible, nonduplicate inline comment exists.

Publication has no separate configuration switch. It requires a saved preview
and an explicit `--publish` in the same original session/process.
Set outputLanguage (for example, zh-TW) to control both final-report and comment
prose. Initial reviewers use the same language so the verifier does not need to
switch from an English handoff. Structured keys, identifiers and source quotes
remain unchanged. Language compliance is model behavior, not a completion gate.

From the same original conversation/process:

```text
/pr-review https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/123
/pr-comment <completed-review-id>
/pr-comment <completed-review-id> --publish
```

The preview shows the comment count, complete saved content (body, AI/model
disclosure, marker), locations, and skip reasons even in receipt mode. There is
no numerical comment quota: all independently actionable eligible findings can
be included. Duplicate, low-severity or unsupported findings still need skip
reasons; removing the count limit does not relax evidence or anchor checks.
Inspect it before requesting publication. The publisher receives the saved
content and coordinates, not a freshly generated plan. It is instructed to
send the content exactly, without translation or relocation.
The runtime derives `startOffset` and `endOffset` from the saved anchor using
the Azure SDK's one-based, line-local character positions. These are not file
byte offsets and do not add required fields to the planner's output. The
publisher maps the complete saved positions to the available tool schema;
actual remote coordinates still require independent verification.

Every saved comment ends with one short disclosure: it is an AI-generated review,
not human review or approval, followed by the distinct selected provider/model IDs
from the review stages and comment preparation/publication. Repeated model IDs
appear once. For example, using placeholder IDs:

```text
AI-generated review; not human review or approval. Models: `provider/model-a`, `provider/model-b`
```

The disclosure follows the report's `outputLanguage`. The full report retains
the per-role model ledger and review method. The runtime generates attribution
from invoked review stages, not from the planner's prose; unused configured
models are not listed. This disclosure also applies when the MCP uses a personal
account. Check company policy before publishing. The publisher preserves the
entire saved footer. Exact remote content still depends on model/MCP compliance;
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
in this same session, subject to host permissions. Other local files remain
prohibited. Saved response offsets are not source-file coordinates, and an
incomplete server response remains incomplete after saving. A partial duplicate
listing or missing source cannot qualify a comment for publication. Inspecting a
saved create result never grants another publishing attempt.

The target parser currently accepts canonical dev.azure.com and hosted
organization.visualstudio.com PR URLs. This identifies the intended target;
it does not independently verify the identity returned by an MCP operation.
On-premises Azure URLs are not currently supported for the comment workflow.

## What is enforced and what is instructed

The runtime checks plan structure: known confirmed finding IDs, maximum plan
size, high/medium labels matching the verified finding, body length, changed-file paths, 1-5 line ranges, anchor
line count, and an explanation for every skipped eligible finding. It adds stable
markers. These checks are not proof that source lines or findings are correct.

Reading source, checking HEAD/identity, finding duplicate discussions, using only
create operations, sending exact content to the intended PR, and verifying the
actual create response are **model instructions**, not MCP-call guards.

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

Completed reviews/previews are actionable only in this process (latest 20 reviews).
Restarting clears that cache, not OpenCode history. Empty plans start no publisher
and do not request a summary thread.
Optional debug files preserve a private diagnostic copy but cannot restore a
publication authorization or plan after restart.

## Customization

Installed instructions are in plugins/azpr-v2/prompts/comment-policy.md,
comment-plan.md, and comment-publish.md. Review-only instructions remain in
common.md. Use outputLanguage for localization rather than translating prompts.
Changing installed settings requires a restart; updating replaces prompt files
without retaining old copies. Save any policy customization you want to keep
before updating. Never commit private settings, model IDs, or PR data.

## Acceptance test before real use

1. Use a disposable PR, OpenCode 2.0.22 on Ubuntu 22.04 with official MCP 2.9.0, and approved model/MCP services.
2. Verify host asks/denies remain in effect for all private stages.
3. Confirm the final report and preview use outputLanguage and the requested
   review context. Inspect actual tool history: review and preview should make
   no modifications, but this is not guaranteed by the plugin.
4. Publish one saved comment. Check its actual Azure target, text, line anchor,
   marker, and thread ID; do not rely solely on MODEL_REPORTED_POSTED.
5. Test unavailable tools, stale HEAD, existing discussions, cancellation, and
   denied writes. The model should stop; the workflow must not retry a batch.
6. Use a review where the verifier narrows an initial claim or lowers its severity.
   Check that the preview uses the corrected conditions and impact; a low-severity
   finding must be skipped, not promoted. The runtime validates severity equality,
   but faithful comment wording still needs human inspection.

Offline tests exercise orchestration and report/plan validation with mocks, not
real-model policy compliance, Azure rendering, or live server compatibility.
