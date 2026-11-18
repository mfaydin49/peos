# PEOS — driving a run from a script (`peos-drive`)

- Status: Prototype (increment 7g): small runs measured; gates, questions and UI
  evaluation through the script are written but not yet exercised by a real run
- Date: 2026-11-17
- Scope: an alternative to the orchestrator skill; [peos-next.md](peos-next.md) is unchanged

## 1. Problem

In the first full set ([quality-loop.md](quality-loop.md) §6) the orchestrating session
used 62% of an application run's tokens and 85% of a small run's. The orchestrator
decides nothing: `peos-run next` names every step. But it is a model, so each step
re-reads its whole conversation, and a general Claude Code session starts at about
37,000 tokens of context before it has done anything.

## 2. Decision

`scripts/peos-drive.mjs` carries out the `next` loop as a program:

- **One session per agent.** Each agent `next` names is started as its own headless
  session with `claude -p --agent peos:<name>` and only its inputs, one per line. Such a
  session starts at about 4,500 to 6,000 tokens (measured) and runs on the agent's own
  model. Agents named together run in parallel.
- **No orchestrating model.** The script calls `peos-run` itself for `run` actions,
  writes `idea.md` and `investigation.md` word for word, parses the investigator's
  `Suggested`, `Trust boundary` and `Open` lines to classify, and the implementer's
  `STEP Sn: DONE` lines to mark steps done.
- **A writer for the two files a model must compose.** `task.md` and `summary.md` are
  written by a session with a four-line system prompt and the Read, Write and Glob tools.
- **The guard still holds.** The state guard receives the agent type in a session started
  with `--agent` (verified: `peos:eval-spec` writing outside its report is refused).
- **Decisions stay the user's.** `approve`, `revise` and `retry` record the grant
  themselves and refuse to run when `CLAUDECODE` is set, so a model cannot decide through
  the script. Questions (the investigator's `Open` line, a producer's
  `STATUS: QUESTIONS`) are asked on the terminal; without a terminal the agents take
  their recommendations and record them.
- **Usage.** The script records each session's tokens in the run's `usage.json` under
  the agent's name, so `status` and `bench.mjs` read both paths alike.
- **Browser.** Sessions start without MCP servers. `--mcp <config>` gives the UI and
  design evaluators that configuration (a Playwright server, for example); without it
  the design is judged from its files and a changed interface needs a `ui:capture` check.

```sh
node scripts/peos-drive.mjs start --project <dir> "<request>"   # also --tier, --type, --name
node scripts/peos-drive.mjs continue --project <dir> [--run <name>]
node scripts/peos-drive.mjs approve --project <dir> [--run <name>] [gate]
node scripts/peos-drive.mjs revise --project <dir> --gate <gate> "<feedback>"
node scripts/peos-drive.mjs retry --project <dir> <evaluation key>
```

Agents also answer the orchestrator more briefly on both paths: the implementer one
sentence per step, the investigator about 25 lines, producers three summary lines.

## 3. Measurement

`fix-last-page`, same fixture and request:

| Path | Tokens | Model sessions or calls | Result |
| --- | --- | --- | --- |
| Orchestrator skill, headless | 0.91M | 24 calls | 4/4, PASS round 1 |
| `peos-drive` | 0.20M | 6 sessions | 4/4, PASS round 1 |

The first row includes a security evaluation (0.05M) that no longer triggers and lacks
the intake (about 0.06M) that is now counted; the difference is the orchestrator.

Further runs (2026-11-17 and 2026-11-18), against the orchestrator skill on the same task:

| Task | Orchestrator skill | `peos-drive` | Scored |
| --- | --- | --- | --- |
| feature-tag-filter (driver ran it as `standard`, with its gate) | 1.0M | 0.4M | 5/5 → 5/5 |
| app-habits (`large`, two decisions, browser through `--mcp`) | 26.2M | 16.4M | 7/8 → 8/8 |

The application run's 16.4M includes 3.9M of four evaluation rounds that were thrown
away (see below); without them it is about 12.5M. `eval-ui` used 5.0M of the total and
`eval-code` 4.7M: with the orchestrator gone, looking at screens is the largest cost.
The polish round ran once at the end, and the UI evaluation of the milestone without
interface changes was carried.

What the application run found, all fixed:

- Playwright MCP writes `.playwright-mcp/` into the working directory, and the UI
  evaluator saved screenshots under names in the project root. Both changed the code
  state, so every report of the round was rejected as stale, twice per attempt.
  `peos-run` now adds the tool's directory to the repository's local exclude file when
  it starts a preview, and the state guard refuses a browser call that names a file.
- The guard refused Playwright's media emulation, so the dark scheme was not observed in
  the last round (`ui` passed in `degraded` mode). `emulate_media` is now allowed.
- Screenshots stay in an evaluator's context: the rubrics now cap a round at 8
  observations (5 images for the design) and read the accessibility tree once per screen.

## 4. Not done

- A real run through a gate, a question or a revision with the script.
- `--evidence-round`, and a UI evaluation with a browser given through `--mcp`.
- Messages are English; agent output follows the project's output language.
- One `usage.json` writer at a time is assumed.
