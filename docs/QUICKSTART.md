# Your first review

This guide gets you from a clean installation to a private comment preview.
Use a small, active Azure DevOps Services PR for the first run.

## 1. Check the prerequisites

- OpenCode **V2** (`@opencode/cli`), tested with **2.0.32** on **Ubuntu
  22.04.5 LTS (WSL2)**. Other host versions and operating systems are not
  validated; see [validation](VALIDATION.md). This is not a V1 plugin.
- An authenticated OpenCode model with tool support. Copy its exact
  `provider/model` ID from your host's model selection; AZPR does not configure
  or pay for a provider account.
- Git, POSIX `sh` and Python 3 for the steps below. No `npm install` or build
  step is needed to install AZPR.
- An organization-scoped Azure DevOps PAT. The recommended scopes are **Code:
  Read** and **Pull Request Threads: Read & write**; see
  [access and validation limits](ENTERPRISE.md) before configuring credentials.

Check the host version:

```sh
opencode --version
```

## 2. Install a pinned revision

Clone the repository into a new directory and select this known revision:

```sh
git clone https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2.git
cd opencode-azure-devops-pr-review-v2
git checkout --detach d7cd0ace81d7de7037cfcb514cc3201fb6b0a2fc
```

Choose the **configuration directory your OpenCode V2 installation actually
loads**, then replace the example path below. It is the directory containing
the `plugins/` directory, not the source repository or the plugin directory.
Selecting an arbitrary new directory does not make OpenCode load it.

```sh
AZPR_CONFIG_DIR="/absolute/path/to/your/opencode-v2-config"
sh install.sh --config-dir "$AZPR_CONFIG_DIR"
```

The installer creates `plugins/azpr-v2/` inside that directory. For an existing
AZPR V2 installation, use the same command with `--replace`; it preserves
operational settings. See [installation](../README.md#requirements-and-installation)
for conflict handling and manual copying.

## 3. Configure one model and your Azure organization

Open `$AZPR_CONFIG_DIR/plugins/azpr-v2/settings.json` in your editor. Update
the following fields **inside the installed file**, keeping its other fields
(including `"version": 2`). Replace every placeholder:

```json
{
  "models": {
    "review": {
      "functional": "YOUR_PROVIDER/YOUR_MODEL",
      "risk": "YOUR_PROVIDER/YOUR_MODEL",
      "verifier": "YOUR_PROVIDER/YOUR_MODEL"
    },
    "deep": { "functional": "", "risk": "", "verifier": "" },
    "quick": { "reviewer": "YOUR_PROVIDER/YOUR_MODEL" }
  },
  "azure": {
    "organization": "YOUR_ORGANIZATION",
    "pat": "YOUR_PERSONAL_ACCESS_TOKEN"
  }
}
```

For this first run, use the **same real model ID in all four populated model
slots**. The review slots are required by the settings format, and `/pr-check`
checks their availability. Leaving any installer model placeholder prevents
AZPR from loading; a valid-looking but unavailable review model makes
`/pr-check` report `NOT_READY`, even with a valid quick model. Configuring these slots
does not start them: `/pr-quick` uses only `quick.reviewer`.

Use the organization name from `https://dev.azure.com/<organization>`, not the
full URL. Keep the PAT in this private installed file, never in Git or chat.
If your network requires a proxy or a company CA, configure it as described in
[enterprise setup](ENTERPRISE.md). Leave `shell: "deny"` and TLS verification
enabled. See [all settings](../README.md#configuration) for output language,
model variants and separate models for each role.

**Restart OpenCode** using its usual configuration and open an ordinary
conversation. Restart again after any settings change.

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
`READY`.

On a host without `permission.hook`, **Project boundary WARNING** means the
host's own permission rules control where native read tools can read; reviews
remain available. The tested OpenCode 2.0.32 host has that hook. `READY` is an
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
If no preview exists, this command plans before publishing.

For important changes, use `/pr-review` to run two reviewer roles followed by
an independent verification session. The starter setup uses the same model in
separate sessions; you can assign different models later. `/pr-deep` requires
all three deep model slots. Both modes still produce AI findings that require
human judgment; see [commands](../README.md#commands).
