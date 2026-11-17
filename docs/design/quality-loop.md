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
