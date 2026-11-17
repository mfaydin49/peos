---
name: approve
description: Approve the pending PEOS decision as the human decision-maker. One approval covers a group of gates (everything on a standard run; spec, architecture and design, then the plan, on a large run).
argument-hint: "[spec|architecture|design|plan] [run name]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

The first word is the gate the user approves (`spec`, `architecture`, `design` or
`plan`). An
optional second word names the run (dated or short name); without it, use the most
recently updated run that is not `done` or `stopped` from `peos-run status`, and ask
if several are equally likely. With no arguments, the gate is `decision` in the output
of `peos-run status --run <run>` (`plan` on a `standard` run; on a `large` run `design`,
or `architecture` when the run has no design, then `plan`). Approve only this gate,
once; it also approves the earlier gates decided with it.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peos-run.mjs" approve --project "${CLAUDE_PROJECT_DIR}" --run <run> --gate <gate> --json`.
   It refuses unless the user's command was just recorded, the gate's evaluation
   PASSed on the current artifact and earlier gates hold. Report a refusal as is; do
   not work around it.
2. On success, read ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md and continue with
   its section 2 (Loop) in the same turn. A later decision needs its own approval.
