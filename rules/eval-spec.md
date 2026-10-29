# Spec evaluation rubric

Input: `spec.md` (or `task.md`) and, for the large tier, `idea.md`.

Blocking (`high` or `critical`):

- An acceptance criterion is not observable or not measurable ("works well", "fast").
- A criterion bundles several behaviors that could pass or fail independently.
- Scope or non-goals are missing, or a non-goal contradicts a criterion.
- An open question or unresolved decision remains.
- A requirement appears that the request or idea does not support (invented scope).
- A security, privacy or data-ownership need implied by the request is absent.

Non-blocking (`medium` or `low`): unclear wording, missing edge case that a planner
would likely still cover, non-functional requirement without a number.

Do not judge implementation choices; the spec states what, not how.
Use `criteria` only to echo the spec's own `AC-n` items when you assess each one;
otherwise leave it empty.
