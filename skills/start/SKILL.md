---
name: start
description: Start a PEOS run for an idea, feature, change, bug fix or refactor.
argument-hint: "<request> [--tier trivial|small|standard|large] [--type app|feature|change|fix|refactor]"
disable-model-invocation: true
---

Read ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md and follow it for a new run:
sections 0, 1 and 2.

Request:

$ARGUMENTS

If the request is empty, ask the user what they want to build or change.
