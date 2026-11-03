---
name: retry
description: Let a PEOS run try an evaluation again after its three-round limit, a plateau, or a BLOCKED verdict (clears that evaluation's round count).
argument-hint: "<evaluation key, e.g. spec or code-all> [run name]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

The first word is the evaluation key; an optional second word names the run (dated or
short name); without it, use the most recently updated run that is not `done` or
`stopped`.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peos-run.mjs" reset-eval --project "${CLAUDE_PROJECT_DIR}" --run <run> --key <key> --json`.
   It succeeds only right after the user typed this command. Report a refusal as is.
   Its output `last.blocking` holds the findings of the report it cleared.
2. On success, read ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md and continue with
   its section 2 (Loop): `next` spawns the producer or the implementer with the cleared
   report's findings again, or the evaluator when the work changed since.
