# Your first review

This guide gets you from a clean installation to a private comment preview.
Use a small, active Azure DevOps Services PR for the first run. Steps 1–3 and
5 run in a terminal; steps 4, 6 and 7 run in OpenCode.

Already using an earlier version? Follow [upgrading](../README.md#upgrading)
instead, to keep your configuration and one AZPR installation.

## 1. Check the prerequisites (terminal)

- **OpenCode CLI 2.1.4** (`@opencode/cli`, V2 plugin API), tested on **Ubuntu
  22.04.5 LTS (WSL2)**. Other host versions and operating systems are not
  validated; see [validation](VALIDATION.md). OpenCode 1.x is not supported.
- An authenticated OpenCode model with tool support, and its exact
  `provider/model` ID from `opencode models` or your host's model selection.
  AZPR uses your existing provider account.
- Your Azure DevOps organization (the `<org>` in `https://dev.azure.com/<org>`)
  and an organization-scoped PAT. The recommended scopes are **Code: Read** and
  **Pull Request Threads: Read & write**; see
  [access and validation limits](ENTERPRISE.md).
- Access to the npm registry for the npm package, or Git for the Git package.
  AZPR has no build step or npm dependencies. Behind a company proxy, set up
  the terminal first: see [company networks](ENTERPRISE.md#company-networks).

```sh
opencode --version
opencode models
```

## 2. Save the PAT in a private file (terminal)

Put the PAT alone in a file only you can read. The following **Bash** example
creates a new file and refuses to overwrite an existing one. Input is hidden
and is not added to shell history:

```sh
AZPR_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/azpr"
mkdir -p "$AZPR_USER_DIR"
(
  umask 077
  set -o noclobber
  read -rs -p 'Azure DevOps PAT: ' AZPR_PAT
  printf '\n'
  test -n "$AZPR_PAT" && printf '%s' "$AZPR_PAT" > "$AZPR_USER_DIR/pat"
)
printf 'PAT file: %s\n' "$AZPR_USER_DIR/pat"
```

This is the default PAT file that `/pr-setup` uses. If the file already
exists, reuse your existing owner-only PAT file, or choose another unused path
and name it with `--pat-file` in step 4. Do not paste a PAT into a
conversation or command argument.

## 3. Install the package (terminal)

```sh
opencode plugin add opencode-azure-devops-pr-review@0.3.0
```

This is the host's native package installation; no npm account or separate
build is needed. OpenCode 2.1.4 loads the plugin into a running OpenCode
service within a few seconds, and otherwise when OpenCode next starts. The
plugin exposes `/pr-setup` even before its review configuration exists.

To install the same release from Git instead of the npm registry, use
`opencode plugin add 'github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.3.0'`.
Add only one of the two. For a source archive or an existing source
installation, see [other installation methods](#other-installation-methods).

## 4. Configure one model and your Azure organization (OpenCode)

Open OpenCode and start an ordinary conversation. If `/pr-setup` is not
listed, run `opencode service restart` in your terminal and reopen OpenCode.

Run `/pr-setup` alone to see the settings path, the default PAT file and the
available model IDs. Then replace both placeholders in this command:

```text
/pr-setup --organization YOUR_ORGANIZATION --model YOUR_PROVIDER/YOUR_MODEL
```

Use the organization name from `https://dev.azure.com/<organization>`;
`--organization` also accepts your PR's URL. Add
`--pat-file "/absolute/path/to/pat"` when your PAT file is not the default one
from step 2. The command checks the model catalog and the PAT file, then saves
configuration with owner-only permissions. It makes no model request and does
not contact Azure.

One model selection configures the quick reviewer and all three review roles.
`/pr-quick` still runs only its own reviewer; `/pr-review` uses separate reviewer
and verifier sessions. Deep models remain unset until you choose stronger
models for that mode. Setup preserves other settings when explicitly replacing
an existing file with `--replace`, and then keeps the PAT file already set
unless you name another one.

Native installations save settings outside the package cache at
`${XDG_CONFIG_HOME:-~/.config}/azpr/settings.json`. Source installations keep
`plugins/azpr-v2/settings.json`; `/pr-setup` shows the exact path. An explicit
`options.settingsFile` can select a different absolute path; see
[configuration](../README.md#configuration).

Make any other changes to that settings file now, before the restart in step 5:
behind a company proxy, AZPR's Azure DevOps requests need `azure.proxy` (and
`azure.caFile` for a company CA) as described in
[company networks](ENTERPRISE.md#company-networks); leave `shell: "deny"` and TLS
verification enabled. See [all settings](../README.md#all-settings-and-defaults)
for output language and other options, and
[model configuration](../README.md#configuration) for model variants and
separate models for each role.

## 5. Restart the OpenCode service (terminal)

Settings are read when OpenCode loads AZPR, so restart the service once after
saving them:

```sh
opencode service restart
```

If you run `opencode serve` yourself, restart that process instead. Closing a
conversation or reopening the terminal UI alone does not reload a running
background service.

## 6. Check access without a model request (OpenCode)

In OpenCode, replace this sample with your PR's URL:

```text
/pr-check https://dev.azure.com/YOUR_ORGANIZATION/YOUR_PROJECT/_git/YOUR_REPO/pullrequest/123
```

Wait for the final `READY` receipt after `STARTED`. This reads PR metadata,
changed files, sample source and discussions, and checks the model catalog;
it neither runs a review nor tests model-provider authentication or Azure write
permissions. Fix any `NOT_READY` result before continuing. A **Quick model
WARNING** also needs fixing before `/pr-quick`, even if the overall result is
`READY`; a **Deep model** WARNING likewise before `/pr-deep`. The **Deep models**
row says whether `/pr-deep` is set up (see below), and the **AZPR** row names
the installation that answered.

On a host without `permission.hook`, **Project boundary WARNING** means the
host's own permission rules control where native read tools can read; reviews
remain available. The tested OpenCode 2.1.4 host has that hook. `READY` is an
access check, not a security audit or an approval of the PR.

## 7. Run a review and preview its comments (OpenCode)

```text
/pr-review https://dev.azure.com/YOUR_ORGANIZATION/YOUR_PROJECT/_git/YOUR_REPO/pullrequest/123 --preview
```

This starts functional and risk reviewers, followed by separate verification.
The starter setup uses the same model in separate sessions; you can assign
models per role later. For a lighter pass, use `/pr-quick <PR URL> --preview`
instead: it runs one reviewer per shard without independent verification.

Follow the progress notices and wait for the review receipt. If the COMPLETE
review has findings to comment on, `--preview` starts a separate comment run
that saves a preview; wait for its receipt too. **Neither command posts to
Azure**, even if your settings normally enable automatic publication. A review
with no findings to comment on produces a notice without running a planner.
A review that is `PARTIAL` or `STALE` cannot be commented on; resolve the cause
and run a new review.

Inspect the report, proposed summary, inline comments and skipped findings.
Check coverage and limitations: COMPLETE does not mean every file was reviewed
or every finding confirmed. Quick findings are `REPORTED`, with `verification
none`. Keep the review's eight-character ID for publication in the **same
conversation** (`1a2b3c4d` below is an example).

For a small PR, `/pr-review` commonly uses two reviewer sessions, a verifier
session and a comment-planning session; `/pr-quick` commonly uses one review
session plus comment planning. **A session is not a single model request**:
tool reads, corrections, retries, more shards or planning pages add requests
and cost. Refreshing a preview with `/pr-comment <review-id>` runs planning
again. Use the displayed `/pr-stop <run-id>` to cancel an active command; no
cost cap is configured by default.

## Optional: adjust findings before publishing

Use finding IDs from your report to leave findings out or change their severity:

```text
/pr-comment 1a2b3c4d --exclude F-1 --severity F-2=low
```

In this example, F-1 is excluded from the new preview; F-2 appears as low in the
summary, with no new inline comment. The original review is preserved. A changed
severity does not verify the finding again; exclude a finding when it is wrong.

AZPR uses a model to plan the comments again without rerunning the review, so
read the whole new preview. Each option replaces its own saved list:
`--exclude F-1` followed by `--exclude F-2` excludes only F-2; use
`--exclude F-1,F-2` to keep both out. `--reset` clears both adjustment lists
and plans again; `--show` displays the saved preview without a model or Azure
request. See [adjusting findings](COMMENTING.md#adjusting-findings-after-a-preview)
for the full rules.

## Optional: publish after inspecting the preview

```text
/pr-comment 1a2b3c4d --publish
```

This explicit command posts the saved preview through your PAT after checking
the PR is active and its source commit is unchanged. Existing markers are
skipped. Check the publication receipt for failures or incomplete read-back.
An adjusted review needs a saved preview planned after its latest adjustment,
also after `--reset`; `--publish` refuses if that preview is missing. Once
publication starts, its adjustments and preview are fixed, and `--publish`
retries the saved content. Earlier comments on the PR are never edited; the
receipt names those whose text differs from an adjusted preview.

For a review that has never been adjusted, `--publish` plans first if no preview
exists; use `/pr-comment <review-id>` to prepare and inspect a preview first. See
[automatic comments](COMMENTING.md#automatic-comments-after-a-review) for
`afterReview` and the flags that override it for one review.

For important changes, `/pr-deep` runs the same review as `/pr-review` with
the models of `models.deep`. Put stronger (usually slower and costlier) models
in all three deep slots and keep it for changes that justify the cost; with
the review's models it would only repeat `/pr-review`, and `/pr-check` warns
about that. All modes produce AI findings that require human judgment; see
[commands](../README.md#commands).

## Other installation methods

For an existing source installation, keep using `install.sh --replace`, or
follow the migration notes in [installation](../README.md#native-package-npm-or-git).
Do not load both copies in the same OpenCode profile.

Prefer a source archive? Download and extract the
[v0.3.0 archive](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/archive/refs/tags/v0.3.0.tar.gz),
then run `sh install.sh --config-dir /absolute/path/to/your/opencode-config`
inside it. That directory must be the one your OpenCode actually loads. The
source installer creates starter settings, so add `--replace` to the setup
command in step 4, then restart the OpenCode service as in step 5.
