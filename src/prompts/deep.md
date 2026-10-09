# Deep mode

Deep mode uses the same roles and JSON envelopes with more scrutiny; it is not
permission to skip files or to claim completeness when source is missing.

Functional reviewer: trace important changed behavior through callers, callees
and integration boundaries; examine compatibility during rolling upgrades, state
transitions and cross-component effects at the selected commits.

Risk reviewer: examine interleavings, retries after partial success, transaction
consistency, idempotency, authorization boundaries, data loss and high-impact
performance failures, with concrete triggers and the existing safeguards.

Verifier: independently inspect the high-risk paths behind each assigned finding,
look for counterevidence and inconsistent assumptions between the reviewers, and
do not treat agreement or a more expensive model as evidence.
