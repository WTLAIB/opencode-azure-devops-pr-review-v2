# OpenCode Azure DevOps PR Review — V2

Explicit, independent Azure DevOps PR reviews for **`@opencode/cli@2.0.22`**,
**`@azure-devops/mcp@2.9.0`**, and **Ubuntu 22.04**. This repository uses only
the V2 plugin/session API. It has no V1 adapter, command templates, migration,
or native StructuredOutput transport.

Two full-scope reviewers work independently, then a verifier checks their claims
against source and is asked to adjudicate every original finding ID. Formatting
and quality gaps retain useful results with visible limitations. Ordinary development
agents, model selections, and provider credentials remain host-owned. A review
starts only through an explicit command.

Validation covers offline checks, exact-host fresh/replacement fixtures and
authorized live review/publication with independent Azure readback. See
[current validation](docs/VALIDATION.md) for the tested revision and remaining
limits. Earlier runs are preserved in [validation history](docs/VALIDATION_HISTORY.md).
A completed workflow does not prove model quality or compatibility with other environments.

## Requirements and installation

Use the exact host and MCP versions above. Node.js **22.12 or later in the 22.x
line** is recommended for the MCP dependency requirements. The installer needs
POSIX `sh` and Python 3's standard library; the plugin has no npm dependencies,
build step, direct provider SDK, or Azure client.

From a complete source checkout:

```sh
sh install.sh --config-dir /absolute/path/to/v2-opencode-config
```

The installer creates `plugins/azpr-v2/` with a generated ESM `package.json`
exporting `./server.js`. The generated package-local `server.js` re-exports
`plugin.js`; OpenCode 2.0.22 resolves local directories through this entry, not
package exports alone. Configure OpenCode to use that configuration directory;
`--config-dir` controls installation only. The plugin is discovered as a V2
package, with commands registered during setup.

Use a separate configuration directory when retaining a V1 installation. The
installer refuses conflicting V1 integration files, reserved command files, and
unowned destination packages. It never edits the main OpenCode configuration,
credentials, provider choices, or MCP connections. Do not load both integrations
in one host. A clean source install with placeholder model IDs is not ready to
run until the settings below are filled in.

For a replacement of this V2 package:

```sh
sh install.sh --config-dir /absolute/path/to/v2-opencode-config --replace
```

Existing current-layout operational settings retain their values; absent defaults
are filled in. Retired `models._help` documentation is omitted with a notice.
Old layouts and other removed settings are rejected, without migration.
Runtime validation is authoritative. Replacement retains no routine installation
backup; failure recovery preserves the previous package or reports its retained
recovery location. Unrelated backups and private history are untouched.

### Manual copying without Git

