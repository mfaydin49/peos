# PEOS orchestrator: resume

Follows ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md; its Fixed rules apply.
Section 3 is ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/standard.md.

## 8. Resume

Read `peos-run brief --run <run>` and act on the first row that applies:

| Condition | Action |
| --- | --- |
| An evaluation is non-PASS at round 3 | Show its blocking findings and the options of section 3 step 6; stop. |
| A gate's approval is stale (artifact changed after approval) | Say which artifact changed; it needs a new evaluation and approval (section 3). |
| A gate is pending or revision-requested without a fresh PASS evaluation | Section 3 for that stage, with the user's feedback on a revision. |
| A standard run's spec evaluation PASSed but its plan has none | Section 3, plan stage; the spec is approved together with the plan. |
| A gate has a fresh PASS evaluation awaiting approval | Remind the user of `/peos:approve` and `/peos:revise <gate> …`. |
| A refactor has no baseline (`status` says so) | Record it if no step changed code yet; otherwise the `BASELINE` instruction of section 4.1. |
| Stage `implement` with steps not `done` | Section 4: `begin` with the unfinished steps (safe to repeat; binds older runs), then continue from there. |
| Stage `verify` | Section 5. |
| Stage `evaluate` | Section 6 (stale evaluations run again). |
| Stage `release` | Report the summary path. |
