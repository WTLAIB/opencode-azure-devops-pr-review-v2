# Changelog

## Unreleased

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
