# Reference measurements

Four fixed requests that are run through PEOS before and after a change to it (a prompt,
a rubric, a model choice, the control flow), so that "better" is a comparison and not an
impression. They cover the tiers: a one-line fix, a feature, a refactor and a new
application with a user interface.

| Task | Fixture | Exercises |
| --- | --- | --- |
| [fix-last-page](tasks/fix-last-page.md) | `fixtures/notes` | investigation, a regression test, the smallest path |
| [feature-tag-filter](tasks/feature-tag-filter.md) | `fixtures/notes` | spec and plan, where new code is placed |
| [refactor-http-routes](tasks/refactor-http-routes.md) | `fixtures/notes` | baseline, behavior preservation |
| [app-habits](tasks/app-habits.md) | empty repository | architecture, design, milestones, UI evaluation |

## Procedure

```sh
node scripts/bench.mjs list
node scripts/bench.mjs prepare --task fix-last-page --into /tmp/peos-bench/fix-last-page
```

`prepare` copies the fixture into a new Git repository and prints the request to send
with `/peos:start`, the scoring list and the command that collects the result. Run the
task in a Claude Code session in that project, answering as a user would. When the run
ends, go through the task's scoring list in the result (the running app, the diff, the
summary) and collect:

```sh
node scripts/bench.mjs collect --task fix-last-page --project /tmp/peos-bench/fix-last-page --label v0-6 --scored 4/4
node scripts/bench.mjs compare v0-6 v0-7
```

A label names one state of PEOS (a version or a commit). Results are written to
`benchmarks/results/<label>/<task>.json`.

## What is recorded

| Field | Meaning |
| --- | --- |
| `tokens`, `byAgent` | Total tokens of the run and per agent, from the host's usage data |
| `reworkRounds` | Evaluation rounds after the first plus failed check runs: work done twice |
| `questions` | Lines under `## Answers` in `idea.md`: how often the user was asked |
| `decisions` | Distinct approvals the user gave |
| `carried`, `evaluations` | Evaluations recorded, and how many needed no model |
| `nonBlockingFindings` | Medium and low findings left in the last reports |
| `scored` | Scoring criteria met, judged by a person |
| `finished` | The run reached the release stage |

A run costs real tokens (a `large` run tens of millions), so a full set is run for a
change that can move the numbers, not for every commit. One run is one sample: models
vary, so a difference under about 20% in tokens or one scoring criterion is noise until
a second run repeats it.
