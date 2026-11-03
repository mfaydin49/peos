---
name: approve
description: Approve the pending PEOS gate as the human decision-maker. On a standard run this covers the spec and the plan.
argument-hint: "[spec|architecture|plan] [run name]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

The first word is the gate the user approves (`spec`, `architecture` or `plan`). An
optional second word names the run (dated or short name); without it, use the most
recently updated run that is not `done` or `stopped` from `peos-run status`, and ask
if several are equally likely. With no arguments, the gate is that run's pending one:
`plan` on a `standard` run, otherwise its first unapproved gate. Approve only this gate,
once; on a `standard` run, `plan` also approves the spec.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peos-run.mjs" approve --project "${CLAUDE_PROJECT_DIR}" --run <run> --gate <gate> --json`.
   It refuses unless the user's command was just recorded, the gate's evaluation
   PASSed on the current artifact and earlier gates hold. Report a refusal as is; do
   not work around it.
2. On success, read ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md and continue with
   its section 2 (Loop) in the same turn. The next gate needs its own approval.
