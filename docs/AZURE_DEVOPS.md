# Azure DevOps access

AZPR calls the Azure DevOps Services REST API itself, with a personal access
token (PAT) from its own `settings.json`. No MCP server is involved and AZPR
reads no other component's configuration.

## Configure

1. Create a PAT in Azure DevOps (User settings → Personal access tokens) for
   **one organization** with these scopes:
   - **Code: Read** — PR metadata, iterations, changes and file content;
   - **Pull Request Threads: Read & write** — reading discussions and posting
     comments.

   Global PATs ("All accessible organizations") stop working on 2026-12-01; use
   an organization-scoped token. `Code: Read & write` also works but allows
   pushing code, which AZPR never needs.
2. Set both values in the installed `plugins/azpr-v2/settings.json` and restart
   OpenCode:

   ```json
   { "azure": { "organization": "YOUR_ORGANIZATION", "pat": "YOUR_PAT" } }
   ```

3. Run `/pr-check <PR URL>`; it reads the PR, its changes, one HEAD and one BASE
   file and the discussions without any model request.

The PAT is sent only to `https://dev.azure.com/<organization>` as
`Authorization: Basic base64(":" + PAT)`, inside a `CONNECT` tunnel when
`azure.proxy` is set. It never appears in receipts, reports,
diagnostics or error messages. The installer keeps `settings.json` at mode 600
and preserves it on `--replace`; keep it out of repositories and shared profiles.
PR URLs whose organization differs from `azure.organization` are refused before
any request.

## Proxies and TLS inspection

When dev.azure.com is reachable only through a proxy, a direct connection fails
and `/pr-check` reports `network error (ConnectionRefused)` (or a timeout, or
`ENOTFOUND`) under PR metadata. Point AZPR at the proxy in `settings.json` and
restart OpenCode:

```json
{ "azure": { "proxy": "http://proxy.example.com:8080" } }
```

- `azure.proxy` applies only to AZPR's Azure DevOps calls, not to model
  providers or other plugins. Credentials go in the URL as
  `http://user:password@host:port`, percent-encoded (`@` is `%40`); they are
  never shown in reports or diagnostics. Only Basic proxy authentication is
  supported; for an NTLM or Kerberos proxy run a local forwarder (such as Px or
  Cntlm) and point `azure.proxy` at it. HTTPS requests are tunnelled with
  `CONNECT`, so the proxy sees `dev.azure.com:443` but not the PAT, unless it
  inspects TLS.
- Many corporate proxies inspect TLS: they present certificates signed by a
  company root CA, and requests fail with `the server's TLS certificate was not
  accepted (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)` or a similar code. Save that root
  CA certificate as a PEM file and set `azure.caFile` to its absolute path; AZPR
  trusts it in addition to the built-in roots. On Windows (also for WSL) the
  certificate is in the certificate store (certmgr.msc → Trusted Root
  Certification Authorities); export it as "Base-64 encoded X.509 (.CER)".
  `openssl s_client -proxy host:port -connect dev.azure.com:443 -showcerts`
  shows the chain the proxy presents.
- `azure.verifyTls: false` turns certificate checks off for these calls, the
  equivalent of `curl -k` or `NODE_TLS_REJECT_UNAUTHORIZED=0`. Anyone who can
  intercept the connection can then read the PAT, so use it only when the CA
  certificate cannot be obtained. `/pr-check` shows a WARNING row while it is
  off.
- Settings and the CA file are read when OpenCode loads AZPR; restart OpenCode
  after changing either. `/pr-check` lists the proxy (without credentials) and
  the number of extra CA certificates.
- Without `azure.proxy`, OpenCode's runtime (Bun) still honours `HTTPS_PROXY`
  and `NO_PROXY` in the OpenCode process environment, and `NODE_EXTRA_CA_CERTS`
  for extra CA certificates. Those apply to every connection OpenCode makes,
  including model providers; `azure.proxy` and `azure.caFile` limit the change
  to AZPR.
