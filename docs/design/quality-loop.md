# PEOS — fewer decisions, enforced structure, judged design, measured cost

- Status: Implemented (increment 7f)
- Date: 2026-11-17
- Scope: extends [peos-next.md](peos-next.md) §5, [design-gate.md](design-gate.md) and
  [eval-economy.md](eval-economy.md)

## 1. Problem

A run should turn a plain request into a result its user does not have to read the code
of. Five things stood in the way:

- Token use was recorded per run only, so the costly agent could not be named.
- Nobody judged how a design looks. The designer wrote its preview unseen, and both
  evaluators were told not to judge taste; a generic look was caught only by the user.
- Structure and dependency rules were prose in the profile, judged by reading.
- A `large` run stopped four times (spec, architecture, design, plan), and each producer
  could ask its own questions.
- No fixed set of requests existed to compare PEOS before and after a change.

## 2. Decision

- **Usage per agent.** The host writes `agent-<id>.meta.json` with `agentType` beside
  each subagent transcript. A recorded call keeps that type as a fifth element;
  `status` lists agents by cost. `brief` omits the list: it is for the user.
- **Decision groups.** One approval decides a group of gates: all of them on `standard`
  (as before); on `large` the direction (spec, architecture, design), then the plan. A
  gate that is not the last of its group passes on its evaluation's PASS. Approving
  any gate also approves the earlier unapproved gates of its group.
- **Questions once.** The orchestrator asks the user-level choices at intake, in one
  round, and records them under `## Answers` in `idea.md`; producers do not ask those
  again and decide reversible details as agent defaults.
- **Enforced structure.** `architecture.md` gains "Structure", "Boundaries" (each
  dependency direction with what enforces it) and "Quality gates". A new application's
  walking skeleton declares test, lint (with the boundary rules), typecheck and
  format-check commands, which `setup` already turns into checks. Loosening or
  silencing a rule is blocking (and already a floor flag).
- **Judged design.** `rules/design-craft.md` states observable craft rules and the signs
  of a generated interface. A new evaluator `eval-design` (report `evaluator: design`,
  key `design`) replaces `eval-plan` focus `design`: it opens the preview rendered and
  blocks on the listed signs and on broken rendering. `peos-run` serves the one file
  from `scripts/serve-preview.mjs` on a loopback port derived from the run directory,
  with a policy that allows no script and no network; the state guard lets the
  evaluator's browser reach only that origin. Without a browser it judges the files in
  `degraded` mode instead of stopping the run. `eval-ui` applies the same signs to the
  built screens.
- **Shown interface.** `setup` writes the `preview` block when a root `dev`, `start` or
  `preview` script pins its port in its text (`--port 5173`, `-p 3000`), and a
  `ui-capture` check for a `ui:capture` script; a default port is never guessed. The
  architecture of an application with a user interface must name one of the two, so a
  new application's built screens are looked at by `eval-ui` without the user editing
  the configuration. `status` names the gate a bare `/peos:approve` decides.
- **The run's own change.** Entering implementation records a snapshot tree (`baseTree`).
  `changes` leaves out files that are as they were then (setup files, the user's
  uncommitted work) and everything under `.project-os/`; prose files raise no security
  trigger. Found in the first real run: the freshly written profile and `AGENTS.md` were
  in the diff every evaluator read, and the words "No auth" in the profile started a
  security evaluation of a one-line pagination fix.
- **Intake is counted.** Usage starts at the user's request that led to `peos-run init`
  in the session, not at the run's creation, so the profiler and investigator count.
- **Reference tasks.** `benchmarks/` holds four fixed requests with scoring lists and a
  fixture project; `scripts/bench.mjs` prepares a project, collects a finished run's
  numbers and compares two labelled sets ([benchmarks/README.md](../../benchmarks/README.md)).

## 3. Acceptance criteria

- AC-1: `sessionCalls` names the agent of each subagent call; a call a fork repeats
  stays the main session's; `status` prints the per-agent totals, `brief` does not.
