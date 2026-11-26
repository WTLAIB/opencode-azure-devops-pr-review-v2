# Using AZPR with your team

AZPR runs inside your OpenCode process and reads Azure DevOps Services directly.
You choose the models in OpenCode; AZPR has no separate hosted review service or
MCP dependency. Start with the [quickstart](QUICKSTART.md), then use
this page to understand access, data flow and local retention before reviewing
your team's repositories.

The tested environment is **OpenCode V2 `@opencode/cli` 2.4.1 on Ubuntu
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

In OpenCode's terminal UI, `/pr-setup` takes the PAT in a dialog whose field
shows only its length. The terminal UI hands it once to AZPR's server part
over its connection to the OpenCode server (the plugin's RPC), which asks
Azure DevOps whether the token works (one `GET` for at most one pull request
of the organization) and then writes it to the PAT file: created or replaced
in one step, mode `600`, in a directory only its owner can write to. A path
that exists is replaced only when it is a regular file of that user that is
empty or holds one token, so settings that name another file cannot make
setup overwrite it. The PAT
is not kept by the terminal UI and appears in no conversation, notice, log or
answer of that RPC. Where PATs are provisioned by other means, keep doing so:
`/pr-setup` with options takes only the path of an existing PAT file.

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
needs a restart of the OpenCode service. The installer and `/pr-setup` create
`settings.json` with mode `600`, and source replacement preserves it. AZPR
itself writes to the file in two cases only: `/pr-setup` (its options or its
dialogs), and the first time
OpenCode loads a version that brings a setting the file leaves out, which is
then added at its default (the file is replaced atomically, with mode `600`).
A settings file of 0.4.x (`"version": 2`) is the exception: 0.5.0 leaves it
byte for byte and does not use it until someone confirms its update in
`/pr-setup`, which shows the change first (see
[upgrading from 0.4.x](../README.md#upgrading-from-04x)).
A settings file that configuration management owns can stay untouched: keep
it complete (the settings example names every setting), or make it a symbolic
link, which AZPR reads and never replaces; `/pr-check` then names the
settings it leaves out. Setup does not replace a symbolic link either, so
where such a file is still of 0.4.x, ship a version-3 file in its place; the
settings example shows the layout. Keep the file outside shared profiles and Git, and
restart the OpenCode service (`opencode service restart`) after changing it. A file only its owner can read protects the
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
| AZPR → selected models through OpenCode | PR context, assigned paths, commit messages for reviewers, supplementary text after the PR URL, tool results and findings. Planning also receives source excerpts and existing-discussion digests, including author names and comment excerpts. |
| AZPR runtime → Azure DevOps | Saved summary and inline comment text, including AI/model disclosure and anchors, only during publication you asked for: `/pr-comment --publish`, or automatic publication after a COMPLETE review when `afterReview` or the review command's `--publish` flag says so. |

Every model in a mode's list (`models.<mode>.reviewers`) is one review pass
over every changed file, so each of those providers receives the PR's source.
The first model of the list also receives the other passes' findings: it runs
the duplicate check, which may read the source again, and plans the comments.

The severity rating runs unless `models.<mode>.rater` is `false`, with the
first reviewer model or with the model `rater` names. It
receives only the reported findings' text and the PR title and description; it
has no tools, so it reads nothing else. A finding's text quotes the source it
is about.

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

**Your local project's instructions are not sent along.** OpenCode adds to
every request of an ordinary session what it collects for the conversation's
directory: instruction files (`AGENTS.md`, `CLAUDE.md`, the ones a
configuration lists) and what MCP servers, references and skills say of
themselves. AZPR keeps these out of its private sessions, which get AZPR's own
instructions and OpenCode's date and environment, and it also keeps from the
model the instruction files OpenCode loads when a reviewer's native `read`
reads a file beside one. With a `claude-agent` model this holds for what
OpenCode hands the Claude Code program; what that program reads from the
working directory by itself (it has instruction files of its own, such as
`CLAUDE.md`) is outside AZPR, and was not tried with the real program. A reviewer can still read such a file on purpose,
like any other file of the active project. This relies on a field of
OpenCode's plugin interface that OpenCode marks as experimental: where AZPR
cannot tell the parts of a request apart (another plugin rewrote them, or a
later OpenCode builds them another way), it sends those parts as it received
them, with whatever they hold of what OpenCode collected for the directory,
and the stage's
[debug record](DEBUGGING.md) says so (`placeInstructionsNotToldApart`). The
instruction files loaded beside a file are taken out of the request either
way, where they are as OpenCode builds them; one that another plugin changed
first goes out as that plugin left it. The same record counts such a request
only where the changed message still has the loaded file's ID; text that a
plugin moved into another message is not seen at all. AZPR does not police
other plugins: what another plugin's hook adds
to a request, takes from it or makes of a tool's result, before or after
AZPR's own hook, AZPR neither sees nor corrects. List AZPR first among the
plugins of your `opencode.json`: its hook then runs before those of the
plugins listed after it. It does not run before the hooks of a plugin that
OpenCode loads from a configuration directory's `plugin/` or `plugins/`
folder, which are loaded first, nor before any other plugin's where AZPR's
runtime starts late (after a first `/pr-setup` in a running OpenCode). So
install only plugins you trust with what a review reads.

**Experiments of OpenCode that reach these sessions.** Three opt-in
experiments of OpenCode 2.4 concern AZPR's private sessions; all are off
unless you turn them on. With `full_codemode`, the model of any ordinary
conversation can interrupt another session, a running review's included (its
stage ends as interrupted and is not retried). With `sqlite_fts`, sessions
are indexed for search and ordinary conversations get tools that search and
read them, among them the session that keeps a review's report (every session
of a run while `debug.enabled` is on). With `home_memory`, a daily
maintenance session reads the conversations under your home directory. This
is read from OpenCode's source, not exercised.

## Preview, cost and publication

Start in one OpenCode conversation with a small PR:

```text
/pr-check <PR URL>
/pr-quick <PR URL>
/pr-comment
```

Every mode runs the same review with the models listed for it: `/pr-quick`
usually one pass of a fast model, `/pr-review` the passes of
`models.review.reviewers` (two after a first setup), and `/pr-deep` the
stronger models, or the additional passes, of `models.deep.reviewers`. In
every mode findings are **reported, not verified**: each reviewer checks its
own findings against the source, the runtime checks only their form and
source, and no stage re-checks them. Inspect the coverage and limitations
as well as the findings. None of these commands
posts to Azure DevOps by default: a COMPLETE review is followed by a comment
preview, which uses a model and posts nothing. `afterReview` (per mode) or a
flag after the PR URL changes that to nothing (`none`, `--no-comment`) or to
publication (`publish`, `--publish`); see
[automatic comments](COMMENTING.md#automatic-comments-after-a-review).

**Cost follows the lists.** Each entry of a mode's list is one more reviewer
session per shard, and the duplicate checks, the rating and comment planning
run with the first entry (the rating with `rater`, where one is named).
Passes run side by side, so more passes mainly cost more. With OpenCode's
`claude-agent` provider, each session has a local `claude` process of about
200 MB that ends five minutes after the session's last turn; OpenCode 2.4.0
and later also end it when AZPR deletes the session. A service that runs many
passes over many shards with such models needs memory for the sessions that
run at once and for those of the last five minutes.

**Preview uses a model.** `/pr-comment` reads live discussions and plans the
comments; each new preview replans and can incur provider charges. One session
can contain several requests, and larger PRs, repairs, retries and overflow
splits add work. `workflow.parallelSessions` controls concurrency, not a token
or spending limit. There is no built-in monetary cap; `runTimeoutSeconds` is
`null` by default, and `/pr-stop <run-id>` cancels a run. See
[debugging](DEBUGGING.md#diagnosis-order) for provider-reported token usage.

After inspecting a preview, explicitly publish it. The command acts on the
conversation's current review, and its start notice and receipt name the
review and its PR; a review ID before the option names another one:

```text
/pr-comment --publish
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
others, ordinary web links included, are posted. Every comment carries the
disclosure that its findings were checked by their reviewer and that no
separate verification ran; teams that want a person to read comments first
leave `afterReview` at `preview`.
Automatic publication posts nothing for a review without findings to comment
on, or when every finding is already discussed on the PR. `/pr-check` lists
the `afterReview` setting of each mode and who posts. An automatic preview
still uses a model.

The runtime posts the saved preview, rechecks that the PR's source commit is
unchanged, and skips existing comment markers. A completed or abandoned PR
takes comments like an active one; the receipt names that status. If no
preview is saved, `--publish` plans and publishes in the same command; run the
preview first when you want to inspect the text. Publication uses the PAT
owner's Azure identity. Models themselves have no Azure write tool. Repeating publication
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

AZPR's private review sessions are sessions of their own, listed by OpenCode
next to a person's conversations and titled `[AZPR <id>] …`. With
`deletePrivateSessions: true` (default), AZPR requests deletion of a run's
sessions when the run ends, except the one that holds the review's report or
draft; a comment run keeps none. The kept session is deleted when its
completed review is evicted, or, for an unfinished review, within a separate
limit of 20 runs. Diagnostics or an unconfirmed cancellation retain all of a
run's sessions until then. Deletion depends on host support and is best
effort: a session whose deletion failed stays on record and is requested
again with the review. Setting this option to `false` keeps the sessions. Your own conversations are never
deleted by AZPR, and deleting local records does not delete provider records
or published Azure comments.

With a `claude-agent` model there is one more local record, which AZPR does
not manage: Claude Code keeps a transcript of every session under its own
configuration directory (`~/.claude/projects/<working directory>/` by default;
OpenCode 2.4.0 and later can name another directory for that provider). It
holds what AZPR sent, source excerpts of the PR included, in files only the
user can read. Deleting the OpenCode session does not delete the transcript.
Claude Code's own cleanup removes it (after 30 days by default). Do not delete
the folder of a working directory to be rid of a review's transcripts sooner:
the same folder holds the transcripts of every Claude Code conversation in
that working directory, your own included. For code that must not stay that
long, delete only the transcript files you have identified as a review's, or
keep OpenCode's transcripts apart from your own from the start, in a
configuration directory that only that provider uses (its `configDir`
setting, OpenCode 2.4.0 and later); what lies there belongs to every OpenCode
conversation that uses the provider, not only to reviews.

The [terminal panel](../README.md#terminal-panel) runs in OpenCode's terminal
UI. It reads AZPR's notices and the report queued to a review session from the
OpenCode server that terminal UI is connected to, and keeps what it read in
memory only; it stores nothing. It sends nothing to a model or to Azure
DevOps, and reads neither AZPR's settings file nor the PAT: the one
setting meant for it, `terminalPanel`, reaches it as metadata of AZPR's
notices, and so does what a notice offers as a next step. The one thing it
sends is to that same OpenCode server: the command of a step a person picked
at the panel's foot (`/pr-comment`, or `/pr-stop` for a run under way), which
AZPR's server part takes like a typed command; posting comments or stopping a
run that way asks once more first. The [setup dialogs](../README.md#setup-in-the-terminal-ui) of the
same terminal part talk to AZPR's server part only: they read and write no
file, contact neither Azure DevOps nor a model, and store nothing. What they
are told of the settings never includes the PAT or a proxy's user name and
password.

Diagnostics are off by default (`debug.enabled: false`). When enabled, they
can include source, PR details, prompts, answers and secrets echoed in them.
The default location is `…/opencode/azpr-v2-debug/`, separate from review state;
`debug.directory` changes it and `debug.keepRuns` defaults to 20 (`0` keeps all).
Inspect and redact records before sharing them. See [debugging](DEBUGGING.md).
Uninstall archives the installed package, including its private settings, and
leaves review state in place. To remove local copies, stop OpenCode and handle
the installed settings/backups, state, diagnostics and OpenCode conversations
according to your team's retention needs.

## Company networks

Three kinds of connection leave your machine, and each is configured where it
is made. Set up the first before `opencode plugin add`:

| Connection | Made by | Configure |
| --- | --- | --- |
| Package download for `opencode plugin add` | The `opencode` command in your terminal | `HTTPS_PROXY` (and `HTTP_PROXY`, `NO_PROXY`) in that terminal, or `https-proxy` in your user `~/.npmrc`. OpenCode does not read a project's `.npmrc` or, by default, npm's global configuration. |
| Package download when a changed `plugins` entry or a start finds a version that is not installed yet | The OpenCode background service | The service's environment, set with `opencode service set env` |
| Model providers | The OpenCode background service | The service's environment, as in OpenCode's [network guide](https://opencode.ai/v2/docs/network) |
| Azure DevOps | AZPR, inside the OpenCode service | `azure.proxy` and `azure.caFile` below; with an empty `azure.proxy`, the service environment's proxy variables apply |

- The `opencode` command reaches the background service over the loopback
  interface. OpenCode 2.3.0 adds `127.0.0.1,localhost,::1` to `NO_PROXY`
  itself, so a terminal proxy no longer catches that connection; keep your
  organization's existing exceptions in `NO_PROXY`.
- A variable set with `opencode service set env` applies when the service
  starts; setting one stops the running service, so start it again with
  `opencode service start`. Exports in a terminal do not change a service that
  is already running. Do not share the output of `opencode service get env`:
  it shows the values, including proxy credentials.
- For a company CA, OpenCode reads a PEM file named by `NODE_EXTRA_CA_CERTS`
  (in the terminal, and in the service environment); see OpenCode's
  [network guide](https://opencode.ai/v2/docs/network). `azure.caFile` applies
  only to AZPR's Azure DevOps requests and cannot fix a package-download
  certificate error.
- Keep TLS verification on. A failed package download leaves nothing changed
  when `opencode plugin add` makes it; when the service makes it, AZPR's
  commands disappear until the package is available and the service restarts
  (see [upgrading](../README.md#upgrading)).

### Azure DevOps requests

The following settings affect **AZPR's Azure DevOps requests only**. Configure
model-provider connectivity separately in the OpenCode environment.

| Setting | Behavior |
| --- | --- |
| `azure.proxy` | Forward proxy URL; Basic proxy credentials may be percent-encoded in the URL. NTLM/Kerberos requires a separate local forwarder. |
| `azure.caFile` | Absolute path to PEM CA certificates, added to the built-in trusted roots. Use this for your organization's TLS inspection CA. |
| `azure.verifyTls` | Defaults to `true`. Disabling certificate verification exposes the PAT to intercepted connections and produces a `/pr-check` warning. |

Restart the OpenCode service after changing transport settings or the CA file. These
options depend on Bun's per-request transport support; an unsupported runtime
refuses to load them. If `azure.proxy` is empty, process-wide proxy environment
settings can still apply. A host listed in the service environment's `NO_PROXY`
bypasses `azure.proxy` too, because Bun applies `NO_PROXY` to an explicit proxy;
keep `dev.azure.com` out of it when Azure DevOps must go through the proxy. A TLS-inspecting proxy can see the PAT and source
traffic. See [proxies and TLS inspection](AZURE_DEVOPS.md#proxies-and-tls-inspection)
for setup and connection troubleshooting.
