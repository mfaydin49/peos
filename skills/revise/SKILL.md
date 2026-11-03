---
name: revise
description: Request changes to a PEOS gate artifact (spec, architecture or plan) with feedback.
argument-hint: "<spec|architecture|plan> [--run <name>] <feedback>"
disable-model-invocation: true
---

The user requests changes: $ARGUMENTS

The first word is the gate (`spec`, `architecture` or `plan`). If the next words are
`--run <name>`, that names the run; the rest is the feedback. Without `--run`, use
the most recently updated run that is not `done` or `stopped`, and ask if several are
equally likely.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/peos-run.mjs" revise --project "${CLAUDE_PROJECT_DIR}" --run <run> --gate <gate> --json`.
   This reopens the gate and every later gate and restarts their evaluation rounds.
2. Read ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md and continue with its section 2
   (Loop): `next` spawns the producer, to which you give the user's feedback above.
