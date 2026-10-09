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
`Authorization: Basic base64(":" + PAT)`. It never appears in receipts, reports,
diagnostics or error messages. The installer keeps `settings.json` at mode 600
and preserves it on `--replace`; keep it out of repositories and shared profiles.
PR URLs whose organization differs from `azure.organization` are refused before
any request.

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
| Discussions, existing markers and read-back | `GET pullRequests/{id}/threads` | Code (Read) or Pull Request Threads |
| Summary and inline comments | `POST pullRequests/{id}/threads` | Pull Request Threads (Read & write) or Code (Read & write) |
| File content and folder listings at a commit | `GET items?path=…` / `GET items?scopePath=…&recursionLevel=…` with `versionDescriptor.versionType=commit` | Code (Read) |

Azure DevOps Server (on-premises) supports 7.1 from Azure DevOps Server 2022.1,
but AZPR accepts only Azure DevOps Services URLs (`dev.azure.com/<org>` and
`<org>.visualstudio.com`).

## Who calls what

- **Runtime** (deterministic code): the snapshot (PR, iterations, all change
  pages), the final version recheck and the pre-publication recheck (PR and
  iterations), `/pr-check` reads, the discussion digest for comment planning,
  HEAD source excerpts for planning, thread creation and marker read-back.
- **Reviewers** (models) use three read-only AZPR tools, visible only in AZPR's
  private sessions and always bound to the run's repository:
  - `azpr_read_file` — one file at `head`, `base` or a full commit SHA as
    numbered lines, at most 1,000 lines (60,000 characters) per call;
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
- Writes are never retried. A write whose outcome is unknown (timeout or a lost
  connection after sending) is recorded as uncertain and resolved by reading the
  markers back; publishing again is always safe.
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
| `The PR has no source/base commit yet` | Azure DevOps has not finished evaluating the PR; retry shortly. |

Exact-host fixtures set `AZPR_TEST_AZURE_BASE_URL` to a loopback fake service;
any other host is refused, so the PAT can only reach `dev.azure.com`.
