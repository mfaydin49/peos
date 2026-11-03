# PEOS — `peos-run next`, large tier and new applications

- Status: Implemented (increment 7a)
- Date: 2026-11-03
- Scope: extends [peos-v2-plugin.md](peos-v2-plugin.md) §5–§7, §10, §17

## 1. Problem

The orchestrator skill was about 260 lines of rules (plus `standard.md` and `resume.md`)
from which the main session derived, every turn, which agent to spawn next, with which
inputs, and when to stop. Field trials showed the cost: skipped or repeated steps, extra
rounds, and a large instruction text read again on every model call. The decision logic
was not testable without a paid model run.

The `large` tier and new applications (`app`) were not supported: a large run stopped
at intake, and an empty project could not even be set up, because setup required a
detectable test command.

## 2. Decision

`peos-run next --run <run>` owns the run's control flow. It reads the state, the run
files and the code state, applies every bookkeeping step that needs no outside work,
and returns exactly one action for the orchestrator. The orchestrator skill becomes
setup, intake and a loop:

```text
loop: next → do what it says → next
```

The large tier and `app` runs are added on top of that loop rather than as more rules.

## 3. Acceptance criteria

- AC-1: `next` returns one action (`do`: `spawn`, `run`, `write`, `gate`, `limit`,
  `blocked`, `stop`, `finished`) for every stage of `trivial`, `small`, `standard` and
  `large` runs, with every input path the agents need.
- AC-2: `next` applies, without being asked: entering the producer stages, the code
  map before planning, entering implementation (map and step marks), step completion
  given with `--done`, recording `pending-eval-*.json` reports, milestone completion,
  and entering the release stage.
- AC-3: A pending report that `record-eval` rejects is renamed to `rejected-eval-*.json`
  and the evaluator is spawned again with the error; a second rejection stops the run.
- AC-4: After `/peos:revise`, the producer is spawned with the user's feedback; the old
  artifact is not re-evaluated.
- AC-5: The third failed round and a plateau (same blocking findings two rounds in a
  row, kept as `evals/<key>.prev.json`) return `limit` with the blocking findings, also
  in a new session.
- AC-6: Failed check runs are counted in the state (`verifyFailures`); the third stops
  the run with the failing check IDs.
- AC-7: `large` runs decide the spec, architecture and plan gates separately; the new
  `peos:architect` writes `architecture.md`, `eval-plan` judges it with focus
  `architecture`; plan milestones (`M1`, `M2`…) run implement → verify → evaluate in
  order, with code evaluations split by focus and scoped to the criteria the finished
  milestones cover.
- AC-8: In an empty repository `setup` defers the configuration instead of failing; an
  `app` run passes its gates and enters implementation without one; the implementer may
  install the dependencies the approved architecture lists; before the first checks,
  `next` derives the configuration from the new manifests and binds it to the run; the
  profiler then describes the new project. Without a detectable test command the run
  stops.
- AC-9: The orchestrator skill holds setup, intake and the loop; `standard.md` and
  `resume.md` are gone; `/peos:continue`, `/peos:approve`, `/peos:revise` and
  `/peos:retry` continue through `next`.
- AC-10: Unit tests cover AC-1 to AC-8; the existing suite passes.

Non-goals: `eval-performance` and performance budgets, platform profiles (`web`, `ios`,
`android`), the release report and PR flow (increment 6), parallel implementers, the UI
evaluator ([eval-ui.md](eval-ui.md)).

## 4. Actions

