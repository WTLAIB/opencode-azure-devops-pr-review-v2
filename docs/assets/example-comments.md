# Illustrative example / synthetic PR

These comment bodies are assembled by the project renderer from a hand-written fixture, not a model review. `example/model` is a placeholder. No Azure thread was created. Hidden publication markers are omitted.

## Inline thread

🟡 medium: Later pages are empty

**📝 Summary**

The second and later pages return no items.

**🔎 Evidence**

page([1, 2, 3, 4], 2, 1) returns [] instead of [3, 4].

**💡 Suggested fix**

Use start + size as the exclusive end of the slice.

---
AI-generated review; not human review or approval. Review method: quick review, not independently verified. Models: `example/model`

## Summary thread

🤖 AI-generated review; not human review or approval. Review method: quick review, not independently verified. Models: `example/model`

## PR Review Summary

**Review notes**

Adds pagination for a list of items.

high: 0 · medium: 1 · low: 0

| Severity | Summary | Location |
| --- | --- | --- |
| 🟡 medium | Q-1 — Later pages are empty | head:/src/pagination.js:3 |
