# OpenCode Azure DevOps PR Review — V2

Explicit, independent Azure DevOps PR reviews for **`@opencode/cli`** (tested with
**2.0.22**) and **Ubuntu 22.04**, using the **Azure DevOps Services REST API**
(api-version **7.1**) with a personal access token from AZPR's own settings. No
MCP server is needed. The plugin uses the OpenCode V2 plugin/session API.

How a review works:

1. The runtime reads the PR deterministically from Azure DevOps: identity, the
   latest iteration's source commit and merge base, and the complete
   changed-file list. Reviewers read the repository through AZPR's own
   read-only tools at exact commits.
2. Two full-scope reviewers (functional and risk) review the changed files in
   bounded **shards**. A shard that fills its model context is split in half
   and run again instead of failing.
3. A verifier independently re-checks every candidate finding against the
   source, sharded by finding. Answers that break the output contract get a
   short **correction turn** in the same session; whatever is still unusable is
   downgraded per finding (UNREVIEWED, NEEDS_INFO) instead of discarding the review.
   When findings that different verifiers confirmed end up in the same file (a
   verifier moved one there, or the file had more findings than one verifier
   holds), a short **duplicate check** with the verifier model merges only true
   duplicates; it never drops a finding.
4. The runtime rechecks the PR versions. Only a changed **source** commit makes
   the review STALE; a moved base is reported as a warning.
5. `/pr-comment` plans comments with a model, then the runtime posts the saved
   text itself, skipping comments that already exist and reading every created
   comment back from Azure DevOps. Re-running a publish is safe.

Every command acknowledges `STARTED` immediately and continues in the current
OpenCode process; short `PROGRESS` notices and a final receipt return to the
invoking conversation. Use the displayed `/pr-stop <run-id>` to cancel.
Completed reviews, previews and publication ledgers are saved privately and
survive an OpenCode restart.

See [current validation](docs/VALIDATION.md) for what was tested and what was
not; earlier runs are kept in [validation history](docs/VALIDATION_HISTORY.md).

## Requirements and installation

The installer needs POSIX `sh` and Python 3's standard library; the plugin has no
npm dependencies, build step or provider SDK. It calls the Azure DevOps REST API
with the runtime's built-in `fetch`.

```sh
sh install.sh --config-dir /absolute/path/to/v2-opencode-config
```

The installer creates `plugins/azpr-v2/` with a generated ESM `package.json`
and a `server.js` entry that re-exports `plugin.js`. It never edits the main
OpenCode configuration, provider choices or MCP connections, and it refuses
conflicting V1 files, reserved command names and unowned packages. A clean
install with placeholder model IDs and an empty PAT is not ready until you fill
in the settings below.

To replace an existing V2 installation (current settings are kept, new defaults
are added, and a retired `mcp` section is moved into `azure`):

```sh
sh install.sh --config-dir /absolute/path/to/v2-opencode-config --replace
```

### Manual copying without Git

Keep these relative paths under one source directory, then run its installer.
These **29 files** are sufficient:

```text
install.sh
scripts/merge-settings.py
config/settings.example.json
src/plugin.js
src/session.mjs
src/runtime.mjs
src/config.mjs
src/output.mjs
src/comments.mjs
src/comment-data.mjs
src/comment-work.mjs
src/diagnostics.mjs
src/attribution.mjs
src/host.mjs
src/tool-queue.mjs
src/azure.mjs
src/diff.mjs
src/search.mjs
src/review-tools.mjs
src/review-work.mjs
src/store.mjs
src/prompts/common.md
src/prompts/functional.md
src/prompts/risk.md
src/prompts/deep.md
src/prompts/final.md
src/prompts/dedupe.md
src/prompts/comment-policy.md
src/prompts/comment-plan.md
```

README, `docs/`, the settings schema and `uninstall.sh` are optional.

## Configuration

Edit only your installed `plugins/azpr-v2/settings.json` and restart OpenCode.
A changed file blocks new commands until the restart; running commands keep the
settings they started with.

