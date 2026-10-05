# Verification in the current project

The two initial reviewers and verifier can use OpenCode's shell, read, glob and
grep tools in the project where `/pr-review` or `/pr-deep` was invoked. Child
sessions inherit the origin's location and session permissions. Open the desired
working directory in OpenCode; it need not contain the PR or a Git repository.
MCP supplies remote PR metadata, changed paths and exact-commit content. Review
does not clone/fetch or reconstruct history, and needs no per-repository settings.

Models choose the method: existing tests, a focused reproduction, counterexamples,
static analysis or source inspection. Execution is optional. Failed tests, missing
dependencies and unavailable execution are useful observations, not another gate
on a source-supported review or its comment preview. There are still only two
initial reviewers and one verifier.

## Permissions and effects

The plugin adds no shell/read/search permission override for reviewers or comment roles.
OpenCode's applicable global, project, private-role and inherited session rules
decide allow, ask or deny. Rules configured only for another agent such as Build
are not copied. An ask decision requires normal host approval; a denial must not
be bypassed. See the pinned host's [permission evaluation](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/permission.ts#L144).
Standalone readiness retains native shell/search denials. Comment stages may use
local tools for evidence inspection and coordinate calculations; remote PR access
and publication still use MCP. Publication keeps its saved-plan authorization and
stops on observed tool errors, including failures during local verification.

Commands execute in the real project with host authority. This is not a filesystem,
process or network sandbox: permitted tests may create files, run package scripts
or reach external services. Reviewers must preserve existing work, use temporary
files for reproductions and account for two initial reviewers sharing a directory.
Each experiment should use its own fresh temporary directory, preserving other
reviewers' files and existing user work.
Review does not authorize source fixes, repository resets, commits, pushes or PR
writes. Native edit/write/patch tools remain denied. Those tool denials do not
prevent an approved shell command from writing files.

`/pr-stop`, run timeout and disposal revoke plugin grants and ask OpenCode to
interrupt and wait for sessions. They do not roll back command side effects or
promise termination of detached background services. Unconfirmed session cleanup
remains visible and prevents a usable COMPLETE cache.

## Evidence

Without a checkout, reviewers may materialize only the needed MCP-returned files
in temporary directories, preserving their content and separating base from head.
Record each source's repository, path and selected commit. Distinguish running
exact retrieved code from a reduced or modified reproduction. Missing imports,
fixtures or dependencies constrain the experiment; a subset does not establish
that the full project builds or passes its suite. Source inspection remains useful.

If an existing checkout is used, establish its repository, commit and working-tree
changes first. A different checkout is context, not proof about the PR's exact
head. No checkout/reset/clean is performed automatically. Azure PR identity,
changed-path discovery and the final version check still use server evidence.

Describe the command, relevant output, exit status and limitations in the existing
finding evidence/report fields. No new output fields or test quota are required.
A successful process exit alone is not proof of correctness or test coverage.
Another reviewer's test result must be attributed, not presented as an independent
execution. Original native tool output remains in the OpenCode session; debug
stage records count tool outcomes but are not a separate execution ledger.

## Updating an older installation

The former `verification` and `shellToolPermission` settings are removed. Back up
private settings and remove those keys before an explicitly authorized replacement
installation. The installer rejects them instead of silently changing execution
policy. Existing private root filesystems, backups and historical verification
records are not removed by this source change. OpenCode must load the updated
installation before this behavior becomes active.
