# Debugging reviews

Keep a failed run and inspect its original evidence before changing settings or
starting another model request. A passing test does not establish provider
acceptance, Azure source validity or report quality.

## Where things are

| Location | Contents |
| --- | --- |
| Receipt in the invoking conversation | Status, per-stage rows (role, shard, session, model, attempts, repair turns, tool errors/timeouts, failure class) and notices. |
| `PROGRESS` notices | Phases of the run: snapshot, shard counts, verification, retries, planning pages, posting. |
| The verifier session | The rendered report (`# AZPR <id> — <status>`). |
| `${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2/reviews/` | Persisted completed reviews (plans and publication ledgers included). |
| `…/azpr-v2/receipts/` | Receipts that could not be queued to the conversation after three attempts. |
| `…/azpr-v2/data/` | Private source excerpts and large comment inputs for persisted reviews. |
| Debug directory (below) | Optional per-run diagnostics. |

## Enable diagnostics

In the installed `plugins/azpr-v2/settings.json`:

```json
{ "debug": { "enabled": true, "directory": "" }, "returnReport": "full" }
```

Restart OpenCode after editing. An empty directory selects
`${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2-debug/`; a relative path is
resolved against the active project. Each run creates a unique owner-only
directory named in the receipt. Debug data can contain source, PR details and
secrets echoed by a service; do not commit or upload it. Nothing is deleted
automatically. With debug enabled, private data of failed runs is kept for
inspection (stale scratch data is still removed after 24 hours).

| File | What it records |
| --- | --- |
| `run.json` | Run identity, relevant settings and start time. |
| `readiness.json` | Checked model slots, connected MCP servers, the selected Azure server and host capabilities. |
| `NN-ROLE.request.json` | Stage identity, the literal payload and the role instructions. |
| `NN-ROLE.response.json`, `NN-ROLE.response-repairN.json` | Visible answers of the first turn and each correction turn. |
| `NN-ROLE.result.json` | Status, repairs, unresolved issues, corrections, tool observations, failure class and timing. |
| `report.md` / `draft.md` | Rendered report or unconfirmed draft. |
| `comment-plan.json` | The saved plan with exact content, anchors, offsets and markers. |
| `result.json` | Final status, every stage record, Azure call count and warnings. |
| `delivery.json` | Whether the final receipt was queued (and how many attempts). |

The numeric prefix is stage creation order; shards and verification sessions run
in parallel.

## Diagnosis order

1. `result.json`: which stage failed and its `failureClass`:
   - `transient` was retried once in a new session (provider 408/409/425/429/5xx,
     interrupted turn, unexpected message in the turn);
   - `overflow` means the session needed compaction; the runtime split the shard;
   - `permanent` (authentication, bad request) was not retried;
   - `cancelled` came from `/pr-stop`, a timeout or unload.
2. The failed stage's request, response(s) and result together. `repairs` lists
   what the runtime asked the model to correct; `unresolvedIssues` lists what
   was still wrong after the last turn and therefore downgraded per item.
3. For comments: `comment-plan.json` and the publication ledger in the receipt.
   `FAILED` and `UNVERIFIED` items are safe to publish again; existing items are
   skipped by their markers.

Common receipts:

| Message | Next step |
| --- | --- |
| `settings.json changed since OpenCode loaded it` | Restart OpenCode. Running commands were unaffected. |
| `Host configuration changed private agent …` | Another config or plugin changed an `azpr-*` agent; resolve it and reload. |
| `No completed review is available for this conversation` | Run the comment command in the review's conversation, or run a new review. |
| `PR source commit changed after the review` | The PR got new commits; run a new review before commenting. |
| `This review's private data is no longer available` | The review was evicted or its data removed; run a new review. |
| `Comment planning repeated a checkpoint without progress` | The planner kept asking for more reading; inspect the planning stages. |
