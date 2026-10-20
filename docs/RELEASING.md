# Release preparation

AZPR is distributed as source with `install.sh`. The root `package.json` is
private deliberately; these instructions do not publish an npm package.

The initial version is **0.1.0**, matching `package.json`. Its release notes
are prepared in [releases/v0.1.0.md](releases/v0.1.0.md); they remain a draft
until a reviewed commit is tagged and published.

## Prepare the release commit

1. Review and merge the onboarding changes, including the selected license.
   Keep `.local/`, credentials, diagnostics and personal model IDs out of Git.
2. Run `npm run check` and `npm test`. Follow `AGENTS.md` for the real-host
   fixture checks when hooks, sessions, tools, Azure access or publication changes.
   Keep fake-service results separate from live Azure/model evidence.
3. Replace the quickstart's initial pinned source commit with the final release
   commit or tag as part of release preparation. Check that its archive really
   contains the documented files. Verify README images and guide links from
   the release tree.
4. Move the changelog's pending section to `0.1.0` with the actual release date,
   and remove the draft paragraph from the release notes when publishing.

The current quickstart uses the implementation commit `3bee7ef`, the first
whose runtime supports everything the quickstart configures (`azure.patFile`
and the deep-model rows of `/pr-check`), so its download works before the first
release exists. It does not pretend that
an unpublished version tag is downloadable.

## Publish when authorized

Create tag `v0.1.0` at the approved release commit, then create a GitHub Release
for that tag using the prepared notes. GitHub's source archives provide the
installer, configuration example, runtime modules and prompts together. Check
an extracted archive with the installer in a disposable configuration directory
before directing users to it.

Do not create a public release at the implementation base commit while its
license and onboarding changes are still only on an unmerged branch. A release
must point to the tree that was reviewed for distribution.

After publication, link to the release from the README and verify the download
and install instructions from a clean directory. Keep the tag fixed; fixes
belong in a new version.

## Repository discoverability

Suggested GitHub About description:

> Azure DevOps PR reviews in OpenCode V2 with quick and verified modes,
> comment previews, and explicit publishing.

Topics: `opencode`, `opencode-plugin`, `azure-devops`, `code-review`,
`pull-request`.

The same repository URL, issue tracker and keywords are recorded in
`package.json`. Once the release is available, the README and demo are ready
to accompany a submission to OpenCode's ecosystem directory.