```json
{
  "models": {
    "review": {
      "functional": "YOUR_PROVIDER/YOUR_FUNCTIONAL_MODEL",
      "risk": "YOUR_PROVIDER/YOUR_RISK_MODEL",
      "verifier": "YOUR_PROVIDER/YOUR_VERIFIER_MODEL"
    },
    "deep": { "functional": "", "risk": "", "verifier": "" }
  },
  "azure": {
    "organization": "YOUR_ORGANIZATION",
    "pat": "YOUR_PERSONAL_ACCESS_TOKEN"
  }
}
```

Model IDs use `provider/model` form and must exist in OpenCode. `/pr-deep`
needs all three deep models and never falls back to the review models. Comment
planning uses the review's risk model.

| Role | Focus and useful model capabilities |
| --- | --- |
| `functional` | Requirements, boundaries, state changes, API compatibility and regressions. Strong code comprehension in the project's language. |
| `risk` | Failures, retries, concurrency, authorization and data consistency. Evidence-based reasoning across call paths and reliable tool use. Also plans comments. |
| `verifier` | Independent source re-checks, counterevidence, duplicate merging (including the same-file duplicate check) and the final report. Strong evidence judgment and instruction following. |

| Setting | Default and meaning |
| --- | --- |
| `enabled` | `true`; `false` registers nothing. |
| `returnReport` | `receipt`; `full` also encloses the rendered report in the receipt. |
| `outputLanguage` | `en`; used by reviews, the report and comments. `zh-TW` for Traditional Chinese. |
| `runTimeoutSeconds` | `null` (no whole-command timer); an integer 10–7200 enables one. |
| `shell` | `deny`: private reviewers cannot run shell commands (the tool is hidden). `ask`: each command needs your approval in OpenCode. `inherit`: host permissions decide. |
| `progressNotices` | `true`: short PROGRESS notices in the invoking conversation. |
| `azure.organization` | Required. The `<org>` of `https://dev.azure.com/<org>`; PR URLs of other organizations are refused. |
| `azure.pat` | Required. A personal access token for that organization with **Code (Read)** and **Pull Request Threads (Read & write)**. Sent only to `https://dev.azure.com/<org>` and never logged. |
| `azure.concurrency` | `3` simultaneous Azure DevOps calls across all AZPR commands. |
| `azure.callTimeoutSeconds` | `120`; a hung call is aborted and its slot released (reads are retried). |
| `workflow.shardFiles` | `25` changed files per initial-review session. |
| `workflow.shardFindings` | At most `15` findings per verification session; one file's findings stay in the same session (a file is split only when it alone has more). |
| `workflow.parallelSessions` | `4` reviewer sessions at once within a command. |
| `workflow.repairAttempts` | `2` correction turns when an answer breaks the output contract. |
| `workflow.stageRetries` | `1` new-session retry after a transient failure (provider 429/5xx, interrupted stream). |
| `debug.enabled` / `debug.directory` | `false` / `""`; see [debugging](docs/DEBUGGING.md). |

