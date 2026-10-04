"""Trusted Linux namespace launcher. Project code executes only after isolation.

No shell commands, repository hooks, filters or network fetches run during source
preparation. Python's standard library and Ubuntu util-linux/Git are sufficient.
The operator supplies a trusted, credential-free rootfs with /bin/sh and tools.
"""
import ctypes
import hashlib
import io
import json
import os
import platform
import resource
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tarfile

MIB = 1024 * 1024
libc = ctypes.CDLL(None, use_errno=True)


class Unavailable(Exception):
    """Only static, non-secret diagnostics may cross the supervisor channel."""



def checked(result):
    if result == -1:
        raise OSError(ctypes.get_errno(), "Isolation operation failed")
    return result


def mount(source, target, kind=None, flags=0, data=None):
    def encoded(value):
        return None if value is None else os.fsencode(value)
    checked(libc.mount(encoded(source), encoded(target), encoded(kind), ctypes.c_ulong(flags), encoded(data)))


def prctl(option, value=0):
    checked(libc.prctl(option, ctypes.c_ulong(value), 0, 0, 0))


def send(value):
    os.write(3, json.dumps(value, separators=(",", ":")).encode())


def git(args, **kwargs):
    return subprocess.run(["/usr/bin/git", *args], check=True, stderr=subprocess.DEVNULL, **kwargs)


def prepare(config, directory):
    """Read objects using a new, remote-free Git database, not repository config."""
    repo = config["repositoryPath"]
    objects = git(["-C", repo, "rev-parse", "--path-format=absolute", "--git-path", "objects"], stdout=subprocess.PIPE).stdout.decode().strip()
    bare = os.path.join(directory, "objects-reader")
    git(["init", "--bare", "--quiet", "--template=", "--object-format=" + ("sha256" if len(config["commit"]) == 64 else "sha1"), bare], stdout=subprocess.DEVNULL)
    env = dict(os.environ, GIT_OBJECT_DIRECTORY=objects, GIT_NO_REPLACE_OBJECTS="1")
    prefix = ["--git-dir=" + bare]
    sha = config["commit"]
    actual = git(prefix + ["rev-parse", "--verify", sha + "^{commit}"], env=env, stdout=subprocess.PIPE).stdout.decode().strip()
    if actual != sha:
        raise Unavailable("Requested object is not that commit")
    tree = git(prefix + ["ls-tree", "-rz", "--full-tree", sha], env=env, stdout=subprocess.PIPE).stdout
    limit = config["storageMiB"] * MIB // 3
    if len(tree) > limit:
        raise Unavailable("Source exceeds disposable storage allowance")
    archive = os.path.join(directory, "source.tar")
    size = 0
    count = 0
    batch = subprocess.Popen(["/usr/bin/git", *prefix, "cat-file", "--batch"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        with tarfile.open(archive, "w") as target:
            for item in tree.split(b"\0"):
                if not item:
                    continue
                info, path = item.split(b"\t", 1)
                mode, kind, oid = info.split(b" ")
                name = path.decode("utf-8", errors="strict")
                if kind != b"blob" or mode not in (b"100644", b"100755", b"120000"):
                    raise Unavailable("Submodules require a separately prepared source environment")
                if name.startswith("/") or any(p in ("", ".", "..", ".git") for p in name.split("/")):
                    raise Unavailable("Unsafe tree path")
                batch.stdin.write(oid + b"\n")
                batch.stdin.flush()
                header = batch.stdout.readline().split()
                if len(header) != 3 or header[0] != oid or header[1] != b"blob":
                    raise Unavailable("Missing source object; network fetch is prohibited")
                length = int(header[2])
                size += length + 1024
                if size > limit:
                    raise Unavailable("Source exceeds disposable storage allowance")
                content = batch.stdout.read(length)
                if len(content) != length or batch.stdout.read(1) != b"\n":
                    raise Unavailable("Incomplete source object")
                digest = hashlib.sha1 if len(oid) == 40 else hashlib.sha256
                if digest(b"blob " + str(length).encode() + b"\0" + content).hexdigest().encode() != oid:
                    raise Unavailable("Source blob hash mismatch")
                member = tarfile.TarInfo(name)
                member.mode = 0o755 if mode == b"100755" else 0o644
                if mode == b"120000":
                    member.type = tarfile.SYMTYPE
                    member.linkname = content.decode("utf-8", errors="strict")
                    target.addfile(member)
                else:
                    member.size = length
                    target.addfile(member, io.BytesIO(content))
                count += 1
    finally:
        batch.stdin.close()
        batch.stdout.close()
        if batch.poll() is None:
            batch.terminate()
        batch.wait()
    return archive, {"commit": sha, "files": count, "bytes": size, "materialization": "Git blobs; no checkout filters, hooks, export-ignore or export-subst; no submodule expansion"}


def drop_privileges():
    # No new privileges, no uid-0 capability restoration across exec, no ambient
    # or bounding capabilities. The command cannot remount, ptrace init, or escape.
    prctl(38, 1)  # PR_SET_NO_NEW_PRIVS
    prctl(28, 3)  # PR_SET_SECUREBITS: NOROOT | NOROOT_LOCKED
    for capability in range(64):
        result = libc.prctl(24, capability, 0, 0, 0)  # PR_CAPBSET_DROP
        if result == -1 and ctypes.get_errno() != 22:
            checked(result)
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]
    checked(libc.capset(ctypes.byref(Header(0x20080522, 0)), (Data * 2)()))


def syscall_boundary():
    # A small deny policy protects host keyrings and namespace/supervisor state.
    # This is not a catalog of model commands or verification techniques.
    if platform.machine() != "x86_64":
        raise Unavailable("This audited syscall boundary requires Linux x86_64")
    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]
    class Program(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]
    deny = 0x50000 | 1  # SECCOMP_RET_ERRNO | EPERM
    instructions = [(0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000),
                    (0x20, 0, 0, 0), (0x35, 0, 1, 0x40000000), (0x06, 0, 0, deny)]
    for number in (101, 155, 161, 165, 166, 248, 249, 250, 272, 298, 303, 304, 308, 310, 311, 321, 323, 425, 426, 427, 428, 429, 430, 431, 432, 433, 438):
        instructions.extend([(0x15, 0, 1, number), (0x06, 0, 0, deny)])
    # clone3 is opaque to classic BPF. ENOSYS permits libc's ordinary clone
    # fallback; clone's namespace flags are denied, threads/processes are allowed.
    instructions.extend([(0x15, 0, 1, 435), (0x06, 0, 0, 0x50000 | 38),
                         (0x15, 0, 4, 56), (0x20, 0, 0, 16),
                         (0x45, 0, 1, 0x7E020000), (0x06, 0, 0, deny), (0x06, 0, 0, 0x7FFF0000)])
    # VSOCK and other non-IP socket families may escape a network namespace.
    # Allow ordinary local/IP testing only, including UNIX-domain socket pairs.
    for number in (41, 53):
        instructions.extend([(0x15, 0, 6, number), (0x20, 0, 0, 16),
                             (0x15, 3, 0, 1), (0x15, 2, 0, 2), (0x15, 1, 0, 10),
                             (0x06, 0, 0, deny), (0x06, 0, 0, 0x7FFF0000)])
    instructions.append((0x06, 0, 0, 0x7FFF0000))
    filters = (Filter * len(instructions))(*(Filter(*row) for row in instructions))
    checked(libc.prctl(22, 2, ctypes.byref(Program(len(instructions), filters)), 0, 0))


