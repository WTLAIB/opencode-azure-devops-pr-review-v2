# Debugging reviews

Keep a failed run and inspect its original evidence before changing settings or
starting another model request. A passing test does not establish provider
acceptance, Azure source validity or report quality.

## A startup slash command becomes an ordinary prompt

On OpenCode 2.1.2, `opencode --prompt "/pr-review ..."` can submit before a
native Git package's command catalog has loaded. The host then treats the text
as an ordinary model prompt; AZPR has not received the command. This was observed
in local native-package TUI acceptance failures and matches the host's
[startup submission](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/tui/src/routes/home.tsx#L62)
and [command classification](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/tui/src/component/prompt/index.tsx#L1153).

Start the TUI normally and wait for `/pr-review` to appear in slash-command
completion before submitting it. A command admitted by AZPR emits its own
`[AZPR ...] STARTED` receipt. Do not treat an ordinary assistant response as that
receipt or repeat a command without checking the original conversation. The
host fixture exercises interactive submission in both new and existing
conversations and verifies that `/pr-stop` cancels from that same TUI.

## Where things are

| Location | Contents |
| --- | --- |
| Receipt in the invoking conversation | Status, per-stage rows (role, shard, session, model, attempts, repair turns, tool errors/timeouts, failure class) and notices. |
| `PROGRESS` notices | Phases of the run: snapshot, shard counts, verification, retries, planning pages, posting. |
| The last review session (a verifier, or the duplicate check when one ran; the receipt names it) | The rendered report (`# AZPR <id> — <status>`). |
| `${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2/reviews/` | Persisted completed reviews (plans and publication ledgers included). |
| `…/azpr-v2/receipts/` | Receipts that could not be queued to the conversation after three attempts. |
| `…/azpr-v2/data/` | Private source excerpts and large comment inputs for persisted reviews. |
| Debug directory (below) | Optional per-run diagnostics. |

## Enable diagnostics

In the settings file shown by `/pr-setup` (external configuration for native
packages, or installed `plugins/azpr-v2/settings.json` for source installs):

```json
{ "debug": { "enabled": true, "directory": "", "keepRuns": 20 }, "returnReport": "full" }
```

Restart OpenCode after editing. An empty directory selects
`${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2-debug/`; a relative path is
resolved against the active project. Each run creates a unique owner-only
directory named in the receipt. Debug data can contain source, PR details and
secrets echoed by a service; do not commit or upload it. When a run starts,
AZPR deletes its older run directories beyond `debug.keepRuns` (default 20;
`0` keeps all); a run still active in the same OpenCode process and anything
AZPR did not create are left alone. With debug enabled, private data of failed
runs is kept for inspection (stale scratch data is still removed after 24
hours), and every private session of a review that did not complete is kept
within the same limit of 20 runs.

| File | What it records |
| --- | --- |
| `run.json` | Run identity, relevant settings and start time. |
| `readiness.json` | Checked model slots, the Azure DevOps organization and api-version, and host capabilities. |
| `NN-ROLE.request.json` | Stage identity, the literal payload and the role instructions. |
| `NN-ROLE.response.json`, `NN-ROLE.response-repairN.json`, `NN-ROLE.response-follow-upN.json` | Visible answers of the first turn, each correction turn and a quick review's follow-up turn. |
| `NN-ROLE.result.json` | Status, repairs, unresolved issues, corrections, tool observations, failure class, timing and `tokens`: the token usage OpenCode reported for each model request of the stage (`input` without cached input, `cacheRead`, `cacheWrite`, `output`, `reasoning`), their sums and `cachedInputShare`. |
| `report.md` / `draft.md` | Rendered report or unconfirmed draft. |
| `comment-plan.json` | The saved plan with exact content, anchors, offsets and markers. |
| `azure-calls.jsonl` | Every Azure DevOps REST call, from the runtime and the reviewers' AZPR tools: method, call, file path or change page, attempt, HTTP status or error kind, duration, bytes, and whether it will be retried. Never credentials or comment bodies. |
| `result.json` | Final status, every stage record, Azure call and retry counts, the run's token totals with `cachedInputShare`, and warnings. |
| `delivery.json` | Whether the final receipt was queued (and how many attempts). |

The numeric prefix is stage creation order; shards and verification sessions run
in parallel.

## Diagnosis order

1. `result.json`: which stage failed and its `failureClass`:
   - `transient` was retried once in a new session (provider 408/409/425/429/5xx,
     interrupted turn, unexpected message in the turn);
   - `overflow` means the session needed compaction; the runtime split the shard;
   - `permanent` (authentication, bad request) was not retried;
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
   Receipt counters `stream-continuations` and `continuation-restarts` show
   interrupted provider streams and answers the model started over.
2. The failed stage's request, response(s) and result together. `repairs` lists
   what the runtime asked the model to correct; `unresolvedIssues` lists what
   was still wrong after the last turn and therefore downgraded per item. For a
   quick review, `sessionReads` counts the file contents that session's own
   `azpr_read_diff` and `azpr_read_file` calls showed, the reads its location
   checks accept; the result's `checks` hold each finding's location check.
   `followUp` records a quick follow-up turn: the turn, the gaps the answer
   named, how many assigned files it did not list as reviewed and the outcome
   (`completed`, `still-partial`, `unusable`, or `failed` with its failure class
   and error); the receipt shows `follow-up=<outcome>`.
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
| `Azure DevOps rejected the PAT for organization …` | Renew or correct the PAT in `azure.pat` or the file named by `azure.patFile` (organization-scoped, Code Read, Pull Request Threads Read & write) and restart OpenCode. |
| `The provider reports the usage quota as used up (provider.quota)` / `OpenCode reports the free model's usage limit as reached (provider.free-limit)` | The stage failed without a new-session retry, which would fail the same way. Choose another model in the settings, or wait until the provider's quota or the free limit resets. |
| `azure.patFile could not be used …` / `azure.patFile changed since OpenCode loaded it` | Make it a regular file you own with only the PAT (`chmod 600`), or restart OpenCode after replacing it. |
| `Azure DevOps refused … (HTTP 403 …)` | Add the missing PAT scope or project/repository access. |
| `network error (ConnectionRefused)` with a hint to set `azure.proxy` | dev.azure.com is reachable only through a proxy; set `azure.proxy` (see [proxies](AZURE_DEVOPS.md#proxies-and-tls-inspection)). |
| `the server's TLS certificate was not accepted (…)` | The proxy inspects HTTPS; set `azure.caFile` to its root CA certificate. |
| `A proxy refused … (HTTP 407)` / `A proxy or gateway answered …` | The proxy wants credentials in `azure.proxy`, or it blocks dev.azure.com. |
| `azpr_read_file failed: …` in a stage's tool errors | The model asked for a missing path or invalid range; the review continues and reports the gap. |
| `permission.rejected` … `cannot use paths outside the local OpenCode project` | A reviewer used a native tool on a repository path; it was refused instead of waiting for an approval and the model was pointed to the azpr tools. |
| `settings.json changed since OpenCode loaded it` | Restart OpenCode. Running commands were unaffected. |
| `Host configuration changed private agent …` | Another config or plugin changed an `azpr-*` agent; resolve it and reload. |
| `No completed review is available for this conversation` | Run the comment command in the review's conversation, or run a new review. |
| `PR source commit changed after the review` | The PR got new commits; run a new review before commenting. |
| `This review's private data is no longer available` | The review was evicted or its data removed; run a new review. |
| Skipped finding: `The comment planner repeated a checkpoint without progress` or `did not finish the page in 4 sessions` | The planner kept asking for more reading on that page; the finding has no inline comment but stays in the summary index, and the other comments were planned as usual. Inspect the page's planning stages; `/pr-comment <id>` (a preview) plans again. |
| `Stage inactivity watchdog stopped this stage: no activity for … s after …` (`failure=idle`, plus an inactivity notice) | The model stream, a tool or OpenCode stopped responding for `workflow.stageIdleSeconds`; the stage ran again in a new session. Repeated stops after `model request N was sent` point at the provider. Raise the setting only if a model really needs longer for one answer (live stages so far stayed under 151 s without any event). |
