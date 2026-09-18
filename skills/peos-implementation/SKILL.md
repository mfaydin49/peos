---
name: peos-implementation
description: Implement a scoped feature or bugfix against an existing task contract and project conventions, with relevant tests and completion evidence.
---

# Implementation

Use [the router](../../AGENTS.md) and the task contract; obtain a concise contract
with [planning](../peos-task-planning/SKILL.md) if missing. Through discovery symlinks,
resolve the real skill location or use the project's `.project-os/toolkit` link.
Read relevant implementation before editing. Apply [quality](../../rules/code-quality.md),
[Git/scope](../../rules/git.md), [testing](../../rules/testing.md), and relevant
[security](../../rules/security.md) or [UI/UX](../../rules/ui-ux.md) rules.

Reuse existing public APIs, components and patterns. Introduce dependencies,
compatibility layers, state, caching or memoization only for an established need.
Update owning documentation when a durable contract changes; update stories only
when the project uses them and relevant public states change.

For bugs, investigate the expected/actual mismatch and add a focused regression test
when practical. Implement the smallest complete fix. For features, implement each
verifiable increment against acceptance criteria. Material product/scope discoveries
require updating the contract and resolving the decision, not silent expansion.

Run applicable project tests and configured task checks using the explicit target
project (see [invocations](../../integrations/codex.md)). Targeted results are partial:
account for omitted required checks before claiming completion. Obtain a separate
[read-only review pass](../peos-code-review/SKILL.md), address findings, and rerun
affected checks and material review. Do not claim independent review unless it occurred.
Report the outcome and evidence as specified by the router.
