---
name: continue
description: Resume an unfinished PEOS run where it stopped.
argument-hint: "[run name]"
disable-model-invocation: true
---

Read ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md and follow its Resume section.

Run (dated or short name, optional): $ARGUMENTS

Without a run name, list runs with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/peos-run.mjs" status --project "${CLAUDE_PROJECT_DIR}" --json`
and resume the most recently updated run that is not `done` or `stopped`. If several
are equally likely, ask which one.
