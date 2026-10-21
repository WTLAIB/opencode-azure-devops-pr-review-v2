# See a review before installing

## A real review, preview and publication

[Watch the 73-second walkthrough (MP4)](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/releases/download/v0.1.0/azpr-live-demo.mp4)

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
an independently attested provider backend.

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
   comments. The successful demonstration comments are retained.

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
