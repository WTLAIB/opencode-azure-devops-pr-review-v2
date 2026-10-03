# OpenCode Azure DevOps PR Review — V2

Explicit, independent Azure DevOps PR reviews for **`@opencode/cli@2.0.22`**,
**`@azure-devops/mcp@2.9.0`**, and **Ubuntu 22.04**. This repository uses only
the V2 plugin/session API. It has no V1 adapter, command templates, migration,
or native StructuredOutput transport.

Two full-scope reviewers work independently, then a verifier checks their claims
against source and adjudicates every original finding ID. Ordinary development
agents, model selections, and provider credentials remain host-owned. A review
starts only through an explicit command.

Fresh and replacement installations have been exercised on Ubuntu 22.04 with
the exact host and isolated fake services. Live model services and the official
MCP 2.9.0 Azure connection require separate acceptance. See
[validation](docs/VALIDATION.md) for the actual scope. Passing contracts does not
prove that a model's factual reasoning or final presentation is correct.

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
loader is needed. The installed core has 20 files: eight modules, nine prompts,
settings, generated package metadata, and the generated server entry.

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
| `outputLanguage` | `en`; `zh-TW` is supported for final report/comment presentation. |
| `runTimeoutSeconds` | `null`, no whole-command timer. An explicit integer from 10 to 7200 enables one. |
| `outputRetries` | `0`; `1` permits one eligible output amendment per stage. |
| `shellToolPermission` | `deny`; `ask` sets the private host rule to ask; final host rules determine schema exposure, while execution is still blocked. `allow` is rejected. |
| `comments.enabled` | `false`; explicit publication requires true before reviewing. |
| `comments.maxComments` | `5`, limits the publication batch, not review evidence. |
| `debug.enabled` | `false`; opt in to private requests, visible answers, results and reports. |
| `debug.directory` | Empty uses the private `opencode/azpr-v2-debug` state directory. Relative paths resolve against the project. |
| `auxiliaryModels` | `preserve`; ordinary host auxiliary choices are unchanged. |

Restart after settings changes. There are no configurable or hidden reviewer
iteration or stage-character caps. `steps`, `maxStageCharacters`,
`structuredOutput`, and `azure` mappings are unsupported and rejected.

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
| `/pr-comment <completed-run-id> --publish` | Request posting exactly the saved preview, only with publication enabled. |

Arguments are literal command text; shell-like syntax, `$` and `@` are not
expanded by this plugin. Attachments and private-agent mentions are rejected.
Supplementary context belongs to that command only; repeat it when starting a
new review. PR content, comments and tool responses are untrusted data.

The source snapshot records PR identity and PR-reported source/target commit
SHAs. The target is not a certified merge base. Initial reviewers must agree on
identity and versions; the verifier receives their union of discovered paths,
rechecks source/counterevidence, and accounts for every original finding ID.
Changed versions, incomplete evidence or missing decisions cannot become a
completed publishable review. Tool completion alone does not establish evidence.

All stages use JSON text. Strict duplicate-key and envelope validation apply.
Small, audited formatting tolerances are disclosed and fully revalidated; no
finding values or missing evidence are guessed. Optional output recovery is
bounded to one eligible amendment, shares the original deadline, and cannot use
ordinary tools. See [architecture](docs/ARCHITECTURE.md).

Results are queued as synthetic notices with `resume: false`; the plugin does
not start a formatter or ordinary-agent model call. Receipt mode identifies the
private report session and diagnostics. Full mode also carries the report in the
origin notice. A queue acknowledgment is not proof of TUI rendering. Do not
resume completed reviewer sessions; their grants are revoked.

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
