# Contributing

Bug reports, focused fixes and documentation improvements are welcome. Start
with the [quickstart](docs/QUICKSTART.md), [architecture](docs/ARCHITECTURE.md)
and [roadmap](docs/ROADMAP.md). Public source and documentation use English.
Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md), which
also says where to report a conduct problem.

## Report a problem or suggest a change

Use the [issue forms](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/issues/new/choose).
Include the AZPR tag or commit, OpenCode version, operating system, command and
a small reproduction. For a review failure, the sanitized error and relevant
receipt stage are usually enough to start. Describe the PR's approximate file
and changed-line counts if its size matters. You do not need to share a company
repository or run a paid review again to file a report.

Issues are public. Never attach raw settings, PATs, provider credentials,
proxy URLs containing credentials, `.local/`, state directories or complete
diagnostics. Receipts and screenshots can also contain private organization,
repository and source details; inspect and redact excerpts before sharing.
See [debugging](docs/DEBUGGING.md) and [data handling](docs/ENTERPRISE.md).
Report suspected security vulnerabilities through [private reporting](SECURITY.md).

For a larger feature, describe the use case and proposed behavior in an issue
before investing in an implementation. A documentation fix or small bug fix
can go straight to a pull request.

## Work locally

Use Node.js 22.12 or later, POSIX `sh`, Python 3 and Git. The current host
acceptance target is the OpenCode V2 `@opencode/cli` release that `TESTED_HOST_VERSION` in
`src/host.mjs` names (the README's [Compatibility](README.md#compatibility) row shows it), on Ubuntu
22.04; other environments are not yet validated. The installed plugin has no npm
dependencies and is not built at installation. The checkout has one
development dependency, the compiler of the terminal panel's JSX, which
`npm ci` installs. From your checkout:

```sh
npm ci
npm run check
npm test
```

The terminal panel's view is written in `src/tui-view.jsx` and compiled to
`src/tui.js`, which is what OpenCode loads (see
[architecture](docs/ARCHITECTURE.md#terminal-panel)). After changing the
source, run `npm run build:tui` and commit both files; `npm run check` fails
when they differ. What the panel shows is worked out in `src/tui-model.mjs`,
what the steps at its foot do in `src/tui-actions.mjs` and what the setup dialogs ask in
`src/tui-setup.mjs`; all three import nothing and have ordinary unit tests. `tests/tui-view.test.mjs` loads the compiled
view itself, with stand-ins for what the host provides, for the wiring that
draws nothing (which server part the dialogs talk to, when they open).

Read [AGENTS.md](AGENTS.md) for the design rules and change-specific checks.
Keep deterministic PR facts and Azure writes in the runtime; models supply
review judgment and comment text. Never present findings as verified: every
mode runs one pipeline in which a reviewer checks its own findings and no
stage verifies them afterwards, and reports, receipts and comments say so.
The review system prompts are locked by a hash test
(`tests/config.test.mjs`), so a change to them is deliberate: update the
hashes together with the validation notes. Add a focused regression test
when fixing behavior, and update the relevant documentation when it changes.

Changes to hooks, sessions, tools, Azure access or publication also need the
first nine host fixture runs below. Changes to package entry points,
first-run setup or the settings path need the `--native` smoke run; changes
to the terminal panel, or to the text of notices and receipts, which the
panel reads, the two `host-v2-tui-panel` runs; and changes to setup, the
terminal part or the settings path the four `host-v2-tui-setup` runs. Install the tested host into a disposable local directory
without changing your everyday OpenCode installation:

```sh
AZPR_HOST_VERSION=$(node --input-type=module -e "import('./src/host.mjs').then(m => process.stdout.write(m.TESTED_HOST_VERSION))") &&
  test -n "$AZPR_HOST_VERSION" &&
  npm install --prefix "$PWD/.local/contributor-host" --no-audit --no-fund "@opencode/cli@$AZPR_HOST_VERSION"
AZPR_TEST_HOST="$PWD/.local/contributor-host/node_modules/.bin/opencode"
node tests/host-v2-smoke.mjs "$AZPR_TEST_HOST"
node tests/host-v2-smoke.mjs "$AZPR_TEST_HOST" --replace
node tests/host-v2-smoke.mjs "$AZPR_TEST_HOST" --native
node tests/host-v2-comment-scale.mjs "$AZPR_TEST_HOST"
node tests/host-v2-background-compaction.mjs "$AZPR_TEST_HOST"
node tests/host-v2-decline.mjs "$AZPR_TEST_HOST"
node tests/host-v2-output-limit.mjs "$AZPR_TEST_HOST"
node tests/host-v2-comment-scale.mjs "$AZPR_TEST_HOST" --cleanup
node tests/host-v2-background-compaction.mjs "$AZPR_TEST_HOST" --cleanup
node tests/host-v2-tui-panel.mjs "$AZPR_TEST_HOST"
node tests/host-v2-tui-panel.mjs "$AZPR_TEST_HOST" --native
node tests/host-v2-tui-setup.mjs "$AZPR_TEST_HOST"
node tests/host-v2-tui-setup.mjs "$AZPR_TEST_HOST" --native
node tests/host-v2-tui-setup.mjs "$AZPR_TEST_HOST" --migrate
node tests/host-v2-tui-setup.mjs "$AZPR_TEST_HOST" --migrate --native
```

The two `--cleanup` runs have debug off. Debug keeps every private session, so
only these runs exercise the deletion of a run's sessions on the host. The
`host-v2-tui-panel` and `host-v2-tui-setup` runs start the real terminal UI
in a detached `tmux` session, read its screen and drive its keyboard and
mouse; they need `tmux` (3.2 or later), each once installed from source and
once as OpenCode's plugin manager installs the package. The setup runs start
without usable settings and set AZPR up through its dialogs; with `--migrate`
they start from settings of AZPR 0.4.x and confirm their update instead.

The fixtures need `openssl` and use isolated configuration, a fake model
provider and fake Azure services. They do not need your PAT or provider account,
consume paid model quota, or post real comments. Their records stay under the
ignored `.local/` directory. Passing them establishes host integration, not
real-model review quality or live Azure acceptance.

Installer changes must preserve unrelated files and private settings, reject
conflicts, and cover rollback and archival uninstall. Keep the README's
manual-copy file list accurate. Never replace your personal configuration or
run live models or Azure publication as an incidental test; use a designated
test environment with explicit permission for those actions.

## Open a pull request

Keep the change focused. Explain the problem, resulting behavior and checks
run; name anything you could not verify. A short title such as
`fix: preserve comment recovery after restart` is useful, but no special commit
format is required. Do not include generated private records or credentials.

For host compatibility or live acceptance evidence, record exact versions,
environment and limitations in [current validation](docs/VALIDATION.md), and
preserve superseded results in [validation history](docs/VALIDATION_HISTORY.md).
Keep fake-service and live results distinct. Documentation-only changes need
link and example checks; they do not require live reviews or publication.