`steps`, `maxStageCharacters`, `structuredOutput`, `comments`,
`auxiliaryModels`, `outputRetries`, `verification` and `shellToolPermission`
are unsupported and rejected; `mcp` is retired (the installer moves its limits
into `azure`). There is deliberately no per-stage step cap; see the
[roadmap](docs/ROADMAP.md#deferred) for why.

### Azure DevOps access

AZPR talks to the Azure DevOps Services REST API itself (api-version 7.1). Create
a PAT scoped to **one organization** (global "all accessible organizations"
PATs stop working on 2026-12-01) with **Code: Read** and **Pull Request Threads:
Read & write**, put it in `azure.pat` of the installed `settings.json` (the
installer keeps that file at mode 600) and restart OpenCode. Keep the PAT out of
this repository and out of shared settings profiles.

Reviewers read source through six read-only AZPR tools (`azpr_read_diff`,
`azpr_read_file`, `azpr_search_code`, `azpr_find_files`, `azpr_list_files`,
`azpr_pr_threads`) that are visible only in AZPR's private sessions; other
tools, including other MCP servers, are hidden from them. They start from each
file's diff, read whole files only for the context a change needs, search the
repository's contents at the PR's commit for callers, definitions and the code
a test exercises, and see the PR's commit messages. See
[Azure DevOps access](docs/AZURE_DEVOPS.md) for the API list, versions and
troubleshooting.

## Commands

| Command | Behavior |
| --- | --- |
| `/pr-check <PR URL> [context]` | Deterministic readiness check: PR metadata, changed files, a HEAD and BASE file read, discussions and model availability. No model is used. |
| `/pr-review <PR URL> [context]` | Sharded functional and risk reviews, then sharded verification. |
| `/pr-deep <PR URL> [context]` | Same pipeline with the deep models and deeper analysis. |
| `/pr-stop [run-id]` | Cancel this conversation's active command. |
| `/pr-comment [review-id]` | Preview comments for this conversation's latest completed review. |
| `/pr-comment [review-id] --publish` | Post the saved preview (planning it first if needed). Safe to repeat. |

Supported PR URLs are `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>`
and `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>/pullrequest/<id>`.
Text after the URL is supplementary context for that command only. PR content,
comments and tool responses are untrusted data.

Status meanings:

- **COMPLETE**: verification produced structured decisions and the PR source did
  not change. Findings without a usable decision are listed as UNREVIEWED and
  are never posted. Only COMPLETE reviews can be commented on.
- **STALE**: the PR source commit changed during the review; run a new one.
- **PARTIAL**: no verification session produced a structured result; initial
  observations are shown for reference only.
- **INCOMPLETE / CANCELLED / TIMED_OUT**: the command did not finish; a review
  keeps an unconfirmed draft of finished initial work.

## Comments

`/pr-comment` plans one general summary plus inline comments for confirmed high
and medium findings (low findings stay in the summary index). Planning runs in
pages of at most four findings; each page may get a correction turn, and an item
that still cannot be posted faithfully is skipped with a reason instead of
failing the command. Inline titles start with `🔴 high:` or `🟡 medium:` followed
by **📝 Summary**, **🔎 Evidence** and **💡 Suggested fix**; the summary starts
with a 🤖 AI/model disclosure and may carry improvement suggestions.

Publication is runtime code: it refuses an inactive PR or a changed source
commit, lists every existing thread, skips items whose hidden marker already
exists, creates the rest with the exact saved text, and reads the markers back.
Markers are stable fingerprints of PR, file and anchored lines, so a later
review of unchanged code does not post duplicates. A failed or uncertain item can
simply be published again. See [commenting](docs/COMMENTING.md).

## Retention and privacy

Completed reviews, previews, publication ledgers and their source excerpts are
kept under `${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2/` with owner-only
permissions. The newest 20 reviews are kept; older ones and stale scratch data
are removed automatically. A receipt that cannot reach the conversation is saved
under `receipts/` there. `/pr-comment` only accepts reviews started in the same
conversation (or from one of that review's sessions).

## Development and removal

```sh
npm run check
npm test
node tests/host-v2-smoke.mjs /absolute/path/to/opencode
node tests/host-v2-comment-scale.mjs /absolute/path/to/opencode
sh uninstall.sh --config-dir /absolute/path/to/v2-opencode-config
sh uninstall.sh --config-dir /absolute/path/to/v2-opencode-config --apply
```

The host fixtures run a real OpenCode binary with a loopback fake model provider
and a loopback fake Azure DevOps REST service in disposable directories under
`.local/`.
Uninstall without `--apply` previews; `--apply` archives only this package under
`azpr-v2-backups` and leaves the private state directory for you to delete.

[Architecture](docs/ARCHITECTURE.md), [commenting](docs/COMMENTING.md),
[Azure DevOps access](docs/AZURE_DEVOPS.md), [verification](docs/VERIFICATION.md),
[debugging](docs/DEBUGGING.md), [roadmap](docs/ROADMAP.md),
[current validation](docs/VALIDATION.md) and [AI maintenance guidance](AGENTS.md)
describe the current behavior. Never commit `.local/`, diagnostics, credentials
or personal model selections.
