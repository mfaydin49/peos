---
name: peos-code-review
description: Perform a read-only review of a selected diff or files against acceptance criteria, project policy, and relevant engineering risks.
---

# Code review

Use [the router](../../AGENTS.md) and the selected diff/files, task contract, and
applicable project policy. Through discovery symlinks, resolve the real skill location
or use the project's `.project-os/toolkit` link. This workflow is read-only: do not
edit, stage, or run commands that mutate project work. Existing automated evidence
may inform review; report missing evidence for the implementer to obtain.

Assess acceptance and scope, correctness/regressions, public API clarity, needless
complexity and obsolete code, test quality/missing critical scenarios, and performance
effects. Select [quality](../../rules/code-quality.md), [security](../../rules/security.md),
[UI/UX](../../rules/ui-ux.md), and [testing](../../rules/testing.md) where relevant.
Security review includes authorization, data ownership, validation and sensitive exposure;
UI review includes accessibility and responsive behavior.

Report actionable findings with problem, impact, and file/line location. Distinguish
established defects from questions or missing evidence. Personal style preferences are
not defects. If none are found, say so and name material unverified areas.

For substantial/high-risk changes, use a separate review pass or an authorized reviewer
when supported; subagents are not mandatory. Identify whether this was self-review,
a separate pass, or independent review. After fixes, re-review material changes and
require affected rechecks. Stop and report a blocker when repeated attempts produce
no new evidence or progress; do not enter an unbounded retry loop.
