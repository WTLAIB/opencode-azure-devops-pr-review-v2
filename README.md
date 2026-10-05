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

Fresh and replacement installations have been exercised on Ubuntu 22.04 with
the exact host and isolated fake services, including malformed JSON and prose
review delivery. Controlled live PR reviews also completed with official MCP
2.9.0. Model/tool-policy and presentation limitations remain; other environments
still need their own acceptance. See [validation](docs/VALIDATION.md) for the
tested revisions and retained failures. Completion does not prove model quality.

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

Existing current-layout settings retain their values; only absent defaults are
filled in. Old layouts and removed settings are rejected, without migration.
Runtime validation is authoritative. Replacement retains no routine installation
backup; failure recovery preserves the previous package or reports its retained
recovery location. Unrelated backups and private history are untouched.

### Manual copying without Git

Keep the following relative paths under one source directory, then run its
installer. These **20 files** are sufficient:

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
loader is needed. The installed core has 20 files: eight JavaScript modules,
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
requires all three deep models and never falls back to normal models. Source
checks and comment work use that mode's risk model. Model-selection guidance in
`models._help` is documentation only.

| Setting | Default and meaning |
| --- | --- |
| `version` | `2`, the current settings layout. |
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

Comment preview has no numerical quota. A saved preview and explicit `--publish`
authorize publication without a separate config switch. Ordinary host auxiliary
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
| `/pr-comment <completed-run-id>` | Build an inline-comment preview from verified findings. |
| `/pr-comment <completed-run-id> --publish` | Explicitly request posting exactly the saved preview from this conversation/process. |

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

A COMPLETE review can enter `/pr-comment <review-id>` from its original
session/process. The independent verifier must establish the final evidence,
identity/versions and original-ID decisions. Initial coverage disclosures, partial
or unavailable initials, and successfully normalized formatting do not veto that
completed result. Limitations remain visible and accompany the comment preview.
Preview still checks each proposed comment against current source and existing
discussions; publication requires the saved preview and explicit `--publish`.
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

[Architecture](docs/ARCHITECTURE.md), [roadmap](docs/ROADMAP.md),
[debugging](docs/DEBUGGING.md), [validation](docs/VALIDATION.md), and
[AI maintenance guidance](AGENTS.md) describe the remaining boundaries.
Never commit `.local/`, diagnostics, credentials or personal model selections.
