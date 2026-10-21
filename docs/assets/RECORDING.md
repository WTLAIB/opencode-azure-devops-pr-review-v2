# Recording a real demonstration

The capture tools record an actual terminal. They do not generate review
findings, replay a fixture provider, or imitate the Azure DevOps web interface.
They are optional documentation tools, not plugin dependencies.

## Prepare a dedicated test

Use a test repository and a pull request containing a small, deliberate defect.
A pagination change from `items.slice(start, start + size)` to
`items.slice(start, size)` is easy to understand and reproduce. Record the exact
source commit, plugin revision, OpenCode version, selected model IDs, and date.
The model may find the defect, miss it, or find additional issues; show what it
actually returns.

Use an isolated OpenCode configuration and state directory, set
`outputLanguage` to `en`, and close unrelated conversations. Keep the PAT in an
owner-only file outside the recording directory. Do not print configuration,
provider credentials, host authorization, or personal session history.
Starting the review uses the configured model service. Publishing writes to
Azure DevOps. Confirm that those actions are within the operator's authorized
scope before running them.

## Capture the terminal

`record-terminal.py` needs Python 3 on a POSIX system. Supply the real OpenCode
binary, host URL, and session ID. Set any host authentication in the environment,
not in the command line or recording metadata. This attaches to an existing
OpenCode session; it does not start a review by itself.

```sh
python3 docs/assets/record-terminal.py \
  --output .local/live-demo/session.cast \
  --control .local/live-demo/control.jsonl \
  --columns 144 --rows 32 \
  --cwd /absolute/path/to/the/test-project \
  -- /absolute/path/to/opencode --server http://127.0.0.1:PORT --session SESSION_ID
```

Append one JSON object per line to the private control file when a command or
navigation is needed. This sends real terminal input. `submit` sends OpenCode's
extended Enter key; a slash completion may first need Enter to accept it, then
another Enter to submit. Observe the recording or session before submitting a
second time. Do not put passwords or tokens in this file.

```json
{"text":"/pr-review https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/NUMBER"}
{"key":"submit"}
```

Capture the same conversation through this sequence, waiting for each receipt:

1. `/pr-check <test-pr-url>` — configuration and access readiness.
2. `/pr-review <test-pr-url>` — two reviewers and independent verification.
3. `/pr-comment <review-id>` — the saved comment preview.
4. `/pr-comment <review-id> --publish` — the publication receipt.
5. Repeat the publication command — existing comments return `ALREADY_PRESENT`.
6. Read the published comments back from Azure DevOps, showing the actual
   response. A terminal readback is labeled as such; it is not a browser
   screenshot. Keep the successful test comments for inspection.

Stop the recorder with SIGINT or SIGTERM. This closes its attached terminal;
operate the underlying host and any active review separately. The private cast
has mode `0600`, but it still contains everything that appeared in the terminal.
Inspect every frame and remove sensitive content before publishing it.

## Edit timing, not findings

The renderer needs optional installations of **Pillow**, **pyte**, and either
**FFmpeg** or **imageio-ffmpeg**. For example, install them in a separate Python
virtual environment; they must not be added to the plugin package. The default
font is DejaVu Sans Mono. If it lacks the comment icons, provide an existing
emoji-capable font with `--emoji-font /absolute/path/to/font.ttf`; fonts are not
copied into the media or distributed with this project. Use `--crop-bottom 2`
when the last two terminal rows contain only the local status/path bar and a
blank margin. This crops the rendered viewport, adds a visible crop disclosure,
and leaves the original cast untouched. Inspect the rows first; never crop a
finding or result.

Create an edit manifest describing the portions of the original recording to
show. `start` and `end` are seconds in the cast. `seconds` is the output duration.
Use a 60–90 second walkthrough and a separate 10–15 second teaser. Keep the
review, preview, publication, and repeat-publication results readable. Do not
replace model text with hand-written findings. The renderer always labels the
result as an edited terminal replay with shortened waiting time.

```json
{
  "segments": [
    {"start": 2, "end": 7, "seconds": 5, "title": "Review a test PR with a seeded pagination defect"},
    {"start": 30, "end": 150, "seconds": 8, "title": "Two reviewers, followed by independent verification"},
    {"start": 151, "end": 155, "seconds": 12, "title": "Read the actual review result"}
  ],
  "screenshots": [
    {"at": 155, "name": "live-review.png", "title": "Actual OpenCode review result"}
  ]
}
```

The example times above are placeholders, not measurements. Select times from
an actual completed recording before rendering:

```sh
python3 docs/assets/render-terminal-demo.py \
  .local/live-demo/session.cast .local/live-demo/walkthrough-edit.json \
  --output .local/live-demo/azpr-live-demo.mp4

python3 docs/assets/render-terminal-demo.py \
  .local/live-demo/session.cast .local/live-demo/teaser-edit.json \
  --output docs/assets/live-review-teaser.gif --gif --fps 5
```

Upload the inspected MP4 as a release attachment; keep large raw recordings
out of Git. Copy only the inspected PNG frames and short GIF into `docs/assets/`.

The renderer consumes only recorded output in source order. Titles and the
editing disclosure appear outside the terminal content. It does not start
OpenCode, contact a model or Azure DevOps, or alter the recording. Screenshots
are faithful rendered terminal frames, not captures of a desktop browser.

Before distribution, verify the finished video, GIF, and screenshots, and scan
them and their extracted text for secrets and unrelated private content. Keep
raw casts, host connection files, private evidence and edit manifests under
`.local/`. Publish only inspected media and a concise, redacted evidence note.
