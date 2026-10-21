# Releasing AZPR

AZPR is distributed as a native Git package and a source archive. The root
`package.json` remains private because this process does not publish to npm.
Both installation methods use the same runtime and tagged source tree.

## Prepare a release

1. Set the version in `package.json`, add a dated changelog section, and write
   `docs/releases/vVERSION.md`. Update the quickstart, README install commands
   and download links to that version.
2. Run `npm run check` and `npm test`. Follow `AGENTS.md` for required host
   checks. Release validation includes fresh and replacement source installs,
   `host-v2-smoke.mjs --native`, and `host-v2-comment-scale.mjs` on the exact
   documented host. Keep simulated services and live model/Azure results distinct.
3. Inspect `npm pack --dry-run --json`: the entry, runtime modules, prompts,
   configuration example and license must be present; private settings, `.local/`,
   credentials, diagnostics and temporary recordings must be absent. The native
   fixture installs a packed Git repository through the real plugin manager and
   tests setup plus both default and explicitly selected external settings.
4. Review the complete diff and release notes, then commit and push the release
   branch. Verify GitHub Actions for that exact commit. In a disposable OpenCode
   profile, install `github:WTLAIB/opencode-azure-devops-pr-review-v2#COMMIT` to
   verify public Git resolution before creating the tag.
5. Extract a Git archive of the release candidate into a clean directory. Run
   its source installer with disposable settings; verify the installed entry,
   license, prompts and settings preservation. Check documentation links and
   images against that archive, not a working tree with extra files.

Do not upgrade the personal host, use private credentials, run paid models or
publish test comments as incidental release checks. Those actions need their own
authorization and a designated test environment. Never distribute `.local/`.

## Publish the tested tree

Merge the reviewed release changes and verify the merged tree matches the
validated candidate. Create an annotated `vVERSION` tag at that commit, push it,
and create a GitHub Release using `docs/releases/vVERSION.md`.

Attach the prepared demonstration video and any release artifacts with a
checksum manifest. Keep raw terminal captures private: they can contain account
or local path information. Public media must be inspected before uploading.
GitHub also supplies source archives for the tag.

Then verify the actual published installation:

```sh
opencode plugin add 'github:WTLAIB/opencode-azure-devops-pr-review-v2#vVERSION'
```

Use a disposable config/data profile for that check. Download the public source
archive and repeat its installation check. Verify the Release, archive and media
links resolve. Keep published tags fixed; corrections belong in a new version.

## Demonstrations and evidence

Record the AZPR source commit, OpenCode version, model, test fixture and observed
results. A seeded test PR demonstrates the workflow, not general review accuracy.
Use [the recording guide](assets/RECORDING.md) for real terminal captures, and
[validation](VALIDATION.md) for the distinction between offline tests, host
fixtures and live runs. A shorter edit must label accelerated or removed waits.

## Repository discoverability

Keep the GitHub About description, topics and `package.json` metadata aligned.
The README should link the current release, quickstart, real demo, contribution
guide and private vulnerability reporting. Once those paths work, submit a
focused documentation PR to OpenCode's ecosystem directory using its required
PR template. A directory listing is not a compatibility certification.
