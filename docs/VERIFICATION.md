# Optional isolated verification

`azpr_verify` lets the two existing initial reviewers and verifier choose how to
check their reasoning. They can run tests, construct counterexamples, inspect code
with local tools, or write temporary reproductions. There is no command allowlist,
additional reviewer, mandatory test quota or new review-output field.

The native OpenCode shell and CodeMode execute remain blocked. They execute in the
host environment and do not provide this boundary. Missing dependencies, failing
tests, timeouts and unavailable isolation are useful limitations to report, not
automatic reasons to discard a review or deny preview after a valid COMPLETE.

## Operator setup

The feature is disabled by default. It needs Linux x86_64, Python 3, Git, util-linux
`unshare`, enabled unprivileged user namespaces and seccomp. The plugin does not
install software, fetch repositories, download dependencies or edit host settings.
No sudo or npm package installation is used by the runner.

Prepare a **dedicated, trusted, credential-free root filesystem** outside the PR
checkout, containing `/bin/sh` and your chosen compilers, runtimes, dependencies
and libraries. For example, use an offline rootfs exported from your organization's
approved Ubuntu 22.04 test image. The operator owns preparation and image updates;
PR content must not select or build this image. Keep its version and dependency
inventory with your local configuration. Do not copy a personal home, provider
configuration, PAT, SSH agent, host `/proc` or host `/dev` into it. It must have real
directories `/proc`, `/dev`, `/tmp`, `/source`, `/workspace` and `/home`; symlink
mountpoints and any sockets, devices or FIFOs are rejected. Keep the prepared tree
unchanged while reviews are running. The runner does not certify its contents.

Supply a trusted local Git repository that already contains the reviewed source
and target commit objects. It can be a normal checkout or a bare mirror. Update it
yourself through your usual authorized workflow; the runner never fetches. Its
working copy, untracked files, Git configuration and credentials are not exposed
to model commands. A new remote-free Git object reader avoids hooks, filters,
replacement refs and archive export attributes when materializing source.

Add this to the plugin's private `settings.json`, using your actual paths and the
same canonical repository URL used by the review command, then restart OpenCode:

```json
{
  "verification": {
    "enabled": true,
    "rootfs": "/srv/azpr/rootfs/approved-test-image",
    "repositories": [
      {
        "url": "https://dev.azure.com/example/project/_git/repository",
        "path": "/srv/azpr/mirrors/repository.git"
      }
    ],
    "timeoutSeconds": 120,
    "memoryMiB": 4096,
    "processes": 128,
    "storageMiB": 512
  }
}
```

The URL mapping is an operator authorization, not a claim that a local remote or
commit is Azure's current PR head. Each reviewer establishes the source/target
SHAs from PR metadata. Results identify the actual local commit. The final review
still performs its existing identity/version checks. A missing local object,
submodule, unsupported path encoding or unavailable boundary returns UNAVAILABLE;
there is no partial-tree execution or fallback to the host shell.

## Execution boundary and records

Each invocation accepts only `commit` and `command`. The model cannot supply host
paths, environment variables, mounts, network grants or alternate images. Commands
start in `/workspace`, a fresh writable copy of the requested commit. `/source`
contains the same immutable source. Tests can mutate their disposable copy and
run local loopback or UNIX-socket services. Changes do not carry into later calls.
To generate fixtures and then execute tests, use one shell script/command.

The helper creates user, mount, PID, IPC, network and UTS namespaces, a read-only
rootfs and bounded writable tmpfs. It exposes only four basic devices and its own
PID namespace's `/proc`. The environment contains only PATH, HOME, TMPDIR and locale.
There are no host working-tree/configuration mounts or inherited credential/proxy
variables. The network namespace has only loopback; it cannot reach Azure, package
registries or services listening on the host. Socket families outside UNIX/IPv4/IPv6
are denied, including VSOCK. Capabilities are dropped and cannot be regained across
exec. `no_new_privs` and a syscall filter deny namespace changes, host keyrings,
supervisor tracing and related escape surfaces. The supervisor's file descriptors
and root are inaccessible to commands. These controls constrain the environment,
not the model's choice of verification method.

Command output and the trusted supervisor result use separate channels. Every
result includes the selected repository/commit, command, time, environment and
limits, exit code or terminating signal, and captured output. A nonzero exit is a
completed command, not a tool transport failure. Initial records reach the verifier;
private debug mode retains each result, and the report includes a short execution
ledger. A zero exit code alone establishes neither correctness nor test coverage.
The workspace is mutable: models must disclose modifications and distinguish an
executed reproduction from predictions about untouched source.

`/pr-stop`, the configured review timeout, host tool cancellation and plugin unload
revoke execution. The namespace init process owns descendants, including detached
processes; its exit terminates them. Temporary host data is removed only after
confirmed process settlement. Unconfirmed settlement retains private temporary
data, stops the run and prevents COMPLETE/comment-cache eligibility. Failed temporary
directory removal is disclosed separately from process settlement.

## Resource semantics and current limits

| Setting/boundary | Meaning |
| --- | --- |
| `timeoutSeconds` | Configurable lifetime per invocation, including preparation. Defaults to 120 seconds; teardown adds a bounded settlement wait. It is separate from `runTimeoutSeconds:null` and imposes no review iteration limit. |
| `memoryMiB` | Per-process virtual address-space limit, including trusted preparation. Defaults to 4096 MiB. It is **not an aggregate RAM/cgroup quota**. |
| `processes` | RLIMIT_NPROC threshold, default 128. Linux accounts real-user processes/threads, so existing host usage can reduce headroom. |
| `storageMiB` | Shared tmpfs capacity for both source copies and all writable data, default 512 MiB. Also bounds individual files and the private preparation archive. Source blobs plus archive overhead must fit one third of this allowance. |
| Output | First 1 MiB of combined command stdout/stderr, with total byte count and an explicit truncation flag. This transport bound does not limit review-stage content or model requests. |
| File descriptors/core dumps | Per-command 256 descriptors; no inherited helper descriptors or core dumps. |

This is a Linux shared-kernel boundary, not a VM or an aggregate resource scheduler.
It does not certify kernel security or protect host availability with cgroup CPU/RAM
quotas; concurrent processes and verification calls share host resources. Use a
dedicated disposable worker/VM when that stronger containment is required. No
networked installs, credentialed integration services, submodule expansion, nested
containers or non-x86_64 syscall compatibility are provided. Missing capability is
an honest review limitation, not permission to bypass the boundary.

The controls follow Linux's documented [seccomp filter semantics](https://docs.kernel.org/userspace-api/seccomp_filter.html),
[network namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)
and [resource-limit semantics](https://man7.org/linux/man-pages/man2/getrlimit.2.html).
Offline fixtures and exact-host acceptance are described in [validation](VALIDATION.md).