- The three settings rely on the per-request proxy and TLS options of Bun's
  `fetch`. A runtime whose `fetch` would ignore them makes AZPR refuse to load
  instead of connecting directly.

## REST API and versions

Every request pins `api-version=7.1`, the latest **released** version of each
resource below. The service reports, per resource, a minimum of 1.0 or 3.0, a
released version of 7.1 and a maximum of 7.2 (preview). Released versions stay
supported; preview versions may be deactivated 12 weeks after their release,
which is why AZPR does not use 7.2-preview (the MCP 2.9.0 client did). The
fields AZPR reads were compared on 5.0, 5.1, 6.0, 7.0, 7.1 and 7.2-preview
against a live organization and were identical.

Paths are relative to
`https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repository}/`.

| Use | Request | Scope |
| --- | --- | --- |
| PR identity, status, title, description, refs | `GET pullRequests/{id}` | Code (Read) |
| Iterations: latest source commit and merge base (`commonRefCommit`) | `GET pullRequests/{id}/iterations` | Code (Read) |
| Changed files of the latest iteration against the merge base | `GET pullRequests/{id}/iterations/{n}/changes?$top=2000&$skip=` | Code (Read) |
| The PR's commit messages (newest 100), reviewer context | `GET pullRequests/{id}/commits?$top=100` | Code (Read) |
| Discussions, existing markers and read-back | `GET pullRequests/{id}/threads` | Code (Read) or Pull Request Threads |
| Summary and inline comments | `POST pullRequests/{id}/threads` | Pull Request Threads (Read & write) or Code (Read & write) |
| File content and folder listings at a commit | `GET items?path=…` / `GET items?scopePath=…&recursionLevel=…` with `versionDescriptor.versionType=commit` | Code (Read) |
| The whole repository at a commit as a zip, for content search | `GET items?scopePath=/&recursionLevel=Full&$format=zip` with `versionDescriptor.versionType=commit` | Code (Read) |

Azure DevOps Server (on-premises) supports 7.1 from Azure DevOps Server 2022.1,
but AZPR accepts only Azure DevOps Services URLs (`dev.azure.com/<org>` and
`<org>.visualstudio.com`).

## Who calls what

- **Runtime** (deterministic code): the snapshot (PR, iterations, all change
  pages, commit messages), the final version recheck and the pre-publication recheck (PR and
  iterations), `/pr-check` reads, the discussion digest for comment planning,
  HEAD source excerpts for planning, thread creation and marker read-back.
- **Reviewers** (models) use six read-only AZPR tools, visible only in AZPR's
  private sessions and always bound to the run's repository. Every answer
  stays below 48,000 UTF-8 bytes: OpenCode keeps only a preview of a tool
  output over its default limit of 51,200 bytes, and private reviewers cannot
  read the rest it saves:
  - `azpr_read_diff` — what the PR changed in one file: BASE → HEAD hunks with
    both line numbers, 5 unchanged lines before and 3 after each change
    (extended to the start of the enclosing block when it is near). A change
    repeated at least three times in a file with only different strings or
    numbers is folded to one line per repeat listing the values that differ.
    The diff is computed locally from the two file reads below;
  - `azpr_read_file` — one file at `head`, `base` or a full commit SHA as
    numbered lines, at most 1,000 lines (45,000 bytes) per call; a line longer
    than one read is returned in parts with `startColumn`, keeping its line
    number, so no source is out of reach;
  - `azpr_search_code` — literal text in the contents of every text file at
    `head`, `base` or a commit, changed or not, as `path:line: text` matches
    (at most 100, 20 per file), optionally limited to a folder or a name glob.
    The runtime downloads the repository once per run and commit as a zip
    (at most `azure.archiveMegabytes`, 100 MB by default) and searches it in memory; files over 2 MB, binary files
    and anything beyond 256 MB of text are not searched, and ZIP64 or
    encrypted archives make the tool answer that search is unavailable. Azure
    DevOps Code Search is not used: it indexes only the default branch, not a
    PR's source commit;
  - `azpr_find_files` — repository paths by name or glob, from one recursive
    listing per commit and folder (read once per run); names only;
  - `azpr_list_files` — one folder's entries (optionally recursive), at most
    1,000 entries;
  - `azpr_pr_threads` — live discussion threads, filterable by path or thread ID.

  Ordinary OpenCode sessions do not see these tools, and private sessions see no
  other tools except native read/glob/grep (and shell when the `shell` setting
  allows it). There are no write tools for models.

