---
name: status
description: Show PEOS runs, or the stage, gates, evaluations and evidence freshness of one run. Read-only.
argument-hint: "[run name]"
---

Run, read-only:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/peos-run.mjs" status --project "${CLAUDE_PROJECT_DIR}" [--run <run>] --json`

Run (dated or short name, optional): $ARGUMENTS

Summarize briefly: stage, each gate (pending, approved, stale), each evaluation
(verdict, round, stale), recorded checks, and the next action. Change nothing.
