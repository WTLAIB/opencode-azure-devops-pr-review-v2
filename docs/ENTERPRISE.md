# Using AZPR with your team

AZPR runs inside your OpenCode process and reads Azure DevOps Services directly.
You choose the models in OpenCode; AZPR has no separate hosted review service or
MCP dependency. Start with the [quickstart](QUICKSTART.md), then use
this page to understand access, data flow and local retention before reviewing
your team's repositories.

The tested environment is **OpenCode V2 `@opencode/cli` 2.1.2 on Ubuntu
22.04**. Azure DevOps Server URLs are not supported. See
[current validation](VALIDATION.md) for the distinction between isolated tests
with fake services and runs against real Azure DevOps and model providers.

## Azure access and credentials

Configure an organization-scoped PAT, preferably alone in a file that only its
owner can read, named by `azure.patFile` in AZPR's settings (otherwise in
`azure.pat`), alongside `azure.organization`. `/pr-setup` shows the active
settings path: native packages use an external configuration file, while
source installations keep `plugins/azpr-v2/settings.json`. Neither a package
update nor removal deletes the native installation's external configuration.
The recommended scopes are:

| Scope | Used for |
| --- | --- |
| Code: Read (`vso.code`) | PR metadata, changes, commits, source files and repository archives. |
| Pull Request Threads: Read & write (`vso.threads_full`) | Reading discussions and creating review comments. |