def extract(archive, destination):
    # Only our regular-file/symlink archive, after chroot. Create symlinks last;
    # extraction must never follow a repository symlink while creating parents.
    with tarfile.open(fileobj=archive, mode="r:") as source:
        links = []
        for member in source:
            path = os.path.join(destination, member.name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if member.issym():
                links.append((member.linkname, path))
            else:
                with open(path, "xb") as target:
                    shutil.copyfileobj(source.extractfile(member), target)
                os.chmod(path, member.mode)
        for target, path in links:
            os.symlink(target, path)


def sandbox(config, root, archive_path, source_info):
    # This is PID 1 in a fresh PID namespace. Exiting kills every descendant.
    if os.getpid() != 1:
        raise Unavailable("Missing PID namespace")
    checked(libc.sethostname(b"azpr-verification", len(b"azpr-verification")))
    checked(libc.setdomainname(b"", 0))
    prctl(4, 0)  # Non-dumpable supervisor: no /proc/1/fd or root escape by same uid.
    rootfs = os.path.realpath(config["rootfs"])
    if rootfs in ("/", "/home", "/root", "/etc", "/usr", "/tmp"):
        raise Unavailable("Use a dedicated credential-free rootfs")
    for name in ("proc", "dev", "tmp", "workspace", "source", "home"):
        info = os.lstat(os.path.join(rootfs, name))
        if not stat.S_ISDIR(info.st_mode):
            raise Unavailable("Rootfs mountpoints must be real directories")
    for directory, dirs, files in os.walk(rootfs, followlinks=False):
        for name in dirs + files:
            mode = os.lstat(os.path.join(directory, name)).st_mode
            if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode)):
                raise Unavailable("Rootfs must not expose host sockets, FIFOs or devices")
    archive = open(archive_path, "rb")
    mount(None, "/", flags=16384 | 262144)  # recursive, private propagation
    mount(rootfs, root, flags=4096)  # nonrecursive bind; never import host submounts
    mount(None, root, flags=4096 | 32 | 1 | 2 | 4)  # bind remount ro,nosuid,nodev
    # All writable data shares one size-bounded tmpfs. Bind only its children.
    scratch = os.path.join(root, "tmp")
    mount("tmpfs", scratch, "tmpfs", 2 | 4, "mode=1777,size=" + str(config["storageMiB"]) + "m")
    for name in ("workspace", "source", "home", "dev"):
        os.mkdir(os.path.join(scratch, name))
        mount(os.path.join(scratch, name), os.path.join(root, name), flags=4096)
    # Minimal devices only; no host /dev tree, sockets, terminals or agents.
    for name in ("null", "zero", "random", "urandom"):
        target = os.path.join(root, "dev", name)
        open(target, "xb").close()
        mount("/dev/" + name, target, flags=4096)
    os.symlink("/proc/self/fd", os.path.join(root, "dev", "fd"))
    mount("proc", os.path.join(root, "proc"), "proc", 2 | 4 | 8)
    # Loopback allows local test servers; the namespace has no external interface.
    import fcntl
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        fcntl.ioctl(sock, 0x8914, struct.pack("16sH", b"lo", 0x1 | 0x40) + b"\0" * 14)
    os.chroot(root)
    os.chdir("/")
    extract(archive, "/source")
    archive.seek(0)
    extract(archive, "/workspace")
    archive.close()
    mount(None, "/source", flags=4096 | 32 | 1 | 2 | 4)
    # Remove the alternate writable /tmp/source view of the immutable source.
    mount("tmpfs", "/tmp/source", "tmpfs", 1 | 2 | 4, "size=4k")
    os.chdir("/workspace")
    drop_privileges()
    syscall_boundary()
    pid = os.fork()
    if pid == 0:
        try:
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            memory = config["memoryMiB"] * MIB
            resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
            resource.setrlimit(resource.RLIMIT_NPROC, (config["processes"], config["processes"]))
            storage = config["storageMiB"] * MIB
            resource.setrlimit(resource.RLIMIT_FSIZE, (storage, storage))
            # No protocol/archive/host directory descriptors survive command exec.
            os.closerange(3, resource.getrlimit(resource.RLIMIT_NOFILE)[0])
            resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
            os.dup2(1, 2)
            os.execve("/bin/sh", ["sh", "-c", config["command"]], {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home", "TMPDIR": "/tmp", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
        except BaseException:
            os._exit(126)
    while True:
        child, status = os.waitpid(-1, 0)
        if child == pid:
            code = os.waitstatus_to_exitcode(status)
            send({"status": "COMPLETED", "exitCode": code if code >= 0 else None, "signal": -code if code < 0 else None, "source": source_info})
            return


def main():
    os.umask(0o077)
    if len(sys.argv) > 1 and sys.argv[1] == "--sandbox":
        with open(sys.argv[2], encoding="utf-8") as stream:
            config = json.load(stream)
        sandbox(config, sys.argv[3], sys.argv[4], json.loads(sys.argv[5]))
        return
    config = json.load(sys.stdin)
    # Bound trusted source preparation too; never allow a huge Git object or
    # archive to exhaust host address space or fill its temporary filesystem.
    memory = config["memoryMiB"] * MIB
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    storage = config["storageMiB"] * MIB
    resource.setrlimit(resource.RLIMIT_FSIZE, (storage, storage))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    directory = sys.argv[1]
    try:
        archive, source = prepare(config, directory)
    except subprocess.CalledProcessError:
        raise Unavailable("The authorized local repository or exact commit is unavailable; no fetch or host execution fallback was attempted.") from None
    root = os.path.join(directory, "root")
    os.mkdir(root)
    request = os.path.join(directory, "request.json")
    with open(request, "x", encoding="utf-8") as stream:
        json.dump(config, stream)
    command = ["/usr/bin/unshare", "--user", "--map-root-user", "--mount", "--pid", "--ipc", "--net", "--uts", "--fork", "--kill-child=KILL", "/usr/bin/python3", "-I", os.path.abspath(__file__), "--sandbox", request, root, archive, json.dumps(source)]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, pass_fds=(3,), stderr=subprocess.DEVNULL)
    # The namespace supervisor owns the result channel. Do not append another
    # JSON value after its failure result; unshare startup failure has no result.
    return result.returncode


if __name__ == "__main__":
    try:
        exit_code = main()
    except BaseException as error:
        # Never expose host paths, raw Git errors, rootfs contents or settings.
        try:
            send({"status": "UNAVAILABLE", "reason": str(error) if isinstance(error, Unavailable) else "Source preparation or namespace setup failed. Check the configured local commit, trusted rootfs, Linux namespace support and resource limits. No host execution fallback was used."})
        except OSError:
            pass
        sys.exit(1)
    else:
        sys.exit(exit_code or 0)
