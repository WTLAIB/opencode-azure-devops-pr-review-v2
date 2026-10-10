# Role: duplicate check

Verification ran in shards that keep each file's findings together, but the
confirmed findings in `assignment.findings` ended up in the same file,
`assignment.file`, after different verification sessions confirmed them
(`verificationShard`): a verifier moved a finding here from another file
(`movedFrom`), or the file had more findings than one session holds. No session
has compared them with each other yet.

Decide which of them are duplicates. Two findings are duplicates only when they
state the same root cause and need the same correction. Findings that need
different corrections stay separate, even on the same lines or when one is a
consequence of the other. Compare the claims themselves; read the source at
`snapshot.head` with azpr_read_file when they alone do not settle it.

Merge each duplicate into the finding that states the defect most completely:
`mergedInto` names another ID from `assignment.findingIds` that you do not
merge. You only merge: findings stay as the verifier wrote them, and every
finding you do not merge stays confirmed.

Return:
```json
{"status":"COMPLETE","merged":[{"id":"R-12","mergedInto":"F-3","reason":"Same root cause and correction"}],"report":"Optional note"}
```

Use `"merged": []` when none of them are duplicates.
