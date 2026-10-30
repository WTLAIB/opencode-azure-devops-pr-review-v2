# Changelog

## 0.3.3 — 2026-10-31

- AZPR is tested with OpenCode 2.2.4 instead of 2.1.4. The runtime needed no
  change: on both hosts the same review sends byte-identical model requests.
  Upgrading OpenCode migrates its database irreversibly; stop the service and
  back up `opencode.db` first.
- `/pr-check` names the OpenCode version in a row of its own and warns when it
  is not the tested one; reviews still run. Receipts no longer end with a
  host notice.
- A used-up usage or spend limit stops the stage at once: AZPR refuses
  OpenCode's retries and starts no new session, and the receipt names the
  limit. This covers OpenCode 2.2.3's ChatGPT and OpenCode Go usage limits and
  OpenCode's spend limits besides the provider quota and the free-model limit;
  before, a used-up ChatGPT limit was retried as a rate limit.
- AZPR subscribes only to the session events that show a review progressing;
  OpenCode 2.2.0 and later deliver no others.
- On OpenCode 2.2.4, `NO_PROXY` always lists `127.0.0.1`, `localhost` and
  `::1`, and Bun honours `NO_PROXY` even for `azure.proxy`. Azure DevOps is
  unaffected; the company-network guide now says to keep `dev.azure.com` out of
  `NO_PROXY` when it must use the proxy. Test-only Azure DevOps base URLs may
  use any 127.0.0.0/8 address, so the proxy scenario can still be tested.
- The host smoke test adds a foreign MCP server behind CodeMode and an image
  model, and checks that private reviewers see neither those tools nor image
  generation while ordinary sessions keep them.

## 0.3.2 — 2026-10-30

- The README starts with actual Azure DevOps output: an inline comment with its
  code context and, in an expandable section, the complete PR summary from the
  same review. The first-review steps come before the 15-second recording, and
  a documentation table points to the guide for each task. The demo records how
  the screenshots were captured and edited, and lists the pictured comment
  bodies as text.
- Receipts say that COMPLETE means no source-commit change was detected. A
  final version recheck that fails adds a warning and leaves the review
  COMPLETE; publication still rechecks the PR before posting.
- The npm package contains only the runtime, README, changelog and license:
  32 files and about 170 KB instead of 76 files and 1.35 MB. Documentation,
  media, installers, the settings example and schema and the repository guides
  remain in the repository and the source archive; npmjs.com shows the
  README's links and images from GitHub.
- The README and architecture guide list the commands that answer without a
  background run, the README and commenting guide state that repeating the
  saved adjustments plans nothing, and the architecture guide counts AZPR's
  six tools.

## 0.3.1 — 2026-10-27

- Installation and upgrades are documented as they behave on OpenCode 2.1.4:
  `opencode plugin add` loads the plugin into a running service without a
  restart, and adding a second version leaves the first one running. The
  README's new Upgrading section adds the new version and removes the
  previous one only when the download succeeded. Saved settings still need a
  restart, and every message that asks for one names `opencode service restart`.
- `/pr-check` names the installation that answered and warns when another
  AZPR entry is configured but not running, such as a second version that
  OpenCode lists as a duplicate plugin ID. User names, passwords and query
  strings in package specifications are masked.
- `/pr-setup` takes the organization from a PR or organization URL and,
  without `--pat-file`, uses `${XDG_CONFIG_HOME:-~/.config}/azpr/pat` (or, with
  `--replace`, the PAT file already set); its receipt names both.
- The quickstart runs the terminal steps first and needs one restart. The team
  guide separates package downloads, model providers and Azure DevOps on
  company networks, and the Azure DevOps guide names the actual settings
  locations. Two links in the validation history now point at the version
  that still had their sections.

## 0.3.0 — 2026-10-26