These correspond to Microsoft's documented [source read](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1#security)
and [thread creation](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1#security)
scopes. A live check on 2026-10-21 confirmed that this combination covers
every read AZPR makes, including repository archives, and thread creation (see
[validation](VALIDATION.md#pat-scopes-and-azurepatfile-2026-10-21)).
The PAT owner also needs access to the project and repository. AZPR does not
need permission to push code or merge PRs.

`/pr-check <PR URL>` makes read requests and checks configured models without
calling a model. A successful check confirms read access, not permission to
publish. Test publication separately on a suitable PR when you intend to post.

AZPR's REST client uses the PAT only for the configured organization's
`https://dev.azure.com/<organization>` endpoint, and refuses PR URLs for another
organization. Credentials are not included in AZPR's model payloads or
diagnostic settings. With `azure.patFile`, `settings.json` holds no secret:
AZPR opens the PAT file without following symbolic links and refuses it unless
it is a regular file owned by the OpenCode user with no group or other access,
and it reads the file at start and before each command, so a replaced PAT
needs a restart. The installer and `/pr-setup` create `settings.json` with mode
`600`; source replacement preserves it, and native package updates do not
write to it. Keep it outside shared profiles and Git, and
restart OpenCode after changing it. A file only its owner can read protects the
PAT from other accounts, not from programs that run as the same user (an
agent's shell commands, for example), so keep the PAT's scopes minimal and its
lifetime short, and keep it out of environment variables that child processes
inherit. Only a PAT is supported (in `azure.pat` or `azure.patFile`); there is
no Azure CLI, Entra token or environment-variable credential setting. See
[Azure DevOps access](AZURE_DEVOPS.md).

## What the selected model receives

The model connections use your existing OpenCode providers and authentication.
Use providers whose data handling fits the repositories you review; AZPR does
not control their retention or training policies.

| Route | Data involved |
| --- | --- |
| Azure DevOps → AZPR runtime | PR identity and description, changed-file inventory, commit messages, discussions, source files at exact commits, and a repository archive when content search needs one. |
| AZPR → selected models through OpenCode | PR context, assigned paths, commit messages for reviewers, supplementary text after the PR URL, tool results, findings and verification reports. Planning also receives source excerpts and existing-discussion digests, including author names and comment excerpts. |
| AZPR runtime → Azure DevOps | Saved summary and inline comment text, including AI/model disclosure and anchors, only during publication you asked for: `/pr-comment --publish`, or automatic publication after a COMPLETE review when `afterReview` or the review command's `--publish` flag says so. |

Reviewers can follow definitions, callers and tests outside the changed files.
Content search downloads a repository archive into runtime memory, searches it
locally, and returns bounded matches to the model; it does not upload the zip as
a model attachment. Later tool reads can expose additional source. Source and
discussion text are not automatically scrubbed for secrets before being used
as model context.

AZPR's six repository tools are read-only and bound to the review's repository.
Private sessions also have native `read`, `glob` and `grep` for local files and
AZPR's private data. Keep sensitive unrelated files out of the active project.
With `permission.hook`, AZPR refuses native access outside that project except
to its own state directory. Without the hook, `/pr-check` shows **Project
boundary WARNING** while keeping reviews available; the host's permission
rules then decide which paths native tools can reach. A READY result does not
remove that warning.

Keep `shell: "deny"` (the default) unless reviewers need commands.
`shell: "ask"` requests approval; `"inherit"` follows host permissions. Allowed
shell has real host authority and is not a sandbox. Native edit/write tools,
web access, delegation and other MCP tools are excluded from private sessions.
See [authorization and isolation](ARCHITECTURE.md#authorization-and-isolation).

## Preview, cost and publication

Start in one OpenCode conversation with a small PR:

```text
/pr-check <PR URL>
/pr-quick <PR URL>
/pr-comment
```

`/pr-quick` runs one reviewer per shard and no independent verifier. Its
findings are **reported, not verified**; inspect the coverage and limitations
as well as the findings. Use `/pr-review` or `/pr-deep` when you want separate
functional and risk reviewers followed by verification; `/pr-deep` runs the
same review with the stronger models you set in `models.deep`, so its cost
depends on those models. None of these commands
posts to Azure DevOps by default. `afterReview` (per mode) or a flag after the
PR URL can follow a COMPLETE review with a preview (`preview`, `--preview`) or
with publication (`publish`, `--publish`); see
[automatic comments](COMMENTING.md#automatic-comments-after-a-review).

**Preview uses a model.** `/pr-comment` reads live discussions and plans the
comments; each new preview replans and can incur provider charges. One session
can contain several requests, and larger PRs, repairs, retries and overflow
splits add work. `workflow.parallelSessions` controls concurrency, not a token
or spending limit. There is no built-in monetary cap; `runTimeoutSeconds` is
`null` by default, and `/pr-stop <run-id>` cancels a run. See
[debugging](DEBUGGING.md#diagnosis-order) for provider-reported token usage.

After inspecting a preview, explicitly publish the named review:

```text
/pr-comment <review-id> --publish
```

Teams that want comments without that step can set `afterReview` to `publish`
for a mode, or add `--publish` after the PR URL for one review. Automatic
publication posts under the PAT owner's identity without anyone reading the
text first. It holds back, item by item, a comment whose text would notify
people, load or run something when viewed, or hide text from readers: an
`@<…>` mention, an image, HTML that embeds content, runs a script or hides
text, or a `javascript:`, `vbscript:`, `data:` or `file://` link (script links
and mentions also when encoded with escapes or character references, and
script links also with a tab or line break inside, which a browser drops from
a URL). Literal code is skipped where its reading is certain,
except for mentions. Held items wait in the saved preview for a person; the
others, ordinary web links included, are posted. A quick review's comments
carry the disclosure that they were not independently verified; teams that
want a person to read them first set `afterReview.quick` to `preview`.
Automatic publication posts nothing for a review without findings to comment
on, or when every finding is already discussed on the PR. `/pr-check` lists
the `afterReview` setting of each mode and who posts. An automatic preview
still uses a model.

The runtime posts the saved preview, rechecks that the PR is active and its
source commit is unchanged, and skips existing comment markers. If no preview
is saved, `--publish` plans and publishes in the same command; run the preview
first when you want to inspect the text. Publication uses the PAT owner's Azure
identity. Models themselves have no Azure write tool. Repeating publication
recovers partial results; avoid publishing the same PR concurrently from
different OpenCode processes. See [commenting](COMMENTING.md).

## Local records and cleanup

AZPR stores reviews, previews, publication ledgers and observed source under
`${XDG_STATE_HOME:-~/.local/state}/opencode/azpr-v2/`, with owner-only permissions
on the files and directories it creates. A relative `XDG_STATE_HOME` is ignored
in favor of `~/.local/state`. If the normal state directory cannot be created,
AZPR falls back to `azpr-v2-state-<uid>` in the system temporary directory;
include that location when locating or removing records.
The newest **20 completed reviews** are retained across restarts. This is a
count limit, not an expiry period; a quiet installation can retain them
indefinitely. Unreferenced scratch data becomes eligible for cleanup after
24 hours. Fallback receipts have a separate limit of 50. Publication recovery
records under `attempts/` are separate; entries older than 90 days are ignored
when accessed and removed when that PR's record is next rewritten.

With `deletePrivateSessions: true` (default), AZPR requests deletion of its
private review sessions when their completed review is evicted. An unfinished
review normally keeps only its report/draft session, within a separate limit
of 20 runs; diagnostics or an unconfirmed cancellation can retain all of that
run's sessions. Deletion depends on host support and is best effort. Setting
this option to `false` keeps the sessions. Your own conversations are never
deleted by AZPR, and deleting local records does not delete provider records
or published Azure comments.

Diagnostics are off by default (`debug.enabled: false`). When enabled, they
can include source, PR details, prompts, answers and secrets echoed in them.
The default location is `…/opencode/azpr-v2-debug/`, separate from review state;
`debug.directory` changes it and `debug.keepRuns` defaults to 20 (`0` keeps all).
Inspect and redact records before sharing them. See [debugging](DEBUGGING.md).
Uninstall archives the installed package, including its private settings, and
leaves review state in place. To remove local copies, stop OpenCode and handle
the installed settings/backups, state, diagnostics and OpenCode conversations
according to your team's retention needs.

## Corporate proxies and certificates

The following settings affect **AZPR's Azure DevOps requests only**. Configure
model-provider connectivity separately in the OpenCode environment.

| Setting | Behavior |
| --- | --- |
| `azure.proxy` | Forward proxy URL; Basic proxy credentials may be percent-encoded in the URL. NTLM/Kerberos requires a separate local forwarder. |
| `azure.caFile` | Absolute path to PEM CA certificates, added to the built-in trusted roots. Use this for your organization's TLS inspection CA. |
| `azure.verifyTls` | Defaults to `true`. Disabling certificate verification exposes the PAT to intercepted connections and produces a `/pr-check` warning. |

Restart OpenCode after changing transport settings or the CA file. These
options depend on Bun's per-request transport support; an unsupported runtime
refuses to load them. If `azure.proxy` is empty, process-wide proxy environment
settings can still apply. A TLS-inspecting proxy can see the PAT and source
traffic. See [proxies and TLS inspection](AZURE_DEVOPS.md#proxies-and-tls-inspection)
for setup and connection troubleshooting.
