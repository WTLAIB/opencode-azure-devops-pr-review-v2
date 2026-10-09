# Azure DevOps MCP setup

AZPR uses the official `@azure-devops/mcp` server (tested with 2.9.0) through
OpenCode's MCP integration. It has no Azure client, token handling or PAT
setting of its own: the MCP server owns authentication.

## Connect the server

```json
{
  "mcp": {
    "servers": {
      "ado": {
        "type": "local",
        "command": ["npx", "-y", "@azure-devops/mcp@2.9.0", "YOUR_ORGANIZATION"],
        "codemode": false
      }
    }
  }
}
```

- **`codemode: false` is required.** Reviewers call the repository tools
  directly; CodeMode `execute` is blocked for private roles because its `fetch`
  bypasses OpenCode's web permissions. AZPR refuses a server that is in CodeMode.
- With several MCP servers exposing Azure DevOps tools, set `mcp.server` in
  AZPR's `settings.json` to the server name.
- The server is configured for one organization; AZPR refuses a PR whose URL
  names a different organization than the server's responses.

## Tools AZPR calls itself

| Tool | Runtime use |
| --- | --- |
| `repo_pull_request` (`get`, `includeChangedFiles`) | Snapshot, final version recheck, pre-publication check. |
| `repo_file` (`get_content`) | `/pr-check` sample reads at HEAD and BASE. |
| `repo_pull_request_thread` (`list`, paged) | Existing markers before and after publication; `/pr-check`. |
| `repo_pull_request_thread_write` (`create`) | Posting the saved summary and inline comments. |

These calls run through the private `azpr-runtime` agent in a model-less child
session of the invoking conversation. Host permission rules for MCP tools apply
to that agent: an `ask` rule shows an approval request, a `deny` rule fails the
call. Reviewers and the comment planner use the same tools (reads only, by
prompt policy) under their own roles.

All MCP calls from AZPR — runtime and model — share one queue with
`mcp.concurrency` slots and a `mcp.callTimeoutSeconds` timeout per call, so a
hung request cannot freeze other reviews.

## Snapshot semantics

- **head** is `lastMergeSourceCommit`: the proposed code.
- **base** is `lastMergeTargetCommit`: the target branch state Azure last merged
  against. It is not a proven merge base, and it moves when the target branch
  advances. A moved base during a review is a warning, not STALE; only a changed
  head makes a review STALE. Version 2.9.0 of the MCP server does not expose PR
  iterations (`commonRefCommit`), so a merge-base comparison is not available.
- **files** come from the latest iteration's change list. Azure returns at most
  one page through this tool; when more exist (`nextSkip`/`nextTop`), the
  snapshot is marked incomplete, reviewers are asked to report the remaining
  changed paths, and the report lists them as unverified.

## Troubleshooting

| Receipt message | Meaning |
| --- | --- |
| `No connected MCP server exposes Azure DevOps repository tools` | The server is not connected, failed authentication, or lacks the repository tools. |
| `Several MCP servers expose Azure DevOps tools` | Set `mcp.server`. |
| `uses CodeMode` | Set `codemode: false` on the server. |
| `belongs to organization "x"` | The PR URL's organization differs from the server's. |
| `has no source/target commit yet` | Azure has not finished evaluating the PR; retry shortly. |
| `did not finish within N seconds` | An MCP call timed out; check the server and network. |

Run `/pr-check <PR URL>` to test access without any model request.