- Choose what reaches the PR after reading a preview:
  `/pr-comment <review-id> --exclude F-1,F-2` leaves findings out, and
  `--severity F-3=low` changes their publication severity. Each option replaces
  its own saved list (`none` clears it); `--reset` clears both. The model plans
  a new preview without rerunning the review, and the original findings and
  report stay unchanged. A severity change does not verify a finding again.
- `/pr-comment [review-id] --show` displays the saved preview without calling
  a model or Azure DevOps. Excluding every finding plans and posts nothing.
- Adjustments and the invalidation of the earlier preview are saved together.
  A failed save reports failure and changes nothing; a new preview whose save
  fails is dropped. A review adjusted once, including one reset since, can be
  published only from a saved preview planned after its latest adjustment.
  Once publication starts, adjustments and re-planning are refused.
- The final preview is checked for excluded finding IDs, including summary
  rows rendered from retained findings. An unresolved reference holds
  publication. Existing PR comments are never edited; for an adjusted review,
  the receipt names those whose text differs from the new preview, including
  comments that appear only when AZPR reads the threads back.
- The README leads with control over published comments and a real OpenCode
  2.1.4 recording of adjusting findings and publishing; the first-review
  example and quickstart cover adjustments, the new preview and publication.
  The npm package, Git installation and source archive advance to 0.3.0. The
  package description mentions adjusting previews, and the npm package now
  includes the code of conduct that its README and contributing guide link to.
- CI actions are pinned by commit and updated with Dependabot. Validation
  starts with a summary and records the known limits of the review evidence.

## 0.2.3 — 2026-10-24

- The tested host is OpenCode CLI 2.1.4. OpenCode 2.1.3 and later embed Bun
  1.4.4, which reports a proxy that refuses the CONNECT tunnel as an
  `ERR_PROXY_TUNNEL` error instead of returning the proxy's answer. AZPR maps
  it to the earlier messages and retry rules: a missing proxy password is again
  explained as HTTP 407 without retries, and a refused tunnel never leaves a
  comment write uncertain.
- Azure DevOps calls keep the configured `azure.callTimeoutSeconds`. The
  runtime's fetch gave up on a silent request after about six minutes by
  itself, so a longer setting ended early with a retried network error.
- With OpenCode's opt-in `experimental.background_compaction`, a refused
  background summary no longer turns a later failure into a context-overflow
  split. A permanent error such as HTTP 401 stops the stage without new
  sessions, and a failed follow-up keeps the answer it followed.
- The README states that AZPR is an independent community project, not built
  by or affiliated with the OpenCode team.
- A fifth exact-host fixture covers background compaction followed by a
  permanent failure; CI runs it.

## 0.2.2 — 2026-10-23

- The README leads with reviewing Azure DevOps PRs from a URL without a local
  checkout, then explains source lookup, model choices, verification, comment
  control and corporate connection settings with their limits.
- The README and quickstart use the same first-review workflow:
  `/pr-review <PR URL> --preview`. Quick review remains an explicit lighter
  alternative, with model-request and cost guidance.
- Compatibility explicitly excludes OpenCode 1.x without implying a separate
  maintained AZPR product line. Detailed references remain folded with visible
  navigation targets, and the archive-limit link points to the relevant guide.
- The Azure Code Search description correctly distinguishes indexed branches
  from AZPR's searches at a selected commit.
- The npm package description reflects the URL-based workflow, and the
  `opencode-v2` keyword identifies its plugin API target.
- No runtime, prompt, settings or installation behavior change.

## 0.2.1 — 2026-10-23

- AZPR is published to the npm registry as `opencode-azure-devops-pr-review`:
  `opencode plugin add opencode-azure-devops-pr-review@0.2.1`. The versioned
  Git package and the source archive remain available with the same runtime,
  and npm and Git installations read the same external settings.
- The README shows CI, npm, license and tested-host badges. Installation and
  upgrade instructions cover the npm package, the Git package and moving from
  Git to npm.
- `tests/host-v2-smoke.mjs --native --package SPEC` runs the native fixture
  against a published package after a release.
