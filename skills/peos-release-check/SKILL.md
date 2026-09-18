---
name: peos-release-check
description: Assess release readiness from configured automated checks plus current acceptance, review, manual, environment, migration, and performance evidence; produce a report only.
---

# Release check

Use [the router](../../AGENTS.md), project configuration, and [Git/scope policy](../../rules/git.md).
Through discovery symlinks, resolve the real skill location or use the project's
`.project-os/toolkit` link. Read project release requirements and run only authorized
configured release checks using [the integration guide](../../integrations/codex.md).

Combine full applicable automated results with acceptance criteria, review findings,
required visual/manual evidence (including configured manualChecks), environment and
migration prerequisites, relevant performance evidence, and known blockers.
Separate verified prerequisites, justified non-applicable requirements, and outstanding
work. An automated PASS is not release readiness. Never use a partial report as proof
that all required release checks passed.

Report one readiness outcome:
- READY: all applicable required evidence is complete for the current code state,
  with no known blocking failure.
- NOT READY: an established failure prevents release.
- BLOCKED: required evidence or prerequisites are unavailable.

Keep optional findings visible and escalate material risks even if labeled optional.
When established failures and missing evidence coexist, report NOT READY with the
missing evidence as additional blockers. If code changes, invalidate affected evidence
and rerun relevant checks. A commit SHA is insufficient when local work has changed;
identify relevant staged, unstaged, untracked, deleted and renamed files and evidence
timing. Version one stops at this report, within the boundaries in Git/scope policy.