Every action carries `run`, `directory`, `stage` and `applied` (the bookkeeping steps it
took, for the orchestrator's one-line progress messages).

| `do` | Fields | Orchestrator |
| --- | --- | --- |
| `spawn` | `agents`: list of `{ agent, model?, inputs, output? }`; `then` | Spawn every listed agent together, giving each its `inputs` as lines. Then follow `then`. |
| `run` | `command`, `args`, `timeoutMs` | Run that `peos-run` command (it runs project checks), then `next`. |
| `write` | `artifact`, `template`, `sources` | Write the artifact from the template and sources, then `next`. |
| `gate` | `gates`, `artifacts` | Show the producers' summaries and end the turn: `/peos:approve` or `/peos:revise`. |
| `limit` | `key`, `round`, `plateau`, `blocking` | Show the findings and the options `/peos:retry <key>`, `/peos:revise`, stop. |
| `blocked` | `key`, `notAssessed` | Say what could not be assessed and ask the user. |
| `stop` | `code`, `message` | Tell the user the message and end the turn. |
| `finished` | `summary` | The run is at the release stage with its summary: final report. |

`then` says what to call after the agents return: `next` after producers and
evaluators, and `next --done <steps the implementer reported DONE>` after an
implementer. Questions from a producer (`STATUS: QUESTIONS`) and a step reported
`BLOCKED` stay with the orchestrator: it asks the user and spawns again with the
answers.

## 5. Control flow

1. Record each `pending-eval-*.json` in the run directory (AC-3).
2. `done`/`stopped` → `finished`/`stop`.
3. For each gate of the tier, in order: an approved, fresh gate is passed. Otherwise
   the run enters that stage; a missing artifact, or one unchanged since a revision
   request, spawns the producer; a missing or stale evaluation spawns the evaluator
   (with the previous blocking findings on a later round); a fresh `FAIL` spawns the
   producer with its findings unless the round limit or a plateau is reached; a fresh
   `BLOCKED` returns `blocked`; a fresh `PASS` returns `gate`. A `standard` run passes
   the spec on its `PASS` and decides spec and plan together at the plan gate.
4. All gates hold: the steps come from `plan.md` (`### S<n>`) or `task.md` (`- S<n>:`),
   the milestones from `plan.md` (`- M<n>: … — steps: S1, S2`); smaller tiers have one
   implicit milestone. The run enters implementation; a refactor records its baseline
   first; an `app` run past its first milestone without a profile spawns the profiler.
5. Unfinished steps of the current milestone → the implementer, one batch.
6. All its steps done: checks not recorded for the current code state → `run finish`
   (an `app` run without configuration first gets it from `setup`); recorded and
   failing → the implementer with the failing checks, or `stop` after the third
   failure.
7. Checks pass: every required code evaluation (`code-all`, or the three foci on
   `large`; `security` when triggered or recorded before; every other recorded one)
   that is missing or stale is spawned together; a fresh `FAIL` sends all blocking
   findings to the implementer; limits and `BLOCKED` as in 3.
8. All pass: on `large`, the milestone is marked done and the next one starts at 5.
   After the last, the run enters the release stage and `summary.md` is written
   (`write`), then `finished`.

`--evidence-round` makes step 7 spawn the failed evaluators again on the unchanged code
with their previous report instead of the implementer, for findings that only lack
check evidence.

Recovery rules (from the review of this increment):

- A `BLOCKED` evaluation returns `blocked`; `/peos:retry <key>` runs the evaluator again
  with the user's answer. After `/peos:retry` on a `FAIL`, the cleared report
  (`evals/<key>.reset.json`) goes back to the producer or implementer while the work is
  unchanged.
- A non-PASS evaluation at round 3 returns `limit` even after the work changed by hand,
  until the user types `/peos:retry`.
- Completing a milestone before the last clears the code evaluations, so the next
  milestone's evaluation always runs and the release evidence judges every criterion.
- Re-approving a plan after implementation started resets the steps, milestones, code
  evaluations and `summary.md`.
- At the release stage, code that changed since sends the run back to `verify`.
- Checks that change files Git sees (no code state) stop the run with `UNSTABLE`
  instead of running again.

## 6. New applications

- Setup in a repository with no manifest and no source files (only dotfiles, `README`,
  `LICENSE`, `docs/`, instruction files) returns `config: "deferred"` instead of failing.
  Only an `app` run can proceed; any other type stops with the setup message.
- An `app` run is always `large`. Its architecture names the stack and every
  dependency; approving the architecture gate is the user's consent to install exactly
  those. The planner makes `M1` a walking skeleton whose first step creates the
  manifests, `.gitignore` and a root test command with one passing test.
- Entering implementation without a configuration is allowed only for an `app` run in an
  empty repository (`bootstrap: true`); the configuration is bound on entering `verify`, after `setup`
  derived it from the manifests M1 created. The model never writes check commands.
- The repository still needs one commit (`git commit --allow-empty -m "Initial commit"`):
  code-state evidence is bound to `HEAD`.

Residual risk: the implementer writes the manifests from which the checks are derived,
so a weak test script becomes a check. `eval-code` with focus `tests` judges the
skeleton's tests, and the floor guard flags common weakening.

## 7. State changes

Optional `state.json` fields: `milestones` (`M<n>` → `done`), `verifyFailures`
(integer), `bootstrap` (boolean). A `revision_requested` gate keeps the artifact hash
it was requested on. Schema version stays 1: older runs remain valid.
