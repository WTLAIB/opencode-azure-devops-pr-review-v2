# Debugging reviews

Keep a failed run and inspect its original evidence before changing settings or
starting another model request. A passing test does not establish provider
acceptance, Azure source validity or report quality.

## A startup slash command becomes an ordinary prompt

On OpenCode 2.1.2 to the tested version, `opencode --prompt "/pr-review ..."` can
submit before the terminal UI has loaded the commands. The host then
treats the text as an ordinary model prompt; AZPR has not received the command.
This was observed in local native-package TUI acceptance failures on 2.1.2 and
matches the host's
[startup submission](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/routes/home.tsx#L68)
and [command classification](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/tui/src/component/prompt/index.tsx#L1150).

OpenCode 2.4.0 and 2.4.1 do this far more often. With a project directory the
service had not loaded yet, the text went out as an ordinary prompt in 14 of
16 terminal UI starts in a fixture (1 of 12 on 2.3.0 and 2.3.2), and in 10 of
those 14 the conversation's model was OpenCode's built-in free model instead
of the configured one, so the PR URL and the context you wrote would be sent
there.

From 0.5.1 AZPR stops such a prompt: a prompt of an ordinary conversation
that begins with one of AZPR's commands is refused before any model gets it,
and the conversation is told:

```text
[AZPR] /pr-review reached OpenCode as an ordinary prompt, not as a command, so AZPR stopped it: nothing ran and no model received it. …
```

The terminal UI then shows `Failed to set up session` and may try again in a
new conversation, which leaves a few empty conversations behind; a retry that
finds the commands loaded runs the command. AZPR stops such a prompt before
a first setup as well, and while its settings cannot be used or settings of
0.4.x wait for their update; a retry that finds the commands loaded then gets
the command's own answer, which says what AZPR still needs. It cannot stop a
prompt where OpenCode has not loaded the plugin (not yet, or because loading
it failed, which OpenCode reports), and it stops none while it is switched
off (`enabled: false`).

Do not start AZPR's commands with `--prompt`. Start the TUI and wait for
`/pr-review` to appear in slash-command completion before submitting it; a
script uses the command endpoint (`POST /api/session/<id>/command`), which
waits for the plugins. A command admitted by AZPR emits its own
`[AZPR ...] STARTED` receipt. Do not treat an ordinary assistant response as that
receipt or repeat a command without checking the original conversation. The
host fixture exercises interactive submission in both new and existing
conversations and verifies that `/pr-stop` cancels from that same TUI.

## Where things are

| Location | Contents |
| --- | --- |
| Receipt in the invoking conversation | Status, coverage and `verification none` in its first line, per-stage rows (role, pass and shard, session, model, attempts, repair turns, tool errors/timeouts, failure class) and notices. |
| `PROGRESS` notices | Phases of the run: snapshot, session counts, the duplicate check, the severity rating, retries, planning pages, posting. |
| The last review session (a severity rating when one ran, otherwise a duplicate check or a reviewer; the receipt names it) | The rendered report (`# AZPR <id> — <status>`). |
| `${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2/reviews/` | Persisted completed reviews (plans and publication ledgers included). |
| `…/azpr-v2/receipts/` | Receipts that could not be queued to the conversation after three attempts. |
| `…/azpr-v2/data/` | Private source excerpts and large comment inputs for persisted reviews. |
| Debug directory (below) | Optional per-run diagnostics. |

## The terminal panel does not appear

The [terminal panel](../README.md#terminal-panel) is loaded by OpenCode's
terminal UI, not by the service, and only when the terminal UI starts.

- **After installing or upgrading**, quit the terminal UI and start it again.
  `/pr-panel` then appears among the slash commands.
- **It does not open by itself.** The setting `terminalPanel` may be
  `manual`; set it to `auto` and restart the OpenCode service. In a terminal
  with fewer than 108 columns the panel only announces itself; `/pr-panel`
  shows it. It also
  stays closed while a dialog or another plugin's panel is open, and in a
  conversation that is not on screen when the notice arrives.
- **`/pr-panel` is missing.** Look for `plugin operation failed` in OpenCode's
  log (`${XDG_DATA_HOME:-~/.local/share}/opencode/log/opencode.log`): it names
  the file that did not load and why. `opencode plugin list` shows whether
  the plugin is active; the service lists it with a terminal part
  (`features.tui`).
- **The panel says the report is in its session.** The session that held the
  report was deleted or its report could not be read; the receipt in the
  conversation still names it, and `/pr-comment --show` shows a saved preview
  again.
- **Nothing to pick at the foot of the panel.** The steps are offered by the
  notice that happened last, and only by a comment preview or by a review
  that no preview follows: once a run starts or another receipt arrives, they
  are gone, and a run under way offers only **Stop this run…**. A preview
  that an earlier version left in the conversation offers none;
  `/pr-comment --show` shows it again with them. A review with more than 200
  findings offers none either; type the commands its receipt names. A run
  that a version before 0.4.5 started cannot be stopped from the panel; type
  the `/pr-stop` command its STARTED notice shows.
- **The panel says RUNNING, and stopping answers "No active review in this
  conversation matches that request".** The OpenCode process that ran the
  run was restarted, so the run ended without a receipt and the panel has
  nothing that says so. Nothing is running; the next run replaces what the
  panel shows.
- **Their keys are dim and do nothing.** The prompt has the keyboard, so `p`
  would type a letter. Click one of them, or click into the panel's text (or
  use OpenCode's "Focus right pane") to give the panel the keyboard.
- **"Nothing was sent: what the panel showed has changed since."** A question
  was open while the preview was planned again, the run it asked about ended,
  another session came on screen or the panel was closed. Read what the
  panel shows now, then pick.
- **"/pr-comment was not started"** (or "/pr-stop"). The reason follows, as
  for a typed command: another AZPR command is running in the conversation or on the PR,
  the review is no longer kept, or the terminal UI could not reach the
  OpenCode server. "Review … is no longer as it was shown" means that the
  preview was planned again or the findings were adjusted somewhere the
  panel was not told of (the review's own session, another client): run
  `/pr-comment --show` and pick from what it shows.
- **Other clients.** The desktop app and other OpenCode clients do not load
  the panel.

The panel reads AZPR's notices as text. A notice that was edited, or another
plugin's message that begins like one, can show up in it; the panel never acts
on what it shows.

## Enable diagnostics

In the settings file shown by `/pr-setup` (external configuration for native
packages, or installed `plugins/azpr-v2/settings.json` for source installs):

```json
{ "debug": { "enabled": true, "directory": "", "keepRuns": 20 }, "returnReport": "full" }
```

Restart the OpenCode service (`opencode service restart`) after editing. An empty directory selects
`${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2-debug/`; a relative path is
resolved against the active project. Each run creates a unique owner-only
directory named in the receipt. Debug data can contain source, PR details and
secrets echoed by a service; do not commit or upload it. When a run starts,
AZPR deletes its older run directories beyond `debug.keepRuns` (default 20;
`0` keeps all); a run still active in the same OpenCode process and anything
AZPR did not create are left alone. With debug enabled, private data of failed
runs is kept for inspection (stale scratch data is still removed after 24
hours), and every private session of a run is kept: those of a completed
review and of its comment runs until the review is evicted, those of a review
that did not complete within the same limit of 20 runs. OpenCode lists each
of them next to your conversations (`[AZPR <id>] …`); without debug only the
session holding the report or draft stays.

| File | What it records |
| --- | --- |
| `run.json` | Run identity, relevant settings and start time. |
| `readiness.json` | The models that were checked (`reviewers[0]`, `reviewers[1]`, …, and `rater` when one is named), the Azure DevOps organization and api-version, and host capabilities. |
| `NN-ROLE.request.json` | Stage identity, the literal payload and the role instructions. |
| `NN-ROLE.response.json`, `NN-ROLE.response-repairN.json`, `NN-ROLE.response-follow-upN.json` | Visible answers of the first turn, each correction turn and a reviewer's follow-up turn. |
| `NN-ROLE.result.json` | Status, repairs, unresolved issues, corrections, tool observations, failure class, timing and `tokens`: the token usage OpenCode reported for each model request of the stage (`input` without cached input, `cacheRead`, `cacheWrite`, `output`, `reasoning`), their sums and `cachedInputShare`. |
| `report.md` / `draft.md` | Rendered report or unconfirmed draft. |
| `comment-plan.json` | The saved plan with exact content, anchors, offsets and markers. |
| `azure-calls.jsonl` | Every Azure DevOps REST call, from the runtime and the reviewers' AZPR tools: method, call, file path or change page, attempt, HTTP status or error kind, duration, bytes, and whether it will be retried. Never credentials or comment bodies. |
| `result.json` | Final status, every stage record, Azure call and retry counts, the run's token totals with `cachedInputShare`, and warnings; `searchUnavailable` lists why content search could not run, when it could not. A review records the comment step it hands on (`afterReview`: mode and source, when a step or `--no-comment` applies); an automatic comment run records `automatic` (mode, source, `sourceReview` and the reasons in `heldBack`). |
| `delivery.json` | Whether the final receipt was queued (and how many attempts). |
| `conversation-name.json` | For a check or a review, written a few seconds after the command: how naming the conversation ended. `named` (with AZPR's own name for it), `kept` (it had a name, or got one meanwhile), `restored` (a name given in that moment was written back), `unconfirmed` (a name was written, but OpenCode did not report the rename in time) or `failed` (OpenCode refused the write and reported no rename). A name that is not AZPR's own is never recorded. |

The numeric prefix is stage creation order, which differs from run to run
(a receipt lists the stages by their place in the pipeline instead); the
reviewer sessions of all
passes and shards run in parallel, and so do the duplicate checks and the
rating sessions. `ROLE` is the private agent: `azpr-<mode>-reviewer` for the
first pass, `-reviewerb`, `-reviewerc` and `-reviewerd` for the next ones,
`-dedupe`, `-rating` and `-comment-plan`.

## Diagnosis order

1. `result.json`: which stage failed and its `failureClass`:
   - `transient` was retried once in a new session (provider 408/409/425/429/5xx,
     a turn that ended without a complete answer, unexpected message in the turn);
   - `overflow` means the session needed compaction; the runtime split the shard;
   - `permanent` (authentication, bad request, a turn a person interrupted in the
     reviewer's session) was not retried;
   - `idle` means the stage inactivity watchdog stopped the stage after
     `workflow.stageIdleSeconds` without activity; it was retried once in a new
     session. Its error and `idleStop` name the last activity and when it
     happened: after `model request N was sent` the model never answered,
     after `model output was streamed` (or reasoning, or a tool call) the stream
     stopped mid-answer, after `tool X started` a tool did not return, after
     `tool X ended` no next model request came, after `shell asked for
     approval` nobody approved;
   - `cancelled` came from `/pr-stop`, a timeout or unload.
   `requestObservations.retries` lists OpenCode's own retries of a provider
   request (attempt, whether AZPR allowed it, the announced delay).
   Receipt counters show interrupted provider streams that OpenCode recovered
   in the same session: `step-retries` (OpenCode 2.3.0 and later retried the step),
   `stream-continuations` and `continuation-restarts` (earlier hosts asked the
   model to continue, and the model started its answer over). A request to a
   provider host that cannot be reached is retried by OpenCode (2.3.0 and
   later) for up to
   an hour, each retry listed under `requestObservations.retries`; the stage
   waits meanwhile, and `/pr-stop` ends it.
   `requestObservations` also says what AZPR kept from the session's model:
   `placeInstructions` lists the instruction sources of the conversation's
   place that were left out of its requests (`core/instructions` for
   instruction files, `core/mcp-guidance` and so on), `instructionLoads` and
   `instructionUpdates` count the messages that were taken out of its
   requests: those in which OpenCode loaded instruction files beside a file
   the session read (one message can hold several files) and those in which
   it wrote an update, and `placeInstructionsNotToldApart` counts the
   requests in which, when they were prepared, the parts did not have the
   form AZPR knows (or, for the Claude Code provider, its option could not
   be emptied), a message that still had a loaded file's ID was not that
   file as OpenCode builds it, or the list of messages was no ordinary list
   while the session held such a message (a newer OpenCode, or another
   plugin that edited them); AZPR left those as they were. That counter is of what was
   seen while a request was prepared, not of what went out: a request that
   is counted can still be refused when it is sent, and a loaded file that
   another plugin moved elsewhere, or gave another ID, is not seen at all,
   so a counter of zero does not say that no such text went out.
   `shellNotices` on the stage counts the distinct notices of this session's
   background commands in what was looked at for the answers that were
   taken: those in a turn, one that arrived between two turns, and one that
   arrived after a turn's end and woke the session before its answer was
   looked at. A turn that failed after such a notice does not add to it.
   `turnChecks` counts how often the session's messages were read, once
   before every request of an open turn; `refusedOutsideTurn` the requests
   that were refused because they were not a turn's (the notice of a
   background command woke the session after its answer, or before its next
   prompt became a message); and `turnUnreadable` those that were refused
   because the session's messages could not be read, so that nothing was
   known of the turn. `toolsLeftListed` counts the requests whose list of
   tools still held one this role may not call, because another plugin made
   the list something AZPR does not change (a list that cannot be written,
   or one that answers for another object); such a tool is refused when it
   is called. `notesNotAdded` counts the requests of a planning session that
   was to finish without tools in which AZPR could not add its note saying
   so, because the parts were no ordinary list or their place could not be
   written; the tools were unavailable all the same.
2. The failed stage's request, response(s) and result together. `repairs` lists
   what the runtime asked the model to correct; `unresolvedIssues` lists what
   was still wrong after the last turn and therefore downgraded per item. For a
   reviewer, `sessionReads` counts the file contents that session's own
   `azpr_read_diff` and `azpr_read_file` calls showed, the reads its location
   checks accept; the result's `checks` hold each finding's location check,
   under the ID the answer gave it (the review's own IDs, `F-1 … F-n`, are
   given once every session has answered). A duplicate check's result lists
   its `merges` and counts those the runtime `refused` because they would
   have joined two findings of one session; a rating's result lists each
   level with its reason.
   `followUp` records a reviewer's follow-up turn: the turn, the gaps the answer
   named, how many assigned files it did not list as reviewed and the outcome
   (`completed`, `still-partial`, `unusable`, or `failed` with its failure class
   and error); the receipt shows `follow-up=<outcome>`. `repairFailure`
   records a correction turn that failed (its turn, failure class and error)
   or whose answer was not usable (class `unusable`): the stage's latest
   usable answer stands, with the items that turn would have repaired
   degraded, and the receipt shows `repair=failed:<class>`.
3. Cost and prompt cache: `tokens` in each stage record. `cachedInputShare` is
   `cacheRead / (input + cacheRead + cacheWrite)`. On a long session, a request
   whose `cacheRead` is close to the previous request's prompt reused it; a run
   that stays near 0% points at the host's cache affinity rather than at AZPR,
   whose requests keep a stable prefix (OpenCode 2.0.22 with ChatGPT token
   sharing sent no session headers; see [validation](VALIDATION.md)). Stages
   that a cancellation interrupted have no `tokens`.
4. For comments: `comment-plan.json` and the publication ledger in the receipt.
   `FAILED` and `UNVERIFIED` items are safe to publish again; existing items are
   skipped by their markers, and an `UNVERIFIED` item is never sent twice.
   `DELETED` items were deleted on the PR after AZPR created them and are not
   posted again.

Common receipts:

| Message | Next step |
| --- | --- |
| `Azure DevOps rejected the PAT for organization …` | Renew or correct the PAT in `azure.pat` or the file named by `azure.patFile` (organization-scoped, Code Read, Pull Request Threads Read & write) and restart the OpenCode service. |
| `The provider reports the usage quota as used up (provider.quota)` / `ChatGPT reports the subscription usage limit as reached (provider.chatgpt-limit)` / `ChatGPT reports the usage limit set by the workspace's admin as reached (provider.chatgpt-workspace-limit)` and the other used-up usage or spend limits (`provider.free-limit`, `provider.go-limit`, `provider.budget-limit`, `provider.model-budget-limit`) | The stage failed without a retry, which would fail the same way; AZPR also refused OpenCode's own retries. Choose another model in the settings, or wait until the limit resets. |
| `azure.patFile could not be used …` / `azure.patFile changed since OpenCode loaded it` | Make it a regular file you own with only the PAT (`chmod 600`), or restart the OpenCode service after replacing it. |
| `Azure DevOps refused … (HTTP 403 …)` | Add the missing PAT scope or project/repository access. |
| `network error (ConnectionRefused)` with a hint to set `azure.proxy` | dev.azure.com is reachable only through a proxy; set `azure.proxy` (see [proxies](AZURE_DEVOPS.md#proxies-and-tls-inspection)). |
| `the server's TLS certificate was not accepted (…)` | The proxy inspects HTTPS; set `azure.caFile` to its root CA certificate. |
| `A proxy refused … (HTTP 407)` / `A proxy or gateway answered …` | The proxy wants credentials in `azure.proxy`, or it blocks dev.azure.com. |
| `Content search notice: Content search (azpr_search_code) was unavailable: …` (also among the report's limitations) | The repository archive is over `azure.archiveMegabytes`, or is one AZPR cannot read (ZIP64, encrypted, damaged). The review ran, but sessions could not search file contents, so callers and other uses of changed code may be unchecked. Raise `azure.archiveMegabytes` (at most 1024) where the notice names it and restart the OpenCode service; the archive is held in memory during a review. |
| `azpr_read_file failed: …` in a stage's tool errors | The model asked for a missing path or invalid range; the review continues and reports the gap. |
| `The session received another message during this turn; its output cannot be assigned to the authorized request` (`failure=transient`) | Something other than the reviewer's own prompt arrived in its session while it answered, so the answer is not taken; the stage ran once more in a new session. Known causes: a message someone sent to that session; and an answer that reached the model's output limit, after which OpenCode asks the model to go on (a second failure for that reason means the shard's answer is too long for the model: lower `workflow.shardFiles` or use a model with a larger output limit). The instruction files OpenCode loads beside a file a reviewer read, and its notice that a background command ended, no longer count (0.5.1). |
| `The admitted prompt is absent or ambiguous in the session context: it is not among the session's messages exactly once` (`failure=permanent`) | The prompt of that turn is gone from the reviewer's session, or is there twice. Someone may have taken it back in that session in a way that removes it: in OpenCode's terminal UI from 2.4.2 on, Esc twice before the model answered, with an empty prompt box and nothing queued; or `/undo`, which removes a prompt that still waited at once, and a delivered one when another prompt is sent in that session or a compaction is asked for there (OpenCode carries out the take-back before it admits the compaction, which AZPR then refuses); where OpenCode keeps snapshots, `/undo` also puts back at once the files that changed in the working directory during the steps it takes back, whoever changed them. A compaction can also remove it. Nothing of that turn is accepted and it is not tried again: the stage keeps its latest usable answer if it has one (its line in the receipt then says `repair=failed` or `follow-up=failed`), and fails otherwise. Read the receipt before running the review again. To stop a run, use `/pr-stop` in its conversation (or the panel's stop step), not Esc or `/undo` in one of its reviewer sessions: an interrupted turn fails the same way. |
| `Reviewer execution did not finish successfully (session=…; terminal=missing-idle; …; finish=error)` (`failure=permanent`), with `shell: "ask"` or `"inherit"` | A person declined that reviewer's shell request without a message, as OpenCode's full-screen terminal UI and its desktop app decline in AZPR's sessions. OpenCode then ends the reviewer's execution as it does at a shutdown, without the marker that ends a turn, and AZPR takes no answer of that turn, a [known limitation](VALIDATION.md#known-limitations): the stage record says whether the stage kept an earlier answer (`repairFailure`, `followUp`) or failed. Approve the command, or keep `shell: "deny"` where reviewers should run none. |
| `[AZPR] /pr-review reached OpenCode as an ordinary prompt, not as a command, so AZPR stopped it` (any AZPR command) | The text was sent before OpenCode had loaded its commands, typically with `opencode --prompt` at startup; see [above](#a-startup-slash-command-becomes-an-ordinary-prompt). Nothing ran. Type the command once it shows in the slash-command list. |
| `permission.rejected` … `cannot run a shell command that OpenCode cannot analyze` | With shell allowed, a reviewer's command used something OpenCode's scanner cannot follow (an alias, for instance), for which OpenCode 2.4.0 and later ask for every directory; AZPR refuses that, and the model is told to rewrite the command. |
| `permission.rejected` … `cannot use paths outside the local OpenCode project` | A reviewer used a native tool on a repository path; it was refused instead of waiting for an approval and the model was pointed to the azpr tools. |
| `settings.json changed since OpenCode loaded it` | Restart the OpenCode service. Running commands were unaffected. |
| `/pr-deep is off: models.deep.reviewers names no model` (or `/pr-quick`) | That mode's list of reviewer models is empty, and no mode falls back to another mode's models. List at least one with `/pr-setup` (`--deep-model`, `--quick-model`) or in the settings file, then restart the OpenCode service. |
| `The selected review.reviewers[1] model (…) is unavailable in the host catalog` (or `rater`) | The entry at that position of `models.review.reviewers` (positions count from 0), or the named rater, is not a model OpenCode offers; no fallback was selected. Correct it and restart the OpenCode service. |
| Review warning: `The review pass 2/2 shard 1/3 failed (…); its 25 file(s) were not reviewed in this pass` | One reviewer session failed, after a retry where the failure was transient. The other sessions' work is kept: the files count as reviewed when another pass reviewed them, and the second coverage number (files reviewed in every pass) is lower. |
| Review warning: `The duplicate check of /path failed (…); its N findings stay reported and may include duplicates` | The session that compares what different reviewer sessions reported in that file failed. No finding was lost; read those findings for repeats before publishing, or exclude a repeat with `/pr-comment --exclude`. |
| Review warning: `The severity rating failed (…); its N finding(s) keep their reviewer's severity` | A rating session failed, after a retry where the failure was transient. The findings are complete; their levels are the reviewers' own, which other models may have set on another scale. `/pr-comment --severity` changes a level for publication. |
| Review warning: `Removed N exact duplicate finding(s)` | Sessions reported records that are identical in every field; the runtime kept one of each. Nothing needs doing. |
| `[AZPR <run>] INCOMPLETE` with `Every review session failed: …` | No reviewer session produced an answer; the reason names the first failures (a provider error, a model that is not available). Fix the cause and run the review again. |
| `Host configuration changed private agent …` | Another config or plugin changed an `azpr-*` agent; resolve it and reload. |
| `No completed review is available for this conversation` | Run the comment command in the review's conversation, or run a new review. `/pr-comment --list` shows what is saved for a conversation. |
| `Review <id> does not say how its findings were produced in a way this version knows` | The saved review's record is of no kind this version knows (not a review of this version, nor a `/pr-review`, `/pr-deep` or `/pr-quick` that 0.4.x saved). It can be listed and shown, but not planned, adjusted or published; run a new review. |
| `Review <id> is a /pr-deep review, and models.deep.reviewers names no model to plan its comments with` | Comments are planned by the first reviewer model of the review's mode, and that mode is off now (after an update of 0.4.x settings in which `/pr-deep` stayed off, for instance). List a model there and restart the OpenCode service; a saved preview can be posted without one (`/pr-comment <id> --publish`). |
| A `/pr-comment` command acted on another review than you meant | Without an ID it acts on the conversation's current review, the one completed or used there last; the `STARTED` notice and the receipt name it (`Acted on review …`). Put the ID of the one you mean first (`/pr-comment --list` shows them); an adjustment is undone with `--reset`, and a preview posts nothing. |
| `PR source commit changed after the review` | The PR got new commits; run a new review before commenting. |
| `[AZPR <run>] REPLACED; source review=<id>` (`This run's preview was replaced before its receipt: …`) | Another `/pr-comment` command adjusted, planned again or posted this review's preview while that run's sessions were cleaned up. What the run planned is no longer what would be posted, so it is not shown; read the other command's receipt, or `/pr-comment --show`. |
| `Started automatically after review <id> completed (afterReview.review: preview)` or `(--publish)` | This comment run followed a COMPLETE review because of `afterReview` or the review command's flag; it is otherwise an ordinary `/pr-comment` run. |
| `Automatic publication held back N item(s) for a person: …` (status `POSTED` or another publication status) | Those items' text has an `@<…>` mention, an image, HTML that embeds content or runs a script, HTML that hides text (a comment, `<!…>`, `<?…>` or `</` without a tag name), or a `javascript:`, `vbscript:`, `data:` or `file://` link; the other items were published. Literal code counts only for mentions, or where its Markdown could be read another way (a fence in a list or after an HTML line, a backtick after a link, tag or bare address; see [commenting](COMMENTING.md)). Read the preview, then post the held items with `/pr-comment <id> --publish` (posted items are `ALREADY_PRESENT`). `result.json` lists them under `automatic.heldBack`. With status `STALE` nothing was posted and the line offers no command: the PR changed, so run a new review. |
| `Automatic publication held back every item: …` (status `PREVIEW`) | Every item was held for one of those reasons, so nothing was posted. Read the preview, then post it with `/pr-comment <id> --publish`. |
| `Automatic publication found nothing new to post: …` (status `NOTHING_TO_POST`) | Every finding is already discussed by a live thread of the PR, typically AZPR's own comment from an earlier run, so only a repeated summary would have been posted. Nothing needs doing; the plan is saved, and `/pr-comment <id> --publish` would post that summary. |
| `Automatic preview skipped: the review has no findings to comment on` (or `publication`) | Nothing was planned, posted or sent to a model. `/pr-comment <id>` still previews a summary-only comment. |
| `Automatic … skipped: another AZPR command is running in this conversation or on this PR` | Wait for that command, then run the `/pr-comment` command the notice names. |
| `Automatic comments are off for this review (stopped: …)` on a COMPLETE receipt | `/pr-stop`, a timeout or an unload arrived while the finished review's report was delivered. The review is kept; no comment step started. Run `/pr-comment <id>` to preview it. |
| `Unknown option after the PR URL` / `Use at most one of --preview, --publish or --no-comment` | Only these flags may follow the URL, at most one; start your context with a word. Nothing was started. |
| The command list describes the review commands as `AZPR is not ready here; run /pr-setup to see what it needs` | This OpenCode process found no usable settings for this project directory when it loaded AZPR: none yet, settings it cannot use, settings of 0.4.x that wait for their update, or settings that were saved from another project directory since. `/pr-setup` says which, and running a review command answers with one of the next rows. |
| `SETUP REQUIRED` … `could not be used when OpenCode loaded AZPR: …` | The reason names the problem (no file yet, an unreadable file, invalid JSON, a setting that fails validation or an unusable PAT file) without its value. Fix it, then restart the OpenCode service. |
| `SETTINGS UPDATE REQUIRED` … `settings.json is from AZPR 0.4.x (settings version 2)` | The settings file has the layout of 0.4.x, which this version does not use, and nothing was changed. Do not repair it by hand: run `/pr-setup`, which shows what the update changes and writes the new file after you confirm (see [upgrading from 0.4.x](../README.md#upgrading-from-04x)). Every other option of `/pr-setup` answers that the update comes first. |
| `That word names no update of the settings file as it is now` | `/pr-setup --migrate <word>` was given a word that belongs to another state of the file: the file changed since the update was shown, or OpenCode was restarted. Run `/pr-setup` alone and use the word it shows now. |
| `--migrate stands alone` / `These settings need no update` | `--migrate` confirms the update of settings of 0.4.x and nothing else: give it without other options, and only where `/pr-setup` offered the update. |
| `SETTINGS UPDATED` … `The settings file now has the layout of this version, and still cannot be used: …` (in the dialogs: `It still cannot be used:`) | The file of 0.4.x had a fault, such as a placeholder where a model belongs, and the update kept it: it changes the layout and nothing else. The update's summary said so in its last line (`After the update the settings still cannot be used: …`). Run `/pr-setup` again; it now sets what is missing. |
| `No --pat-file was given, and the default PAT file … could not be used` | `/pr-setup` looked for the PAT in `${XDG_CONFIG_HOME:-~/.config}/azpr/pat` (or, with `--replace`, the PAT file already set). Create it as the [quickstart](QUICKSTART.md#save-the-pat-in-a-private-file-terminal) shows, or name your file with `--pat-file`. Nothing was saved. |
| `RESTART REQUIRED` … `can be used now, but AZPR found no usable settings when OpenCode loaded it for this project directory` | Settings were saved after this OpenCode process loaded AZPR, by a setup in another project directory or by hand. A first setup is loaded at once only where it ran; restart the OpenCode service here. |
| `RESTART REQUIRED` … `are saved, but AZPR could not load them: …` | A first setup was saved, but loading it failed for the reason named (another plugin's command with a reserved name, for example). Remove the cause and run `/pr-setup` again, or restart the OpenCode service. |
| Setup dialog: `That is not an Azure DevOps token: it has characters other than letters, digits, "-" and "_"` | Something came along with the token, such as quotes around it or a name before it. Paste the token alone. |
| Setup dialog: `Azure DevOps did not accept this token for the organization "…"` | The token is mistyped or expired, or was created for another organization. Create one for this organization and paste it again. |
| Setup dialog: `Azure DevOps could not be reached` / `The TLS certificate of the connection was not accepted` / `The proxy asks for a user name and password` | The way to `dev.azure.com`: choose "Set a proxy and try again" (or the CA certificate file) in the dialog; see [company networks](ENTERPRISE.md#company-networks). The same token is then checked again. |
| Setup dialog: `The saved token was saved for the organization "…"` | The organization was changed: the token the settings name is not sent to another organization, and is not saved for one, also while its file cannot be read. Paste a token of the new organization; the two are saved together. |
| Setup dialog: `The saved token is checked only through the saved proxy and with the saved CA certificate file` | A proxy or a CA file was entered that is not saved yet, and the token field was left empty. Paste the token: a saved token is not sent a way the saved settings do not name. |
| Setup dialog: `An earlier token is still on disk` | The new token is in a file made for it (`pat-<organization>` beside the earlier file, with a number where that name was taken), and the settings name that file: the organization was changed, or the settings named the default PAT file `azpr/pat`, which setup only reads because several settings files may use it. The token these settings had before is still in the file the message names: delete that file if you no longer need it. |
| Setup: `The token was checked for the organization "…", but the settings name "…" now` | Another setup (another project directory, another OpenCode process) changed the organization while this one's dialogs were open. Nothing was saved; run `/pr-setup` again. |
| Setup: `Another setup is active, or its lock was left behind` | Two setups saved at the same moment, or a process ended while it held the lock. Neither the token nor the settings were written by this one. Save again; if no setup is running, delete the lock file the message names. |
| `The file that azure.patFile names holds something other than one token; it was left as it is` | The settings name a file that is not a token file, and setup does not replace it. Correct `azure.patFile` in the settings file, or remove that file if it is yours to remove. |
| Setup: `The token was saved, but the settings were not: …` | The token file holds the new token; the settings file could not be written for the reason named (another setup that holds the lock, or the file changed meanwhile). Save the change again. |
| Setup dialog title `AZPR settings · restart needed` | Settings were saved that the loaded runtime has not read. They take effect after `opencode service restart`; until then AZPR refuses new reviews. |
| `/pr-check` row `AZPR` WARNING: `Another AZPR entry is configured but not running` | Two `plugins` entries load AZPR, usually after `opencode plugin add` with a new version; OpenCode runs the first and lists the other as a duplicate. Remove the one you do not want (see [upgrading](../README.md#upgrading)). |
| `This review's private data is no longer available` | The review was evicted or its data removed; run a new review. |
| `PROGRESS — Planning comments: the grouping failed (…); planning goes on without grouping repeated places.` | The pass that looks for one defect at several places before the planning pages could not run (a provider error, for instance). Nothing else is lost: the comments are planned as before 0.4.6, one per place; `/pr-comment` plans again, with the pass. |
| `PROGRESS — Planning comments: N findings are too many to look through for one defect at several places; planning goes on without grouping them.` | The pass reads its findings inline, and their summaries and suggestions alone are longer than it takes (60,000 characters). No pass ran; the comments are planned one per place. |
| Skipped finding: `… the PR already has a comment of AZPR's on these quoted lines (thread N), and a second one is not put on them` (for a combined comment: `A combined comment for … did not meet the combination rules (…)`) | A comment for several places and a comment for one place do not find each other on the pull request, so neither is planned onto quoted lines that carry the other kind. The planner kept the comment there also after the correction turns. The finding stays in the summary index. `/pr-comment` plans again; where the existing thread covers the finding, the planner should skip it as discussed. |
| Skipped finding: `The comment planner repeated a checkpoint without progress` or `did not finish the page in 4 sessions` | The planner kept asking for more reading on that page; the finding has no inline comment but stays in the summary index, and the other comments were planned as usual. Inspect the page's planning stages; `/pr-comment <id>` (a preview) plans again. |
| `Stage inactivity watchdog stopped this stage: no activity for … s after …` (`failure=idle`, plus an inactivity notice) | The model stream, a tool or OpenCode stopped responding for `workflow.stageIdleSeconds`; the stage ran again in a new session. Repeated stops after `model request N was sent` point at the provider. Raise the setting only if a model really needs longer for one answer (the live stages recorded before 0.5.0 stayed under 151 s without any event). |
