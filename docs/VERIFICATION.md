# Local verification and shell access

Private reviewers read the remote PR through AZPR's REST-backed tools. The current OpenCode project
does not need a checkout or Git history, and reviews never clone or fetch.

## The `shell` setting

| Value | Behavior |
| --- | --- |
| `deny` (default) | Shell is removed from private reviewers' tool lists and refused if called, regardless of later host rules (enforced through the `permission` hook). Reviewers still read, glob and grep the current project. |
| `ask` | Shell is offered; every command needs your approval in OpenCode. A background review waits while an approval is pending. |
| `inherit` | Host permission rules decide, as for any agent. |

The default protects you from prompt injection: reviewers read untrusted PR
content, and an injected instruction must not be able to run commands on your
machine.

When shell is allowed, reviewers may run focused checks — existing tests, a
small reproduction, static analysis — in a fresh temporary directory with files
copied from AZPR tool reads at the exact commit. Commands run with real host
authority; this is not a filesystem, process or network sandbox. Native edit,
write and patch tools stay denied, but those denials do not stop an approved
shell command from writing files.

Execution is optional. Failed tests, missing dependencies or unavailable
execution are observations in the report, not a gate on a source-supported
finding.

## Cancellation

`/pr-stop`, a configured `runTimeoutSeconds` and plugin unload revoke grants and
ask OpenCode to interrupt and settle the sessions. They do not roll back command
side effects or terminate detached background processes.
