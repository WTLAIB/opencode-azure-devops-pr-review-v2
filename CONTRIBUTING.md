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
acceptance target is OpenCode V2 `@opencode/cli@2.2.4` on Ubuntu 22.04; other
environments are not yet validated. The runtime has no npm dependencies or
build step. From your checkout:

```sh
npm run check
npm test
```

Read [AGENTS.md](AGENTS.md) for the design rules and change-specific checks.
Keep deterministic PR facts and Azure writes in the runtime; models supply
review judgment and comment text. Preserve the distinction between quick
findings and independently verified findings. Add a focused regression test
when fixing behavior, and update the relevant documentation when it changes.

Changes to hooks, sessions, tools, Azure access or publication also need all
five host fixture runs. Install the tested host into a disposable local directory
without changing your everyday OpenCode installation:

```sh
npm install --prefix "$PWD/.local/contributor-host" --no-audit --no-fund @opencode/cli@2.2.4
AZPR_TEST_HOST="$PWD/.local/contributor-host/node_modules/.bin/opencode"
node tests/host-v2-smoke.mjs "$AZPR_TEST_HOST"
node tests/host-v2-smoke.mjs "$AZPR_TEST_HOST" --replace
node tests/host-v2-smoke.mjs "$AZPR_TEST_HOST" --native
node tests/host-v2-comment-scale.mjs "$AZPR_TEST_HOST"
node tests/host-v2-background-compaction.mjs "$AZPR_TEST_HOST"
```

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
