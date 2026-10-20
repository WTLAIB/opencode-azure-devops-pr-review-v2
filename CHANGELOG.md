# Changelog

## Unreleased — preparing 0.1.0

The first tagged release is being prepared. This section describes the current
implementation, not an already published release.

- Azure DevOps Services PR reviews in OpenCode V2, using repository content at
  exact commits and runtime-owned REST access.
- Quick reviews with one reviewer per shard, and review/deep modes with
  functional and risk reviewers followed by independent verification. Deep runs
  the same review with the stronger models of `models.deep`; `/pr-check` says
  when they are unset or repeat the review models.
- Bounded shards, context-overflow splitting, correction turns, transient
  retries, cancellation and visible coverage gaps.
- Comment previews, explicit publication, stable duplicate markers and
  read-back of posted comments. Quick comments disclose that they were not
  independently verified.
- Two comment-planning pages at a time, with deterministic page-order assembly.
- Persistent private reports and publication records, plus Azure proxy and
  additional CA configuration.
- The PAT can live alone in an owner-only file (`azure.patFile`), so
  `settings.json` holds no secret; Code (Read) and Pull Request Threads
  (Read & write) are confirmed to cover every call AZPR makes.
- A first-review quickstart, illustrated demo, compatibility table and team
  data-handling guide.

The tested target is OpenCode CLI 2.0.32 on Ubuntu 22.04, with Azure DevOps
Services REST API 7.1. See [validation](docs/VALIDATION.md) for the distinction
between offline tests, host fixtures and live runs, including remaining gaps.
