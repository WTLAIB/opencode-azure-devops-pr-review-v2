# See a review before installing

## Actual Azure DevOps comments

These are **real Azure DevOps browser captures** of comments published by AZPR,
from a dedicated test PR containing three deliberately seeded regressions in
`fulfillment.py`. They show the final output of a separate English-language run,
not the final state of the adjustment recording below.

### Inline comment with code context

[![Actual inline comment: fulfillment.py changes a deep copy to a shallow copy, and AZPR explains the shared-state defect with evidence and a suggested fix.](assets/azure-inline-review.png)](assets/azure-inline-review.png)

### Complete PR summary

[![Actual PR summary: a review note, zero high, three medium and zero low findings, and all three findings with their source locations.](assets/azure-review-summary.png)](assets/azure-review-summary.png)

The review and publication ran on **2026-10-29 (Asia/Taipei)** with **AZPR
0.3.1**, **OpenCode CLI 2.1.4** and `openai/gpt-6-luna` for the review roles and
comment planning. The runtime posted one summary and three inline comments and
read all four back from Azure DevOps. Model IDs identify the configured
selection, not an independently attested provider backend. The browser captures
were taken on **2026-10-30**; no review or publication was rerun to create them.

The images compose actual screenshot excerpts inside a presentation frame.
Author rows, account and organization details, unrelated navigation and action
buttons are omitted; the inline image joins the file/diff and comment excerpts.
Titles, background and spacing are added outside those excerpts. The source
code, line numbers, finding text, counts and AI/model disclosures are preserved
at the captures' original pixel resolution. Raw captures and private evidence
stay outside the public assets.

This synthetic test demonstrates the workflow and output format. It is not a
review-accuracy benchmark or a promise about another PR's findings, latency or
cost. See [validation and limitations](VALIDATION.md).

<details>
<summary>Read the pictured comments as text</summary>

The text below preserves the published bodies; hidden publication markers are
omitted. The inline comment is anchored at `fulfillment.py:29`.

🟡 medium: Snapshot exposes mutable internal state

**📝 Summary**
When a caller edits nested stock or batch data in the returned snapshot, those edits also change live reservation state; later reservations can likewise affect an earlier snapshot.

**🔎 Evidence**
`.copy()` copies only the outer dictionary, leaving `self._stock` and `self._batches` shared.

**💡 Suggested fix**
Return a deep copy of the snapshot contents. Test that edits to nested snapshot data do not change live state and that later reservations do not alter an earlier snapshot.

---
AI-generated review; not human review or approval. Models: `openai/gpt-6-luna`

🤖 AI-generated review; not human review or approval. Models: `openai/gpt-6-luna`

## PR Review Summary

**Review notes**

The fulfillment refactor changes reservation validation, snapshot copying, and dispatch sorting; restoring atomic updates, isolated snapshots, and absolute-instant ordering will preserve the documented contracts.

high: 0 · medium: 3 · low: 0

| Severity | Summary | Location |
| --- | --- | --- |
| 🟡 medium | F-1 — A batch with an invalid later item can decrement earlier stock before raising, violating the all-or-nothing reservation contract. | head:/fulfillment.py:24 |
| 🟡 medium | F-2 — &#96;snapshot()&#96; exposes references to internal stock and reservation history, allowing callers to mutate live state through the returned snapshot. | head:/fulfillment.py:29 |
| 🟡 medium | F-3 — Dispatch ordering compares local wall-clock fields instead of absolute instants, so offset-aware schedules can be returned in the wrong order. | head:/fulfillment.py:37 |

</details>

## Adjust findings before publishing

![Real OpenCode terminal recording: a preview with three verified findings, the command that excludes F-3 and lowers F-2 to low, the new preview, and publication read back from Azure DevOps.](assets/adjust-findings-teaser.gif)

The 15-second teaser uses a **real OpenCode 2.1.4 session, real configured
model calls and real Azure DevOps publication** on the same dedicated test PR
as the earlier recording below: one `fulfillment.py` file with three
deliberately seeded regressions. It demonstrates the workflow; it is not a
benchmark of review accuracy or a promise about the time or cost of another PR.

Recorded on **2026-10-26**, on Ubuntu 22.04 under WSL2, using
`openai/gpt-6-luna` for the functional reviewer, risk reviewer, verifier and
comment planner. The installed plugin matched all 27 runtime and prompt files
in public Git commit [`dfba561`](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/commit/dfba561840c0d61be6f8fc2e921507da8bbcbb11)
of the 0.3.0 release candidate. Model IDs identify the configured selection,
not an independently attested provider backend.

