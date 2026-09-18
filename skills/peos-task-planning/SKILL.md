---
name: peos-task-planning
description: Scope an engineering feature or bugfix into a concise, verifiable task contract using project context and proportional investigation.
---

# Task planning

Read the consuming project's applicable instructions and configuration, then use
[the router](../../AGENTS.md). When loaded through a discovery symlink, resolve this
skill's real location or read `.project-os/toolkit/AGENTS.md` from the project root.

State goal, scope/non-goals, observable acceptance criteria, affected areas,
important edge cases/risks, assumptions, required user decisions (or none), and
verification plan. For bugs, include expected versus actual behavior. A few lines
suffice for small tasks; split larger work into independently verifiable increments.
Use project context before asking. Ask only about missing information that materially
changes behavior, scope, architecture, authorization, data safety, or another
consequential outcome. Do not invent requirements. Proceed with reasonable,
reversible choices within existing authorization.

## Retrieve context proportionally

Start with applicable instructions and an existing project map. Otherwise use targeted
filename/symbol/import/export/reference search to find the owning module, public
contracts, tests, and documentation. Read focused sections, expanding to whole files
and dependencies as uncertainty or cross-cutting effects require. No hard file limit.
Do not read the repository wholesale or create a map for a small task without clear
reuse value. Skip generated output, lockfiles, vendor code, snapshots and coverage
unless directly relevant. Maps and summaries are navigation aids, never source authority.

Backend work needs contracts, data access, authorization and tests; frontend work
needs design/component contracts, accessibility, responsive behavior and tests.
Cross-cutting work may need both. Documentation work uses documentation checks;
release work uses configured release requirements and evidence.

Reuse available context. Reread only after source changes, unavailable/uncertain
prior details, or a correctness/test/review step requiring current evidence.
If using an index, record its source revision plus staged, unstaged, untracked,
deleted and renamed changes. SHA plus dirty flag does not establish freshness.
Use file-level freshness when available; otherwise inspect changed areas directly.
Refresh stale portions if supported, fall back to source if uncertain, and query
scoped results excluding generated/irrelevant files.

Built-in targeted search is the baseline. Graphify or Serena merit evaluation only
against representative tasks; neither is a dependency. Compare total usage, elapsed
time, correctness and rework. Record cached/uncached tokens separately only when the
host exposes reliable data; never infer tokens from files, lines or tool-call counts,
or claim savings without measured comparison. Routing is instruction-based, not a
hard restriction on file access.

## Persist only when useful

Keep a project-local [task record](../../templates/task.md) only for multi-session
work, handoff, unresolved decisions, or verification evidence otherwise lost.
The continuation portion contains only goal, important decisions, relevant files,
verification evidence and next action. Small self-contained tasks need no record.
Durable decisions with future consequences may use [the decision template](../../templates/decision.md):
application decisions stay in the project, toolkit decisions stay in the toolkit.
Never store secrets or unnecessary personal data. Do not record every implementation choice.