- The repository adopts the Contributor Covenant 2.1 as its code of conduct,
  with an address for reports.
- No runtime, prompt or settings change.

## 0.2.0 — 2026-10-23

- `afterReview` sets, per mode (`quick`, `review`, `deep`), what follows a
  COMPLETE review: `none` (default, as before), `preview` or `publish`. The
  step runs as a separate comment command with its own run ID, `STARTED`
  notice and receipt, and `/pr-stop` stops it. A review without findings to
  comment on gets one notice and no planning or model request; a busy
  conversation or PR skips the step and names the command to run; a review
  stopped while its report is delivered stays COMPLETE but starts no step.
- One flag right after the PR URL of `/pr-review`, `/pr-deep` or `/pr-quick`
  (`--preview`, `--publish` or `--no-comment`) overrides `afterReview` for that
  run. Other option-like text there is refused, so a mistyped flag never falls
  back to the setting; `/pr-check` takes no flag.
- Automatic publication posts item by item. A comment whose text has an
  `@<…>` mention, an image, HTML that embeds content, runs a script or hides
  text (attributes read as a browser reads a tag), or a
  `javascript:`, `vbscript:`, `data:` or `file://` link (mentions and script
  links also when written with escapes or character references, script links
  also with a tab or line break inside) waits in the
  saved preview for a person, and the receipt names it; the other items are
  posted. Ordinary links, markup in examples and literal code (fenced code
  blocks and code spans, where the Markdown can be read only one way) are
  posted; mentions are checked in code too. A quick
  review's comments are posted with their "not independently verified"
  disclosure, also a high-severity finding or incomplete coverage (named in
  the summary); the verification hint is advisory. When every finding is
  already discussed on the PR, nothing new is posted (`NOTHING_TO_POST`), so
  re-reviewing an unchanged PR does not add a summary each time.
- The automatic-publication HTML checks read long tag-like text in linear
  time, avoiding repeated scans that could delay the plugin on large comments.
- `/pr-check` shows the `afterReview` of each mode and, for modes that publish
  automatically, who posts.
- `/pr-setup` and the blocked review commands name the settings problem found
  at load, without any setting value; an unknown settings key is named only
  when it looks like a setting name.

## 0.1.0 — 2026-10-22

First public release.

- Azure DevOps Services PR reviews in OpenCode V2, using repository content at
  exact commits and runtime-owned REST access.
- Quick reviews with one reviewer per shard, and review/deep modes with
  functional and risk reviewers followed by independent verification. Deep runs
  the same review with the stronger models of `models.deep`; `/pr-check` says
  when they are unset or repeat the review models.
- Bounded shards, context-overflow splitting, correction turns, transient
  retries (never for a used-up provider quota or free-model limit),
  cancellation and visible coverage gaps.
- Comment previews, explicit publication, stable duplicate markers and
  read-back of posted comments. Quick comments disclose that they were not
  independently verified. A comment someone deletes on the PR is reported as
  `DELETED` and not posted again.
- Two comment-planning pages at a time, with deterministic page-order assembly.
- Persistent private reports and publication records, plus Azure proxy and
  additional CA configuration.
- The PAT can live alone in an owner-only file (`azure.patFile`), so
  `settings.json` holds no secret; Code (Read) and Pull Request Threads
  (Read & write) are confirmed to cover every call AZPR makes.
- Native installation through OpenCode's Git package manager, with configuration
  outside the package cache and an explicit `options.settingsFile` override.
- `/pr-setup` validates one model and an existing PAT file and saves owner-only
  settings without a model or Azure request. Existing source installations and
  advanced settings remain supported.
- A first-review quickstart, real recorded demonstration, compatibility table,
  team data-handling guide, contribution guide and private vulnerability reporting.

The tested target is OpenCode CLI 2.1.2 on Ubuntu 22.04, with Azure DevOps
Services REST API 7.1. See [validation](docs/VALIDATION.md) for the distinction
between offline tests, host fixtures and live runs, including remaining gaps.
