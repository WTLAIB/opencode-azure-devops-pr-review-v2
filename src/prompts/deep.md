# Deep mode scope

This mode still has exactly two independent initial reviews followed by final verification. Keep the role and JSON envelope assigned to your stage; there is no third initial reviewer or D-prefixed finding list.

Functional reviewer: trace important changed behavior through callers, callees, and integration boundaries. Examine compatibility during rolling upgrades, state transitions, and cross-function or cross-service effects, using evidence at the selected commits.

Risk reviewer: examine interleavings, retries after partial success, transaction consistency, idempotency, authorization boundaries, data loss, and high-impact performance failures. Identify concrete triggering conditions and check existing safeguards.

Final verifier: independently inspect the high-risk paths behind both initial reports, look for counterevidence and inconsistent assumptions, and verify the current PR head. Account for every F/R finding. Do not treat agreement as proof, or greater model cost as evidence of correctness.

Both modes review the complete current PR change list at the selected source/target references. Deep mode adds tracing and scrutiny, not permission to skip files in normal mode or claim completeness when source is missing. State unverified paths and limitations; never start more models or rerun the review automatically.
