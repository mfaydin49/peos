---
name: retry
description: After a PEOS evaluation hit its three-round limit, let the run try again (clears that evaluation's round count).
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
2. On success, read ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md. For `spec` or
   `plan`, continue at section 3 step 6 (`FAIL`): the producer gets `last.blocking`.
   For a code evaluation (`code-*`, `security`), continue at section 6 step 3: the
   implementer gets `last.blocking`, then sections 5 and 6 run again.