Keep the following relative paths under one source directory, then run its
installer. These **22 files** are sufficient:

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
src/prompts/common.md
src/prompts/check.md
src/prompts/functional.md
src/prompts/risk.md
src/prompts/deep.md
src/prompts/final.md
src/prompts/comment-policy.md
src/prompts/comment-plan.md
src/prompts/comment-publish.md
```

README, `docs/`, the settings schema and `uninstall.sh` are optional installer
inputs. Include them for local guidance. No `commands/` directory or top-level
loader is needed. The installed core has 22 files: ten JavaScript modules,
nine prompts, settings, generated package metadata, and the generated server entry.
The Python helper is used by the installer, not installed into the runtime.

## Configuration

Edit only your installed `plugins/azpr-v2/settings.json`. Use model IDs already
configured in OpenCode, in `provider/model` form:

```json
{
  "models": {
    "review": {
      "functional": "YOUR_PROVIDER/YOUR_FUNCTIONAL_MODEL",
      "risk": "YOUR_PROVIDER/YOUR_RISK_MODEL",
      "verifier": "YOUR_PROVIDER/YOUR_VERIFIER_MODEL"
    },
    "deep": {
      "functional": "",
      "risk": "",
      "verifier": ""
    }
  }
}
```

This is a fragment of the installed example, not the complete settings file.
Roles may use the same model ID but always receive independent sessions. Deep
requires all three deep models and never falls back to normal models. Standalone
`/pr-check` uses `models.review.risk`; comments use the originating review's risk
model, including `models.deep.risk` for deep reviews.

Model-selection guidance belongs here and in the schema's editor descriptions,
not in user settings. Both initial reviewers inspect the full PR independently;
their focus differs:

| Role | Focus and useful model capabilities |
| --- | --- |
| `functional` | Requirements, boundaries, state changes, API compatibility and regressions. Prefer strong code comprehension in the project's language. |
| `risk` | Failures, retries, concurrency, authorization and data consistency. Prefer evidence-based reasoning across call paths and reliable MCP tools. This model also handles source checks and comments for its mode. |
| `verifier` | Independently check both initial reviews against source, seek counterevidence, merge duplicates and produce the final report. Prefer strong evidence judgment, long-context handling and instruction following; this role must not just summarize or vote. |

All roles benefit from reliable tool use and clear structured reviews, with
approved data handling and acceptable cost. Role instructions live in
`src/prompts/`; changing descriptive text is not a configuration mechanism.
New settings contain no `models._help`. Existing files with that field remain
readable, but it is ignored as before and marked deprecated in the schema.
The installer removes this documentation-only field from the installed copy
with a notice, preserving operational values and any supplied source profile.
Already-clean complete settings retain their original bytes on replacement.

| Setting | Default and meaning |
| --- | --- |
| `$schema` | Editor schema reference for validation and hints; metadata, not a review option. |
| `version` | Fixed at `2` to identify the settings layout; metadata, not a tuning option. |
| `enabled` | `true`; false registers no private roles or commands. |
| `returnReport` | `receipt`; `full` also returns the rendered report to the original conversation. |
| `outputLanguage` | `en`; shared by initial reviews, the final report and comments. Use `zh-TW` for Traditional Chinese. |
| `runTimeoutSeconds` | `null`, no whole-command timer. An explicit integer from 10 to 7200 enables one. |
| `debug.enabled` | `false`; opt in to private requests, visible answers, results and reports. |
| `debug.directory` | Empty uses the private `opencode/azpr-v2-debug` state directory. Relative paths resolve against the project. |

Restart after settings changes. There are no configurable or hidden reviewer
iteration or stage-character caps. `steps`, `maxStageCharacters`,
`structuredOutput`, `azure`, `comments`, `auxiliaryModels`, `outputRetries`,
`verification`, and `shellToolPermission`
are unsupported and rejected. Before replacing an older V2 installation, back up
your private settings, remove those obsolete keys explicitly, and pass that
cleaned profile with `--settings FILE`; the installer never silently migrates it.

Comment preview includes one PR Review Summary and eligible inline comments.
Inline titles start with `🔴 high:` or `🟡 medium:`, followed by
📝 Summary, 🔎 Evidence and 💡 Suggested fix sections. The
summary indexes all confirmed findings, including low-severity findings that
are not eligible inline, with 🔴 high, 🟡 medium and 🔵 low severity labels.
Other emojis are optional and left to the planner's judgment. Optional Review
notes appear before the index, starting with the purpose supported by the PR
description or requirements, or a brief change overview when intent is unknown.
A second sentence may add shared impact or a supported priority for fixes.
The planner chooses useful context rather than filling a fixed checklist.
Review IDs and commit SHAs remain in local records, without a public metadata line.
Review methods and test results need no separate account; missing notes leave
out that section. Routine publication checks stay out of these notes; a summary
is not approval.
After the index, the summary explains confirmed findings without an inline
comment, including low severity, and presents retained non-defect recommendations
under a separate Improvement suggestions heading. Each suggestion identifies
the affected code, a concrete benefit and a practical direction. Equivalent
advice is combined, while every distinct supported recommendation retained by
the verifier is carried forward. Sections appear only when there is content;
no architecture/testing checklist or suggestion quota is required. Suggestions
do not receive defect severity or inflate the issue counts. A review with no
confirmed defects can still have useful suggestions.
It is saved and published with the same explicit authorization and uncertainty
tracking as inline comments, including when no inline comments are eligible.
The summary starts with a 🤖 AI/model disclosure above its title and issue list.
Inline comments keep the disclosure below their bodies.

Reviewers and the planner write directly in `outputLanguage`; there is no
English-first translation or extra polishing pass. For `zh-TW`, prompts request
natural Taiwanese engineering prose and the notes heading is `審查說明`.
Identifiers, source quotes, conditions and quantities remain intact. The publisher
sends saved text exactly. Language quality still depends on the model.

Comment preview has no numerical quota. Explicit `--publish` prepares and saves
a plan if needed, then publishes it without a separate preview command or config
switch. An existing preview is reused exactly. Ordinary host auxiliary
model selections are always preserved; private reviewers cannot start auxiliary
requests. `/pr-check` remains a standalone diagnosis with strict output validation
and no additional model request to repair its answer.

Before creating reviewers, the plugin checks the selected models in the V2
catalog for availability and tool support, and requires a connected MCP server.
These cancellable reads submit no inference. A connected server does not prove
Azure identity, direct-tool exposure, permissions, or source access; those remain
separate checks. An unavailable catalog fails with an explicit receipt, without
selecting another model or rewriting configuration.

### Verification in the current project

The two initial reviewers and verifier can use shell, read, glob and grep in the
current OpenCode project under its normal permissions. Models choose useful tests,
reproductions or static checks. The PR source comes from MCP; the current directory
need not contain a checkout or Git history. Review does not clone/fetch a repository.
For an experiment, the model can save only needed MCP-returned files in a fresh
temporary directory and record their paths and commit provenance. There is no
repository mapping, root filesystem, custom execution tool or test quota.

Commands use the real project and can change files or contact services. The plugin
does not sandbox them or override host allow/ask/deny decisions. Reviewers must
preserve existing work and distinguish local checkout results from evidence about
the PR's exact commit. Test failures and missing dependencies remain reportable
limitations. Comment roles also inherit project-tool permissions for local
verification; standalone readiness remains source-only. Publication still uses
the supplied MCP tools and requires the saved preview and explicit --publish. See
[project verification](docs/VERIFICATION.md) for scope and cancellation limits.

### MCP must expose direct tools

Connect the official MCP server through OpenCode's own configuration and set
**`codemode: false`** on that server. The V2 shape is:

```json
{
  "mcp": {
    "servers": {
      "ado": {
        "type": "local",
        "command": ["npx", "-y", "@azure-devops/mcp@2.9.0", "YOUR_ORGANIZATION"],
        "codemode": false
      }
    }
  }
}
```

Configure authentication through the official server and host. Never put a PAT
or provider key in this repository. See [Azure MCP setup and limitations](docs/AZURE_MCP.md).

Private roles block CodeMode `execute`: its built-in `fetch` in this host version
does not cross the tool/permission boundary used for native web restrictions.
Direct MCP tools remain host-owned and have no plugin-maintained name catalog.
CodeMode-only MCP resource helpers are therefore unavailable to these roles.
Read-only MCP behavior is a **prompt policy**, not a programmatic write firewall;
use host/server permissions appropriate to your organization.

## Commands

Invoke from an ordinary development session:

| Command | Behavior |
| --- | --- |
| `/pr-check <PR URL> [context]` | Independent source-readiness check; no review or approval. |
| `/pr-review <PR URL> [context]` | Two concurrent normal reviewers, then independent verification. |
| `/pr-deep <PR URL> [context]` | Same pipeline, separate three-role models and deeper analysis. |
| `/pr-stop [run-id]` | Revoke active authorization and request interruption; omitted ID uses the current origin session. |
| `/pr-comment [review-id]` | Preview comments for this conversation's latest completed review, or the supplied ID. |
| `/pr-comment [review-id] --publish` | Prepare and publish comments in one command, or publish an existing preview exactly. |

After a review, `/pr-comment --publish` is enough to request publication. Preview
is optional: use `/pr-comment` to inspect the proposed comments first. Neither
command reruns the reviewers. `returnReport: full` only controls displaying the
review report; it does not add a prerequisite or change comment eligibility.
Running `/pr-comment` again refreshes the preview. Once replanning starts it
discards the older plan, so failed planning cannot leave that preview publishable.
Every COMPLETE report ends with both complete commands, including its review ID.
Comment commands also work from that report or its comment-result session, using
the same original conversation and permissions. Unrelated conversations cannot
use its cached review, and omitting the ID never searches other conversations.

In the original conversation, the latest cached COMPLETE review wins even if it
belongs to a different PR. A newer failed or PARTIAL review does not replace it.
Results are not combined, and selection does not skip a review that already had
a publication attempt. Use an explicit same-origin review ID when needed.

Arguments are literal command text; shell-like syntax, `$` and `@` are not
expanded by this plugin. Attachments and private-agent mentions are rejected.
Supplementary context belongs to that command only; repeat it when starting a
new review. PR content, comments and tool responses are untrusted data.

The source snapshot records PR identity and PR-reported source/target commit
SHAs. The target is not a certified merge base. The verifier receives available
initial reports, their discovered paths and any identity/version conflicts. It
rechecks source and counterevidence and is asked to account for every original
finding ID. Partial initial reviews and unavailable reviewers do not discard
useful sibling work. Missing decisions remain visibly UNREVIEWED; changed versions
remain STALE. Tool completion alone does not establish evidence.

Reviews prefer JSON text. Local recovery handles common punctuation, quoting,
key spelling and section-shape mistakes. A unique review object can be extracted
from surrounding prose or JSON fences, including commentary with dictionary
examples and other code blocks. Surrounding text is retained; competing review
objects and duplicate keys remain ambiguous. Extra information is retained. If a
completed response cannot be parsed reliably, its literal text still reaches the
verifier or the report. Missing fields and incomplete decisions produce a usable
PARTIAL report instead of losing the entire review. Partial/stale reports include
their body even in receipt mode. No extra model request is used for formatting.

A COMPLETE review can enter `/pr-comment` from its original conversation or report
session in the same process. The independent verifier must establish the final evidence,
identity/versions and original-ID decisions. Initial coverage disclosures, partial
or unavailable initials, and successfully normalized formatting do not veto that
completed result. Limitations remain visible and accompany the comment preview.
Planning still checks each proposed comment against current source and existing
discussions. Explicit `--publish` can perform that planning and publication in
one command; it never treats an INCOMPLETE plan as publishable. A planning failure
retains the review and exposes the supplied reason, so another explicit comment
command can address it without rerunning the review.
Settings, source checks and comment operations keep strict parsing. See
[architecture](docs/ARCHITECTURE.md).

Results are queued as synthetic notices with `resume: false`; the plugin does
not start a formatter or ordinary-agent model call. Receipt mode identifies the
private report session and diagnostics. Full mode also carries the report in the
origin notice. A queue acknowledgment is not proof of TUI rendering. Do not
resume completed reviewer sessions; their grants are revoked.

The V2 `model.request` hook also checks authorization across request kinds.
Private reviewers cannot use transient generation, title requests or compaction;
compaction would invalidate the exact admitted-context contract. The plugin stops
before sending a summary request instead of accepting output from a lossy summary.
Ordinary sessions retain their host-owned generation, compaction and retry behavior.

Publication results are model-reported, never independently provider-verified by
this plugin. An uncertain publication attempt locks the saved batch against
automatic retry. Inspect Azure before taking further action. Nothing posts merely
because a review completes or a preview exists.

### Review retention

Publication authority stays in local **process memory**, not a durable run-ID database.
Large evidence and comment work are private file-backed data; the files cannot
restore authority after restart.
Each plugin instance keeps the latest 20 completed reviews, including source
observations, any prepared plan, and publication-attempt state. A newer completed
review evicts the oldest when the limit is exceeded. There is no time-based TTL;
plugin unload or process restart clears this cache. An expired ID fails clearly
and never silently selects another review or triggers a new model review.

OpenCode owns its conversation history. Optional private debug files remain on
disk until the user removes them; the plugin does not automatically purge those
files or host history. Neither history nor debug JSON restores publication
authorization after restart. See [comment retention](docs/COMMENTING.md#retention)
and [diagnostics](docs/DEBUGGING.md).

Large reviews use file-backed comment data and multiple short sessions. The planner
receives assigned verified findings, an exact report segment and references to
original evidence; it no longer embeds the accumulated review tool outputs.
All findings and retained advice are carried into one saved plan before publishing.
Read-only checks can checkpoint with exact records and continue in a new session.
Publishing sends saved items in pages under one attempt ledger, with no automatic
write retry. These are comment work pages, not additional review rounds or a
PR-size quota. See [large-PR commenting](docs/COMMENTING.md#large-pr-work-pages).

## Development and removal

```sh
npm run check
npm test
sh uninstall.sh --config-dir /absolute/path/to/v2-opencode-config
sh uninstall.sh --config-dir /absolute/path/to/v2-opencode-config --apply
```

Uninstall without `--apply` previews. Explicit removal archives only this V2
package, including its private settings, under `azpr-v2-backups`; it leaves
ordinary configuration and the independent V1 project untouched.

[Architecture](docs/ARCHITECTURE.md), [commenting](docs/COMMENTING.md),
[roadmap](docs/ROADMAP.md), [debugging](docs/DEBUGGING.md),
[current validation](docs/VALIDATION.md), and [AI maintenance guidance](AGENTS.md)
describe the current behavior and boundaries. Earlier test counts, retired
features and failed experiments are kept in [validation history](docs/VALIDATION_HISTORY.md).
Never commit `.local/`, diagnostics, credentials or personal model selections.
