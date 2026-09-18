# Engineering workflow router

Identify the explicit consuming project. Follow the host instruction hierarchy,
its applicable project instructions, and `.project-os/engineering.config.json`.
Missing configuration is a blocker for configured verification, not permission to
invent commands. Project policy specializes generic defaults; surface unresolved
conflicts. Use `outputLanguage` for responses (default `tr`); toolkit files are English.

Select only the needed workflow:
- Feature: task contract → implementation/tests → task checks → review → fixes,
  affected rechecks and material re-review → completion report.
- Bugfix: expected/actual behavior → focused investigation → regression test when
  practical → minimal fix → task checks and review → completion report.
- Review: selected diff/files → read-only actionable findings.
- Release: configured release checks + required manual/environment evidence →
  readiness assessment. Normal feature completion is not release readiness.

Use [planning](skills/peos-task-planning/SKILL.md) for contracts and context retrieval,
[implementation](skills/peos-implementation/SKILL.md) for changes,
[review](skills/peos-code-review/SKILL.md) for assessment, and
[release check](skills/peos-release-check/SKILL.md) for readiness.
Read [Git/scope](rules/git.md) when changing files; select
[quality](rules/code-quality.md), [security](rules/security.md),
[UI/UX](rules/ui-ux.md), and [testing](rules/testing.md) only as applicable.
Project references resolve from the consuming project root, never this toolkit.

Before completion, map acceptance criteria to actual evidence, report executed
checks and results, review findings, omissions and blockers, and identify whether
only the task or release readiness was established. See
[Codex integration](integrations/codex.md) for executable invocation and limits.
These are logical responsibilities, not automatically created agents or commands.