The recording follows one conversation:

1. `/pr-review <test-pr-url> --preview` completes the review in 66 seconds. The
   verifier confirms three medium findings and merges two duplicate candidates.
   The automatic preview, 14 seconds later, prepares a summary and three inline
   comments; nothing is posted.
2. `/pr-comment 63f7d3d6 --exclude F-3 --severity F-2=low` plans a new preview
   in 8 seconds. F-3 is left out, F-2 is listed as low in the summary with no
   inline comment, and the preview names both adjustments.
3. `/pr-comment 63f7d3d6 --publish` posts the summary and the F-1 comment; both
   are read back from Azure DevOps as `VERIFIED`.
4. Repeating the command reports `ALREADY_PRESENT=2`; nothing is posted twice.
   The two demonstration comments were retained when this recording was made.

![Actual new preview after excluding F-3 and lowering F-2 to low: the adjustments, the summary counts and the index with F-1 as medium and F-2 as low.](assets/adjust-preview.png)

![Actual publication receipt: F-2 is skipped as a low finding, and the summary and the F-1 comment are read back as VERIFIED.](assets/adjust-publication.png)

These are faithful rendered frames from one terminal capture, **not Azure
DevOps browser screenshots**. Commands were submitted through OpenCode's native
command API to the session shown in the attached TUI, so they appear as AZPR
notices and segment captions rather than as typed input. The TUI sidebar was
hidden before the segments shown, and the bottom seven rows (the empty input
box with the conversation's chat model, and the status/path bar) are cropped.
Segments that showed the local debug directory were left out. The original
private cast is unchanged.

## Earlier recording: review, preview and publication

[Watch the 73-second walkthrough (MP4)](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/releases/download/v0.2.0/azpr-live-demo.mp4)

![Real OpenCode terminal recording: inspect an independently verified finding, preview its comment, and repeat publication without duplicate comments.](assets/live-review-teaser.gif)

The 12-second teaser and full walkthrough use a **real OpenCode 2.1.2 session,
real configured model calls, and real Azure DevOps publication**. The dedicated
test PR changes one `fulfillment.py` file with three deliberately seeded
regressions. It is a reproducible workflow demonstration, not a benchmark of
review accuracy or a promise about the time or cost of another PR.

Recorded on **2026-10-22**, on Ubuntu 22.04 under WSL2, using
`openai/gpt-6-luna` for the functional reviewer, risk reviewer, verifier, and
comment planner. The installed plugin matched all 27 runtime and prompt files
in commit [`f323aaa`](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/commit/f323aaab31e98da0ffed08a8f54fca94c7caf651),
the v0.1.0 release candidate. Model IDs identify the configured selection, not
an independently attested provider backend. The v0.2.0 release reuses this
recording unchanged; it demonstrates the manual workflow, not the new automatic
comment step.

The recording follows one conversation:

1. `/pr-check <test-pr-url>` confirms access and model readiness.
2. `/pr-review <test-pr-url>` runs two reviewers and an independent verifier.
   The verifier confirms three findings and merges the three duplicate
   candidates from the other reviewer.
3. `/pr-comment 268cc3f3` prepares a summary and three inline comments. The
   receipt explicitly says that nothing was posted.
4. `/pr-comment 268cc3f3 --publish` creates four comments. Each is read back
   from Azure DevOps and reported as `VERIFIED`.
5. Repeating the publication command reports `ALREADY_PRESENT=4`. A separate
   Azure REST read confirms the same four active threads, with no extra
   comments. The successful demonstration comments were retained when this recording was made.

Measured command durations were 64.95 seconds for review, 15.63 seconds for
preview, 1.52 seconds for publication, and 0.51 seconds for repeated publication.
The video includes reading pauses and cuts waiting and navigation time; its
length is **not** a latency measurement.

### Inspect the actual output

![Actual OpenCode review: the verifier confirms that a shallow snapshot shares nested state, with source location, evidence, counterevidence and a correction.](assets/live-review.png)

![Actual comment preview: the shallow-copy finding includes a summary, evidence, suggested fix and AI disclosure before publication.](assets/live-preview.png)

![Actual Azure DevOps REST read-back: four active threads and the unchanged published shallow-copy comment.](assets/live-azure-readback.png)

These are faithful rendered frames from terminal captures, **not Azure DevOps
browser screenshots**. Commands were submitted through OpenCode's native
command API to the same session shown in the attached TUI. The separate
read-back clip executes an actual Azure DevOps GET and displays the returned
comment; author details, deleted history and hidden publication markers are
omitted, while the comment wording stays unchanged. The TUI frames preserve
the displayed review text; only the bottom status/path row and its blank margin
are cropped to avoid exposing the local workspace path. The original private
cast is unchanged. Captions and the editing disclosure are outside the terminal
content.

No credential, provider configuration, or private reasoning is included in the
published media. Raw recordings and connection files remain private. See the
[capture and editing guide](assets/RECORDING.md) to reproduce this process, and
[validation](VALIDATION.md) for the broader test evidence and limitations.

## Illustrative quick-review example

The example below is an **illustrative example / synthetic PR**, not an Azure
DevOps screenshot or an OpenCode session recording. A hand-written pagination
defect shows the quick-review comment format. No live model was called and no
Azure comment was published to make these illustrations; they are separate
from the real verified review above.

### A short walkthrough

The animation shows four steps, takes 21 seconds and plays twice. Its pacing is
for reading; it does not measure review latency. Prefer no animation? Use the
[static walkthrough](assets/walkthrough.svg) or the text below.

![Illustrative example / synthetic PR: check setup, run a quick review, preview comments, and optionally publish.](assets/quick-review-demo.gif)

1. **Check setup and PR access:** run `/pr-check <azure-pr-url>`, replacing the
   placeholder with a real PR you are authorized to review. The command checks
   PR, source and discussion access, plus plugin configuration and model
   readiness. Resolve errors and inspect warnings. This deterministic check
   does not call a review model.
2. **Review:** run `/pr-quick <azure-pr-url>` for the same PR in your OpenCode
   conversation.
   Wait for completion, then inspect findings and coverage gaps. Quick review
   uses one reviewer per shard, without an independent verifier. Findings are
   `REPORTED`, and verification is `none`; a session can make multiple model
   requests.
3. **Preview:** run `/pr-comment` in the same conversation. A model plans the
   inline comments and summary; the preview does not write to Azure. Read the
   proposed text and skips before deciding whether to publish.
4. **Publish only when ready:** `/pr-comment --publish` uses the saved preview.
   The runtime rechecks the PR, skips existing markers and writes the comments.
   Inspect the publication receipt for results. This optional step writes to
   Azure; it was not executed for this demo.

The example is one small PR and one finding, not a promise about the number of
sessions, requests, findings or cost for your PR. See [Commenting](COMMENTING.md)
for publication details, retries, markers and their limits.

### What the comments look like

![Illustrative Azure DevOps-style layout: a medium pagination finding with Summary, Evidence and Suggested fix, followed by a PR summary index. Both show that quick review was not independently verified.](assets/review-example.svg)

The layout, colors and spacing are illustrative. The comment text and summary
index come from the project's comment-plan validator and renderer, supplied
with a hand-written fixture. `example/model`, the repository, PR, code and
finding are synthetic. The illustration simplifies formatting; read the
[exact generated comment bodies](assets/example-comments.md) for accessible
Markdown, including the disclosure and headings. Hidden publication markers
are omitted from that document.

The example code passes the page size as `Array.slice`'s end index. For page
size 2 and offset 1, both the start and end are 2, yielding an empty array.
The suggested change is `items.slice(start, start + size)`. This is a teaching
example, not evidence of review accuracy. [Validation](VALIDATION.md) records
actual tests and distinguishes simulated services from live runs.

### Reproduce these illustrations

From the repository root, with Node.js 22.12 or later:

```sh
node docs/assets/generate-demo.mjs
```

This uses only Node.js and the existing source modules. It validates the
synthetic plan, assembles the real comment text and regenerates
`review-example.svg`, `walkthrough.svg` and `example-comments.md`. It makes no
network requests, starts no model session and needs no credentials.

Regenerating the optional GIF also needs existing installations of
[Sharp](https://sharp.pixelplumbing.com/) for SVG rendering and
[Pillow](https://pillow.readthedocs.io/) for GIF encoding. These are documentation
tools, not plugin dependencies. With Sharp resolvable by Node and Pillow
available in Python:

```sh
node docs/assets/generate-demo.mjs --frames
python3 docs/assets/generate-demo-gif.py
```

For a separately installed Sharp package, set `AZPR_DEMO_SHARP` to its absolute
package directory when running the first command. Intermediate PNGs go only to
`.local/project-launch-demo-assets/`; they must not be committed. The checked-in
SVG, GIF and Markdown files can be viewed without these optional tools.