- AC-2: A `large` run reaches its first `gate` action only after spec and architecture
  (and design, when present) passed; that action lists them all; one approval of the
  group's last gate approves them; the planner does not start before it.
- AC-3: A `standard` run behaves as before.
- AC-4: The design gate spawns `peos:eval-design` with a `preview url` that serves
  `design-preview.html` at `/` and nothing else; the server is reused after a revision
  and stopped when the design is approved.
- AC-5: A state recorded with the key `plan-design` is read as `design`.
- AC-6: `bench.mjs collect` reports tokens, per-agent tokens, rework rounds, questions
  and decisions of a run directory; `compare` prints them for two labels.
- AC-7: Existing tests pass; unit tests cover AC-1 to AC-6.

Non-goals: running a benchmark without a person (a run needs the user's decisions),
changing default models per agent (decide it from the first measurements), detecting
the host's browser tools from a script.

## 4. Risks

- Craft rules can make designs alike. A direction the user gave overrides a rule, and
  the rubric's "Not findings" keeps the evaluator off choices of palette and layout.
- With spec, architecture and design decided together, a rejected spec costs an
  architecture and a design that are written again. Intake questions aim at exactly
  the choices that would cause that.
- Enforcement depends on the stack having a lint or compiler mechanism; where it has
  none the architecture says "not enforced" and the code evaluator reads for it.
- The preview server is a child process of `peos-run`; it ends on approval, when its
  file is gone, or after half an hour without a request.

## 5. First measurement (2026-11-17)

`fix-last-page`, before the three fixes above: finished, 4/4 scoring criteria, no
question, no rework round, 0.9M tokens against a 1.5M budget (intake not yet counted,
about 0.06M more), 2.5 minutes. The orchestrating session used 85% of the tokens in 13
model calls, each re-reading the host's own base context; fewer orchestrator turns per
run is the next thing to measure before changing.

## 6. Full set (2026-11-17, label `2026-11-17-first`)

Run headless (`claude -p`), one session per task, results in `benchmarks/results/`.

| Task | Tier | Scored | Tokens (budget) | Rework rounds | Questions | Decisions |
| --- | --- | --- | --- | --- | --- | --- |
| fix-last-page | trivial | 4/4 | 0.9M (1.5M) | 0 | 0 | 0 |
| feature-tag-filter | small | 5/5 | 1.0M (3M) | 0 | 0 | 0 |
| refactor-http-routes | small | 4/4 | 1.3M (3M) | 0 | 0 | 0 |
| app-habits | large | 7/8 | 26.2M (30M) | 3 | 0 | 2 |

What the application run showed:

- The orchestrating session used 62% of the tokens (16.1M in 113 calls): its context is
  re-read on every turn and grows over a long run. No agent used more than 12%.
- The headless session had no browser, so `eval-design` judged the files (degraded) and
  `eval-ui` returned BLOCKED at every milestone until screenshots were supplied by hand.
  The evaluators driving a browser themselves is still not exercised.
- `eval-ui` ran on a milestone that changed no interface. Fixed: a passed UI evaluation
  now carries over a change without a UI trigger, except on the last milestone.
- A screenshot taken mid-repaint produced a false finding; the implementer could not
  reproduce it and changed the disabled button style instead, which `eval-code` quality
  then blocked as a departure from the approved design. Fixed in the implementer's
  instructions: a finding that cannot be reproduced is reported, not worked around.
- Both tasks expected as `small or standard` were classified `small`, so the single
  decision of a `standard` run is still not exercised by a real run.
- Medium findings stay in the result (a wrapping progress cell at 1280 px, literal CSS
  sizes, a duplicated dialog shell): only blocking findings go back to the implementer.
  Fixed (7h): once everything passed on the last milestone, `next` hands the medium
  findings of the current reports to the implementer in one polish round (`polish: done`
  in the state, so it happens once; a re-approved plan gets its own). What the round
  changes is checked and evaluated like any change; a finding that needs a decision is
  left and named. Low findings are not handed out.
