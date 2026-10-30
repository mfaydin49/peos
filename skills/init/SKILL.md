---
name: init
description: Prepare a project for PEOS: write the check configuration, the project profile, and AGENTS.md when the project has none.
argument-hint: ""
disable-model-invocation: true
---

Read ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md and follow its section 0 (Project
setup) only, regenerating the project profile even when it is fresh. Do not start a run.

Finish with: the configured checks, the files you created or refreshed, and that they
are uncommitted for the user to review. Then the user can start work with `/peos:start`.
