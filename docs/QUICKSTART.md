# Your first review

This guide gets you from a clean installation to a private comment preview.
Use a small, active Azure DevOps Services PR for the first run.

## 1. Check the prerequisites

- OpenCode **V2** (`@opencode/cli`), tested with **2.1.2** on **Ubuntu
  22.04.5 LTS (WSL2)**. Other host versions and operating systems are not
  validated; see [validation](VALIDATION.md). This is not a V1 plugin.
- An authenticated OpenCode model with tool support. Copy its exact
  `provider/model` ID from your host's model selection or `opencode models`.
  AZPR uses your existing provider account.
- Access to the npm registry for the npm package, or Git for the Git package.
  The alternative source installer needs POSIX `sh` and Python 3. AZPR has no
  build step or npm dependencies.
- An organization-scoped Azure DevOps PAT. The recommended scopes are **Code:
  Read** and **Pull Request Threads: Read & write**; see
  [access and validation limits](ENTERPRISE.md).

Check the host version:

```sh
opencode --version
```

## 2. Install v0.2.1

Already using an earlier version? Follow the [upgrade instructions](releases/v0.2.1.md#upgrading)
to preserve your current configuration and use one AZPR installation.

In your terminal:

```sh
opencode plugin add opencode-azure-devops-pr-review@0.2.1
```

Restart OpenCode and open an ordinary conversation. This is the host's native
package installation; no npm account or separate build is needed. The
plugin exposes `/pr-setup` even before its review configuration exists.

To install the same release from Git instead of the npm registry, use
`opencode plugin add 'github:WTLAIB/opencode-azure-devops-pr-review-v2#v0.2.1'`.
Add only one of the two.

For an existing source installation, keep using `install.sh --replace`, or
follow the migration notes in [installation](../README.md#native-package-npm-or-git).
Do not load both copies in the same OpenCode profile.

Prefer a source archive? Download and extract the
[v0.2.1 archive](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/archive/refs/tags/v0.2.1.tar.gz),
then run `sh install.sh --config-dir /absolute/path/to/your/opencode-config`
inside it. That directory must be the one your OpenCode actually loads. The
source installer creates starter settings; add `--replace` to the setup
command below to configure that existing file.

## 3. Configure one model and your Azure organization

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

If the file already exists, reuse your existing owner-only PAT file, or choose
another unused path. Do not paste a PAT into a conversation or command argument.

In OpenCode, run `/pr-setup` to see the settings path and available model IDs.
Then replace all three placeholders in this command:

```text
/pr-setup --organization YOUR_ORGANIZATION --model YOUR_PROVIDER/YOUR_MODEL --pat-file "/absolute/path/to/azpr/pat"
```

Use the organization name from `https://dev.azure.com/<organization>`, not the
full URL. Use the absolute PAT file path printed above. The command checks the
model catalog and the PAT file, then saves configuration with owner-only
permissions. It makes no model request and does not contact Azure.

One model selection configures the quick reviewer and all three review roles.
`/pr-quick` still runs only its own reviewer; `/pr-review` uses separate reviewer
and verifier sessions. Deep models remain unset until you choose stronger
models for that mode. Setup preserves other settings when explicitly replacing
an existing file with `--replace`.

Native installations save settings outside the package cache at
`${XDG_CONFIG_HOME:-~/.config}/azpr/settings.json`. Source installations keep
`plugins/azpr-v2/settings.json`; `/pr-setup` shows the exact path. An explicit
`options.settingsFile` can select a different absolute path; see
[configuration](../README.md#configuration).

**Restart the OpenCode service after saving.** Settings are read once at plugin
startup; closing a conversation or reopening the terminal UI alone does not
reload a running background service. For the usual managed service, run this
in your terminal, then reopen OpenCode:

```sh
opencode service restart
```

If you run `opencode serve` yourself, restart that process instead.
If your network needs a proxy or company CA, configure it in that settings file
as described in [enterprise setup](ENTERPRISE.md), then restart. Leave
`shell: "deny"` and TLS verification enabled. See
[all settings](../README.md#configuration) for output language, model variants
and separate models for each role.

## 4. Check access without a model request

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
row says whether `/pr-deep` is set up (see below).

On a host without `permission.hook`, **Project boundary WARNING** means the
host's own permission rules control where native read tools can read; reviews
remain available. The tested OpenCode 2.1.2 host has that hook. `READY` is an
access check, not a security audit or an approval of the PR.

## 5. Run a quick review, then preview its comments

```text
/pr-quick https://dev.azure.com/YOUR_ORGANIZATION/YOUR_PROJECT/_git/YOUR_REPO/pullrequest/123
```

This starts model work. Follow the progress notices and wait for the final
receipt. Use its eight-character review ID in the **same conversation** below
(`1a2b3c4d` is an example):

```text
/pr-comment 1a2b3c4d
```

This runs comment planning and saves a preview; **it does not post to Azure**.
Inspect the proposed summary, inline comments and skipped findings. A quick
review's findings are `REPORTED`, with `verification none`; `COMPLETE` can
still have incomplete coverage. Read the coverage and limitations before
deciding what to publish. A review that is `PARTIAL` or `STALE` cannot be
commented on; resolve the cause and run a new review.

For a small PR, quick review commonly uses one review session plus one comment
planning session. **A session is not a single model request**: tool reads,
corrections, retries, more shards or planning pages add requests and cost.
Refreshing a preview with `/pr-comment` runs planning again. Use the displayed
`/pr-stop <run-id>` to cancel an active command; no cost cap is configured by
default.

## Optional: publish after inspecting the preview

```text
/pr-comment 1a2b3c4d --publish
```

This explicit command posts the saved preview through your PAT after checking
the PR is active and its source commit is unchanged. Existing markers are
skipped. Check the publication receipt for failures or incomplete read-back.
If no preview exists, this command plans before publishing. To get the preview
without typing `/pr-comment`, add `--preview` right after the PR URL of the
review command; [automatic comments](COMMENTING.md#automatic-comments-after-a-review)
explains `afterReview` and automatic publication.

For important changes, use `/pr-review` to run two reviewer roles followed by
an independent verification session. The starter setup uses the same model in
separate sessions; you can assign different models later. `/pr-deep` runs the
same review with the models of `models.deep`, so put a stronger (usually slower
and costlier) model in all three deep slots and keep it for the changes that
justify it; with the review's models it would only repeat `/pr-review`, and
`/pr-check` warns about that. Both modes still produce AI findings that require
human judgment; see [commands](../README.md#commands).