## Snapshot semantics

- **head** is the latest iteration's source commit (the code under review).
- **base** is that iteration's common commit with the target branch (the merge
  base), the comparison Azure DevOps shows in the PR's Files view. When Azure
  reports no merge base, base is the target branch tip and the report says so.
- **files** are the latest iteration's changes against the merge base, read in
  pages of 2,000 until Azure reports no further page.
- Only a changed head makes a review STALE; a moved base is a warning.

## Reliability

- All calls share one queue (`azure.concurrency`) with a per-call timeout
  (`azure.callTimeoutSeconds`) that aborts the HTTP request and frees the slot.
- Reads retry network errors, timeouts, throttling (429, honouring
  `Retry-After` up to 60 seconds) and 5xx responses twice with backoff.
- Writes are never retried. A write whose outcome is unknown (timeout, a lost
  connection after sending, or a 5xx from a proxy or gateway that may have
  forwarded it) is recorded as uncertain and resolved by reading the markers
  back; publishing again is always safe.
- A certificate that is not trusted fails at once: the handshake failed, so
  nothing was sent. An error answer without Azure DevOps' `X-TFS-ProcessId`
  response header (which Azure DevOps puts on every answer) is reported as the
  answer of a proxy or gateway, not as a PAT or permission problem.
- Files are read once per run and cached; binary files (a NUL byte in the first
  8,000 bytes) and files over 10 MB are reported, not shown.

## Troubleshooting

| Message | Meaning |
| --- | --- |
| `Azure DevOps rejected the PAT for organization "x" (HTTP 203)` (or 401) | The PAT is invalid, expired, revoked or not valid for this organization. Azure answers with a sign-in page (HTTP 203) instead of 401. |
| `Azure DevOps refused … (HTTP 403 …)` | The PAT lacks a scope or the user lacks access to the project or repository. |
| `Azure DevOps could not find … (HTTP 404 TF…)` | Wrong project, repository, PR ID or path; Azure's error code is shown. |
| `The PR belongs to organization "x", but azure.organization is "y"` | Configure the PAT and organization of that PR. |
| `… did not finish within the per-call timeout` | Azure DevOps or the network did not answer; reads were retried. |
| `network error (ConnectionRefused)` (or `ETIMEDOUT`, `ENOTFOUND`) | OpenCode cannot reach dev.azure.com; behind a corporate proxy set `azure.proxy`. With a proxy set, the proxy itself is unreachable. |
| `the server's TLS certificate was not accepted (…)` | A proxy inspects HTTPS with its own CA (or the clock is wrong); set `azure.caFile`. Not retried. |
| `A proxy refused … it requires authentication (HTTP 407)` | Put the proxy credentials in `azure.proxy`. |
| `A proxy or gateway answered … instead of Azure DevOps` | A proxy or firewall answered (no Azure DevOps response headers), for example for a blocked destination; check its policy for dev.azure.com. |
| `The PR has no source/base commit yet` | Azure DevOps has not finished evaluating the PR; retry shortly. |

Exact-host fixtures set `AZPR_TEST_AZURE_BASE_URL` to a loopback fake service;
any other host is refused, so the PAT can only reach `dev.azure.com`.
