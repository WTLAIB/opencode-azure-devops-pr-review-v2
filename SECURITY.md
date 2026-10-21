# Security policy

## Report a vulnerability privately

Use GitHub's [private vulnerability reporting](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/security/advisories/new)
for suspected credential exposure, unauthorized model or Azure requests,
private-session permission bypasses, or other security defects. Do not open a
public issue or pull request containing an exploit or sensitive evidence.

Include:

- The affected AZPR tag or commit, OpenCode version and operating system.
- The affected component, expected boundary and observed impact.
- Minimal reproduction steps using synthetic source and dummy credentials,
  where possible.
- A proposed fix or mitigation, if you have one.

Even a private report should not contain live PATs, provider tokens, complete
settings, company source or raw diagnostic archives. Share the smallest
redacted excerpt that demonstrates the problem. If a credential was exposed,
revoke or rotate it through its issuer rather than sharing it for reproduction.

The [validation record](docs/VALIDATION.md) identifies the currently tested
host and environment. Include reports from other versions too, with their
exact versions so the affected behavior can be reproduced.

## Understand the boundaries

AZPR runs inside OpenCode with your account's authority. Allowed shell commands
are not sandboxed. Review source and discussion text can reach the configured
model providers, and local review records can contain that source. See
[team setup and data handling](docs/ENTERPRISE.md) and
[authorization and isolation](docs/ARCHITECTURE.md#authorization-and-isolation)
for the intended boundaries and defaults.

For ordinary failures or incorrect findings without a security impact, use the
[public bug form](https://github.com/WTLAIB/opencode-azure-devops-pr-review-v2/issues/new?template=bug_report.yml)
with sanitized evidence.
