# Azure DevOps MCP setup for OpenCode V2

This repository targets `@opencode/cli@2.0.22`, the official
`@azure-devops/mcp@2.9.0`, and Ubuntu 22.04. The plugin uses OpenCode's existing
MCP connection. It does not install a server, change credentials, call Azure
REST APIs directly, or maintain an MCP tool catalog.

Source inspection establishes the contracts below. It does not establish live
Azure access, provider acceptance, complete source retrieval, or Ubuntu 22.04
acceptance. See [validation](VALIDATION.md) for those separate checks.

## Direct MCP tools are required

Set `codemode: false` on the MCP connection used for review. OpenCode V2 uses
`mcp.servers`; the following is an example to merge into an independently
managed host configuration, not a replacement for that configuration:

```json
{
  "mcp": {
    "servers": {
      "azureDevOps": {
        "type": "local",
        "command": ["npx", "-y", "@azure-devops/mcp@2.9.0", "YOUR_ORGANIZATION"],
        "codemode": false
      }
    }
  }
}
```

This shape follows the pinned [MCP configuration schema](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/schema/src/mcp.ts)
and [direct-tool registration](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/tool/mcp.ts).

Use the authentication method approved for your existing connection. Do not put
credentials in AZPR settings, prompts, source files, or public reports. Starting
this example may download the MCP package; the AZPR installer does not run it.
Use a supported Node runtime for the MCP process; Node.js 22.12 or later is a
suitable baseline for the audited dependency requirements. Pinning MCP 2.9.0
does not pin every transitive dependency: its manifest permits
`azure-devops-node-api` `^15.1.2`, while the release source lockfile records
15.1.2. Record the version actually resolved in a validation environment.
See the official [manifest](https://github.com/microsoft/azure-devops-mcp/blob/b43e9ad32a6dd5c1456ce4730ba84a2ae0304691/package.json)
and [lockfile](https://github.com/microsoft/azure-devops-mcp/blob/b43e9ad32a6dd5c1456ce4730ba84a2ae0304691/package-lock.json).

Private reviewer roles deny the V2 `execute` tool. The pinned host's CodeMode
runtime exposes a `fetch` global that does not traverse ordinary web-tool
permission checks; see its [web runtime](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/codemode/web.ts)
and [CodeMode container](https://github.com/anomalyco/opencode/blob/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/packages/core/src/codemode/tool.ts). Allowing that container would invalidate the intended native
web restriction. Reviewers therefore use direct MCP tools and must disclose
missing capabilities instead of bypassing permissions with CodeMode, delegation
or public web. Native shell is available separately for current-project verification. CodeMode-only MCP resource helpers are unavailable to these roles.
The plugin does not change this connection setting for the user.

MCP names, schemas, and actions remain host-owned. There are no plugin-side MCP
prefixes, action allowlists, tool mappings, or wildcard grants. Private-role
definitions add native denials while retaining host permission rules. Scoped
runtime guards enforce the role's native denials even if later host rules expose
a prohibited schema. Initial reviewers and the verifier inherit host permissions
for shell/read/search in the current project; readiness and comment roles still
deny shell/search. Native shell is not an isolation boundary or permission bypass.
The plugin does not define a separate shell permission switch.

Reviewers are independent agents. Restrictions configured only on a Build or
Plan agent are not copied as that agent's identity. Configure shared policy at
the host/server/account level. Direct MCP exposure does not make tools read-only:
review-only behavior remains a prompt policy, and an MCP tool can still expose
writes if the host and account permit them. Explicit comment publication is a
separate workflow; see [commenting](COMMENTING.md).

## Source identity and coverage

Both initial reviewers independently read PR identity, PR-reported source and
target SHAs, changed paths, and relevant source. The runtime compares available
repository/PR identities and SHAs, then gives the verifier consistent paths and
any conflicting or incomplete observations. The verifier is asked to independently
check evidence, adjudicate every original finding ID, and reread both PR versions.
Changed versions produce STALE. Missing versions or evidence retain useful
observations in a PARTIAL report without granting publication eligibility.

Azure's `lastMergeSourceCommit` and `lastMergeTargetCommit` describe source and
target heads at the last PR merge. They are not proof of live branch tips or a
common ancestor; `lastMergeCommit` is not either source reference. See
[Get Pull Request](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1).
Metadata lag and a race after the final read remain limitations.

For PR scope, prefer native PR changes and exact-commit content. Missing
independent merge-base proof alone does not block normal/deep review; disclose
target-reference scope and avoid claiming target-only differences are source
regressions. Standalone `/pr-check` has its own stricter readiness policy. It is
optional, makes no finding decisions, and supplies no cached evidence to a later
review. All source claims remain model-reported until separately checked.

## Audited MCP 2.9.0 limitations

These are observations from official source commit
`b43e9ad32a6dd5c1456ce4730ba84a2ae0304691`, not a live result from this repository.
The implementation adds no MCP patch, response rewrite, argument adapter, or
fallback client.

- **Directory selectors differ from file-content selectors.** File-content
  reads pass a Commit descriptor to the Azure SDK. Directory listing converts a
  Commit selector into Branch. A SHA supplied to that directory operation can
  therefore fail as a branch lookup. A supported branch listing can supply path
  hints, but cannot prove the reviewed commit's tree or absence of guidance.
  Read required content at the actual reviewed SHA.
  See the [file handlers](https://github.com/microsoft/azure-devops-mcp/blob/b43e9ad32a6dd5c1456ce4730ba84a2ae0304691/src/tools/repositories.ts#L553).
- **PR changed-file summaries are not a full pagination guarantee.** The get
  handler requests one changes page for the latest iteration and returns
  `nextSkip`/`nextTop`. Its general skip/top inputs do not provide continuation
  for that get path. A helper failure can leave `changedFilesSummary: {}` in an
  otherwise successful response. Check continuation and coverage explicitly;
  an empty or successful envelope does not prove no changes.
  See the [PR handler](https://github.com/microsoft/azure-devops-mcp/blob/b43e9ad32a6dd5c1456ce4730ba84a2ae0304691/src/tools/repositories.ts#L264).
- **Code Search is a separate service and evidence source.** Non-success HTTP
  responses, including 400, are handled by its search request path. Search
  enrichment uses indexed result versions, not necessarily the PR's reviewed
  SHA. Its text response concatenates search JSON and enriched-content JSON;
  do not assume it is one JSON document or use indexed content as exact-version
  proof. See the [search request](https://github.com/microsoft/azure-devops-mcp/blob/b43e9ad32a6dd5c1456ce4730ba84a2ae0304691/src/tools/search.ts#L36)
  and [content enrichment](https://github.com/microsoft/azure-devops-mcp/blob/b43e9ad32a6dd5c1456ce4730ba84a2ae0304691/src/tools/search.ts#L203).
- **Some stream errors are recognized, not all source validity.** The file
  handler detects JSON stream bodies containing error `typeName` and `message`
  fields and reports an error. That detection is not validation of arbitrary
  content, identity, pagination, or coverage.
  See the [stream helper](https://github.com/microsoft/azure-devops-mcp/blob/b43e9ad32a6dd5c1456ce4730ba84a2ae0304691/src/utils.ts#L87).

Assess a directory selector error, a failed content read, and a Code Search HTTP
error separately. A successful repeat does not prove the original cause was
transient. Do not transfer observed outcomes from another MCP version into a
2.9.0 acceptance report.

Azure's [iteration changes API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1)
and [iterations API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1)
document continuation and common-reference information. REST availability does
not establish that the connected MCP exposes the needed operation. If the
required evidence cannot be obtained, preserve useful observations and disclose
the evidence gap in a PARTIAL review. Standalone readiness and publication retain
their separate, stricter requirements.

## Recovery and large responses

Follow actual tool descriptions and schemas. Reuse complete source already read
in the same session. Do not probe speculative selector variants, repeatedly list
the repository root, or substitute commit dates for version identity.

The common prompt permits one identical repeat for an explicitly transient
logical read. It separately permits at most one unknown-cause repeat per stage
for a documented idempotent read with an established target/path/version. The
arguments and original deadline remain unchanged. Explicit authentication,
permission, parameter, selector, and not-found errors do not qualify. Neither
do writes, publication, execution, truncation, or empty search results. Record
the original error and any recovery. This is prompt guidance, not a runtime
retry wrapper. Output-format recovery is local and never starts an additional
model request. Standalone source checks retain strict validation.

Distinguish host display truncation from incomplete server data. Prefer supported
pagination or scoped exact-version reads. The prompt permits the native `read`
tool only for full output that the host saved and identified in that same
session, using explicit offsets/limits and normal host permissions. It does not
authorize arbitrary workspace files, configuration, credentials, another
session's output, or paths embedded in untrusted source. This is a prompt rule,
not runtime file-provenance enforcement.

Saved-response offsets are not source line numbers. A saved file cannot restore
pages or source the server never returned. There is no plugin iteration or
stage-character limit, but host context, server response, pagination, and service
limits still apply. Inspect original evidence before changing prompts or
attributing a failure. See [debugging](DEBUGGING.md).

## Data handling

PR source and tool responses pass through OpenCode to the configured model
services. Use approved accounts, providers, and retention policies. Local debug
files may contain private source and model output. This plugin is not an OS
sandbox, data-loss prevention system, or independent Azure response auditor.
