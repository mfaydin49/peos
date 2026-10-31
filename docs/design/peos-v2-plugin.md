# PEOS v2 — Claude Code plugin design

- Status: Draft for review
- Date: 2026-10-29
- Scope: toolkit design; no implementation in this document
- Supersedes: the version-one limits listed in [§2](#2-decision-revisiting-version-one-limits)

## 1. Purpose

Turn any request — an idea for a new app (web, mobile, desktop, backend), a feature,
a change, a defect, a refactor — into a release-ready change through a gated,
evidence-based pipeline:

```text
idea → well-defined request (spec) → plan → code + tests → evaluators → release report
```

Every stage between the human gates runs without prompting. Production deployment
is never performed by an agent; it requires a human approval enforced outside the
model ([§12](#12-human-gates-and-release-safety)).

Goals:

- One entry point (`/peos:start`) for every task type and size.
- Ceremony proportional to risk: a one-line fix does not pay for a full pipeline.
- Independent evaluation: evaluators run in fresh contexts and cannot edit code.
- Machine-checkable evidence: a PASS is tied to the exact code state it judged.
- Bounded cost: deterministic tools first, LLM judgment only where tools cannot decide.

Non-goals:

- Autonomous production deployment, store submission, or production data changes.
- A large catalog of skills/agents for unrelated domains.
- Replacing project tools (test runners, linters, scanners, CI).
- A custom MCP server in the first releases ([§15](#15-host-adapters-and-mcp)).

## 2. Decision: revisiting version-one limits

Version one deliberately shipped *no hooks, agents, command registry or plugin
package*, and its release workflow *ends at a report*. Those limits kept the toolkit
small and honest, but they leave the pipeline dependent on the model remembering
every step, and they cannot provide independent review.

Decision:

| Version-one limit | v2 | Reason |
| --- | --- | --- |
| No agents | Small fixed agent roster | Independent evaluation needs fresh contexts |
| No hooks | Few, readable hooks with profiles | Gates must not depend on model memory |
| No commands / plugin | Claude Code plugin with `/peos:*` commands | Single, discoverable entry point |
| Release ends at a report | **Unchanged** for production; PR/staging allowed | Production stays a human action |
| Codex-only integration | Claude Code primary, Codex secondary | Hooks and subagents exist in Claude Code |

Kept unchanged: the authorization model, deterministic `verify`, suppressed raw logs,
lexical reference containment, explicit project root, and honest reporting of what
was and was not verified.

Reconsider if: hook overhead measurably slows normal work, evaluators do not catch
defects on the reference projects ([§17](#17-implementation-increments)), or the
host removes a mechanism this design depends on ([§18](#18-host-assumptions)).

## 3. Principles

1. **Single writer.** At any moment exactly one agent may change project code.
   Parallel agents only read.
2. **Evaluators are read-only.** They have no write tools; their report is their
   final message, which the orchestrator persists.
3. **Deterministic before LLM.** Tests, lint, type checks, coverage and scanners run
   once through `verify`; evaluators judge their results instead of rerunning them.
4. **Proportional ceremony.** A size classifier selects stages and evaluators.
5. **Evidence is bound to code state.** Every report records the code fingerprint it
   judged; a changed fingerprint invalidates it.
6. **Human gates are enforced by the host, not by instructions**, wherever the host
   allows it.
7. **Small and explicit.** Agents are invoked only by the orchestrator; no
   "use proactively" triggers.
8. **Measure, don't claim.** Cost and effectiveness claims require measurements on
   reference projects.

## 4. Architecture

```text
┌──────────────────────── Claude Code plugin "peos" ────────────────────────┐
│ commands/   /peos:start /peos:approve /peos:revise /peos:continue ...     │
│ skills/     orchestrator, stage skills, platform profiles                  │
│ agents/     spec-writer, architect, planner, implementer, evaluators       │
│ hooks/      gate enforcement, approval capture, write guards               │
│ rules/      shared policy (loaded per agent, not globally)                 │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ Bash
┌───────────────────────────────▼───────────────────────────────────────────┐
│ core scripts (Node, no runtime deps)                                       │
│ peos-run (state, gates, fingerprint) · verify · check-changed-files        │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ files
┌───────────────────────────────▼───────────────────────────────────────────┐
│ consuming project                                                          │
│ .project-os/engineering.config.json · .project-os/runs/<id>/ · docs/decisions/ │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Orchestrator** = the main session following the `orchestrator` skill.
  Subagents can nest (up to three levels by default), but orchestration stays in the
  main session so human gates, approvals and progress are visible in the user's
  conversation. Worker agents omit the `Agent` tool so they cannot delegate further.
- **Core scripts** own every machine-readable file. Agents never write `state.json`.
- **Intelligence** lives in agents and skills; scripts stay deterministic.

## 5. Pipeline

```text
 Intake ── classify size & task type (one line, user may override)
   │
 [S] spec-writer ──► eval-spec ── FAIL → revise (≤3 rounds)
   │                              PASS
   ▼                         👤 GATE spec
 [A] architect ──► eval-plan(architecture)      (large tier only)
   │                         👤 GATE architecture
 [P] planner ──► eval-plan ── FAIL → revise
   │                          PASS
   ▼                         👤 GATE plan
 [I] implementer: for each plan step → code + tests → verify(task, targeted) → checkpoint
   │
 [V] verify(task, full)  → checks.json
   │
 [E] evaluators in parallel (selected by tier and triggers)
   │   FAIL → findings to implementer → rerun only affected evaluators (≤3 rounds)
   ▼   all PASS
 [R] release report: READY / NOT READY / BLOCKED   (+ optional PR)
   │
 👤 Production deployment — human only, outside the agent (§12)
```

| Stage | Producer | Evaluator | Gate | Artifacts |
| --- | --- | --- | --- | --- |
| Intake | orchestrator | — | — | `state.json` |
| Spec | `spec-writer` | `eval-spec` | human | `spec.md` (or `task.md`), `evals/spec.json` |
| Architecture | `architect` | `eval-plan` | human | `architecture.md`, `docs/decisions/*` |
| Plan | `planner` | `eval-plan` | human | `plan.md`, `evals/plan.json` |
| Implement | `implementer` | targeted `verify` per step | automatic | code, tests, checkpoint commits |
| Verify | `verify` script | — | automatic | `checks.json` |
| Evaluate | — | code/security/performance | automatic | `evals/*.json` |
| Release | orchestrator + `peos-release-check` | — | report only | `summary.md` |

Large-tier plans are split into milestones (`M1`, `M2` …). Stages I–E repeat per
milestone; each milestone must be runnable and testable on its own.

## 6. Size classification

Adapted from ECC's `orch-pipeline`. Score three signals; the highest tier any signal
reaches wins. State the result in one line; the user may override with `--tier`.

| Tier | Files touched | New dependency / contract | Design ambiguity |
| --- | --- | --- | --- |
| `trivial` | 1, a few lines | none | none |
| `small` | 1 file / function | none | clear after reading code |
| `standard` | 2–5 files | internal module | one real choice |
| `large` | many / cross-cutting / new app | external dependency, public API, new platform | several open questions |

Tie-breakers: a security trigger ([§9](#9-evaluators)) or a public API/contract
change is at least `standard`. A new application is always `large`.

| Tier | Spec | Spec gate | Architecture | Plan gate | Evaluators |
| --- | --- | --- | --- | --- | --- |
| `trivial` | `task.md` (short) | no | no | no | `eval-code` (focus `all`) |
| `small` | `task.md` (with inline plan) | no | no | no — proceeds automatically | `eval-code` + triggered |
| `standard` | `spec.md` | yes | no | yes | `eval-code` + triggered |
| `large` | `idea.md` + `spec.md` | yes | yes | yes | split `eval-code` foci + security + performance (if budgets exist) |

"Triggered" means `eval-security` when a security trigger matches and
`eval-performance` when the project defines budgets and relevant code changed.

`trivial` and `small` runs have no human gate before the release report. They stay
safe because the classifier's tie-breakers push any security-trigger or contract
change to `standard`, and because commits, pushes and deploys keep their own approvals
(§12). If implementation reveals more scope than classified, the run is reclassified
and stops at the gates of the new tier.

## 7. Task types and first-move rules

| Type | Trigger | First move |
| --- | --- | --- |
| `app` | new application from an idea | idea → spec; platform profile selection; walking skeleton milestone |
| `feature` | capability does not exist | spec with acceptance criteria |
| `change` | works, but desired behavior differs | update behavior **and** its existing tests |
| `fix` | behavior is wrong | reproduce as a failing test, then fix |
| `refactor` | behavior stays, structure improves | tests green before and after every step; no behavior change (enforced below) |

The orchestrator infers the type and states it with the tier; ambiguity is asked once.

Refactor runs get extra rules, and only refactor runs (other types pay nothing):

- After entering `implement` and before any code change, `peos-run record-baseline`
  records the full task checks on exactly the code state the run entered `implement`
  with (`baseCodeState`, so pre-existing local files do not block it); it refuses once
  code has changed. Recovery is restoring that state or starting a new run;
  `status` and the session-start hook flag a refactor without a baseline. A failing baseline stops the run: the existing
  checks must be green before restructuring. Release refuses a refactor without a full
  PASS baseline for the run's base commit and configuration.
- `changes` lists `modifiedTests`: existing test files changed or removed since the
  base, across common layouts including snapshots and golden files; pure moves are not
  listed. `eval-code` treats any change to their assertions, inputs or expected values
  as blocking; accepted mechanical edits are reported together as one low finding.
  The baseline covers task-phase checks; release-phase checks still run before `done`.
- The planner puts characterization tests first where existing tests do not pin the
  behavior to be preserved; the rubric blocks observable behavior changes the spec does
  not list.
- Large refactors and whole-project modernization are split: a discovery run produces
  a roadmap and decisions, then each step is its own small refactor run (with the large
  tier, increment 7).

## 8. Agents

All agents are plugin-scoped and spawned as `peos:<name>` (e.g. `peos:planner`). Each
loads only the rules it needs.

| Agent | Role | Tools | Model | Writes |
| --- | --- | --- | --- | --- |
| `profiler` | project → `.project-os/project-profile.md` (facts agents need first); writes `AGENTS.md` (and a `CLAUDE.md` import) when missing | Read, Grep, Glob, Write | mid | only those files (guarded) |
| `investigator` | request → affected code, current behavior, root cause (fix), size and trust-boundary signals for classification | Read, Grep, Glob | mid | no |
| `spec-writer` | idea/request → spec; records reversible defaults as decisions, asks only user-level choices in one round | Read, Grep, Glob, Write | strongest | only `<run>/spec.md` (guarded) |
| `architect` | platform, stack, data model, components, ADR proposals | Read, Grep, Glob, docs lookup | strongest | no |
| `planner` | spec → ordered steps with files, AC coverage, tests | Read, Grep, Glob, Write | strongest | only `<run>/plan.md` (guarded) |
| `implementer` | plan steps in order (one agent per batch, not per step): code + tests, targeted verify | Read, Grep, Glob, Edit, Write, Bash | mid | **yes** (project code only) |
| `eval-spec` | spec quality | Read, Grep, Glob, Write | mid | only its `<run>/pending-eval-<name>.json` (guarded) |
| `eval-plan` | plan/architecture quality | Read, Grep, Glob, Write | strongest | only its `<run>/pending-eval-<name>.json` (guarded) |
| `eval-code` | `focus`: `acceptance` \| `quality` \| `tests` \| `all` | Read, Grep, Glob, Write | mid | only its `<run>/pending-eval-<name>.json` (guarded) |
| `eval-security` | security review + scanner results | Read, Grep, Glob, Write | strongest | only its `<run>/pending-eval-<name>.json` (guarded) |
| `eval-performance` | measurements against budgets | Read, restricted Bash, browser/simulator | mid | no |

Notes:

- The test-authoring responsibility stays inside `implementer` (tests are
  written with the code, derived from acceptance criteria); `eval-code` with focus
  `tests` judges them. A separate test author is added only if evaluation shows
  implementer-written tests are systematically weak.
- One `eval-code` agent with a `focus` parameter replaces three near-duplicate agents;
  the large tier calls it once per focus, smaller tiers once with `all`.
- Code evaluators get no Bash (decided in increment 5, replacing "restricted Bash"):
  `peos-run record-checks` runs the configured checks, including scanners of kind
  `security`, once per code state, and `peos-run changes` writes the diff; evaluators
  read `checks.json` and `changes.diff`. Plugin agents cannot scope Bash per agent
  ([§18](#18-host-assumptions) item 15), so no Bash is the only reliable read-only.
  `eval-performance` (increment 7) will need measurements and is designed then.
- `implementer` may write project code and run commands but not `.project-os` or
  `peos-run` (state-guard, by `agent_type`).
- Every agent lists `Agent` in `disallowedTools` (no nested delegation), and evaluators
  also disallow `Edit`, `Write` and `NotebookEdit`.
- Model names are configured per agent (`model:`); "strongest/mid" map to the current
  model family at implementation time.

## 9. Evaluators

### Common contract

Input (prepared by the orchestrator, never the whole repository):

- the artifact under evaluation (spec, plan, or diff via `check-changed-files`);
- acceptance criteria with IDs;
- `checks.json` and scanner results;
- the rubric for the evaluator (`rules/eval-<name>.md`).

Output: one JSON object ([§10.3](#103-eval-report)). Rules adopted from ECC's reviewers:

- Report only findings with high confidence (>80%); skip a documented list of
  common false positives.
- Do not withhold PASS to appear rigorous; a clean input gets PASS with zero findings.
- Severity `critical` or `high` blocks; `medium` is reported and fixed when cheap;
  `low` is informational.
- If a required tool (browser, simulator, scanner) is unavailable, report
  `mode: "degraded"` and what could not be assessed — never imply a live test.

### Rubrics

| Evaluator | Blocks when |
| --- | --- |
| spec | an acceptance criterion is not observable/measurable; scope or non-goals missing; an open decision is unresolved; a requirement was invented |
| plan | an AC is not covered by any step; wrong dependency order; parallel steps overlap in files; unnecessary steps/abstractions; missing test per step; unapproved dependency |
| code · acceptance | an AC lacks concrete evidence (test name, screenshot, measurement) |
| code · quality | dead/obsolete code, needless abstraction, violation of project conventions, behavior change outside scope |
| code · tests | a critical scenario/edge case untested; tests mirror implementation; (when configured) surviving mutants in changed code |
| security | secret exposure, missing authn/authz/ownership check, unvalidated input at a boundary, injection, known critical vulnerability |
| performance | a configured budget is exceeded; without budgets it reports `not-assessed`, never a guess |

Security trigger list (deterministic, from changed paths and diff hunks): authentication
or authorization, user-input handling, database queries, file-system paths, external
API calls, cryptography, secrets/credentials, dependency manifests.

### Loop control

- At most 3 consecutive non-PASS rounds per evaluation key; a PASS starts a new
  series. At the limit `record-eval` refuses further reports for that key until the
  human chooses to continue (`peos-run reset-eval`, reserved like `approve`).
  Per-milestone round series arrive with milestones (increment 7).
- Stop early on plateau: same blocking findings two rounds in a row.
- After a fix, rerun only evaluators whose inputs changed (by fingerprint and paths).

## 10. Files

### 10.1 Run directory

`.project-os/runs/<YYYY-MM-DD>-<slug>/`

| File | Tiers | Writer | Git |
| --- | --- | --- | --- |
| `task.md` | trivial, small | orchestrator | commit |
| `idea.md` | large | orchestrator (user's words, unedited) | commit |
| `spec.md` | standard, large | `spec-writer` | commit |
| `architecture.md` | large | orchestrator from `architect` | commit |
| `plan.md` | standard, large | `planner` | commit |
| `summary.md` | all | orchestrator | commit (becomes PR body) |
| `usage.json` | all | `usage-record` hook (token use per session) | ignore |
| `state.json` | all | `peos-run` script only | ignore |
| `checks.json` | all | `peos-run record-checks` (runs `verify`) | ignore |
| `evals/<key>.json` | all | `peos-run record-eval` from the evaluator's report | ignore |

`peos-run init` writes a run-local `.gitignore` for the ignored files, plus
`pending-eval-<name>.json`, where an evaluator writes its report (removed by `record-eval` once recorded; `pending-eval.json` remains for manual use and is never removed) before
`record-eval` reads it. Run files are
read and written only as regular files inside real directories; symlinks are refused.

### 10.1a Project files

| File | Writer | When |
| --- | --- | --- |
| `.project-os/engineering.config.json` | `peos-run setup`, from the project's manifests only | missing at `/peos:init` or a new run; never overwritten |
| `.project-os/project-profile.md` | `profiler`; first line records the commit | missing, or stale (≥ 25 changed files or a manifest change since that commit) |
| `AGENTS.md` | `profiler` | missing; never overwritten (the guard allows creating it only) |
| `CLAUDE.md` (`@AGENTS.md`) | `profiler` | created together with `AGENTS.md` when also missing, so Claude Code loads it |

Created files stay uncommitted for the user to review. The configuration is derived
by a script, not written by a model, so the commands `record-checks` runs are the
project's declared ones; the user decided (2026-10-30) that writing it needs no
approval.

Durable decisions are copied to `docs/decisions/NNN-<slug>.md` using the existing
decision template. Small implementation choices are not recorded.

Markdown artifacts use fixed headings from `templates/` so agents and scripts find
sections reliably. IDs: acceptance criteria `AC-n`, plan steps `Sn`, milestones `Mn`,
findings `Fn`. Each plan step lists files, covered ACs, tests and dependencies.

### 10.2 `state.json`

```json
{
  "schemaVersion": 1,
  "run": "2026-10-29-avatar-upload",
  "type": "feature",
  "tier": "standard",
  "stage": "evaluate",
  "gates": {
    "spec": { "status": "approved", "by": "human", "artifactHash": "sha256:…", "at": "…" },
    "plan": { "status": "approved", "by": "human", "artifactHash": "sha256:…", "at": "…" }
  },
  "steps": { "S1": "done", "S2": "done", "S3": "done" },
  "evals": {
    "spec": { "verdict": "PASS", "round": 1, "subject": "sha256:…" },
    "code-all": { "verdict": "FAIL", "round": 1, "subject": "fp:…" }
  },
  "checkpoints": ["<commit sha>"],
  "createdAt": "…",
  "updatedAt": "…"
}
```

On first entry into `implement` the run also stores `configHash` (the configuration in
force; entering `implement` without one fails with `CONFIG_MISSING`) and `baseHead`
(the commit the change starts from; `changes` diffs against it, so commits made during
the run stay visible to evaluators). Later stages refuse a run without this binding.

Contract: [schemas/state.schema.json](../../schemas/state.schema.json). Writes are
atomic (fsynced temp file + rename) and serialized by `state.lock`.

Freshness rules:

- An approval holds only while its artifact hash is unchanged **and** every earlier
  gate holds.
- A new approval of a gate reopens every later gate and discards their evaluations;
  later artifacts must be re-evaluated against the new upstream.
- `implement`, `verify` and `evaluate` need all tier gates fresh. `release` needs a
  full PASS `checks.json` (either phase) and PASS code evaluations, all on the current
  fingerprint; `done` needs the same with release-phase checks. Every tier needs at
  least one `code-*` evaluation; `large` needs `code-acceptance`, `code-quality` and
  `code-tests`.

### 10.3 Eval report

```json
{
  "schemaVersion": 1,
  "evaluator": "code",
  "focus": "acceptance",
  "verdict": "PASS | FAIL | BLOCKED",
  "mode": "full | degraded",
  "subject": "fp:…",
  "criteria": [{ "id": "AC-1", "status": "met | not_met | not_assessed", "evidence": "…" }],
  "findings": [{ "id": "F1", "severity": "critical | high | medium | low", "file": "…", "line": 0,
                 "problem": "…", "impact": "…", "fix": "…" }],
  "notAssessed": ["…"]
}
```

Contract: [schemas/eval-report.schema.json](../../schemas/eval-report.schema.json).
`subject` is what was judged: `sha256:` of the artifact for spec and plan evaluations,
the code fingerprint (`fp:`) for the others. `record-eval` rejects a report whose
subject is not current. The state key is `<evaluator>[-<focus>]`, e.g. `code-acceptance`.

The fingerprint (`peos-run fingerprint`) hashes HEAD plus the working-tree content of
every path that differs from HEAD: staged, unstaged, untracked, assume-unchanged and
skip-worktree. Decisions: gitignored files are excluded (local environment and build
output are not code state), `.project-os/runs/` is excluded (evidence must not change
the state it describes), and a changed submodule or untracked nested repository makes
fingerprinting fail rather than silently ignoring its contents. A SHA alone is not
freshness evidence (existing toolkit rule).

### 10.4 `checks.json`

The existing `verify --json` report, persisted instead of printed, plus `codeState`:
the fingerprint, or `null` when the code changed while the checks ran.
Configured checks gain an optional `kind` (`test | lint | typecheck | build |
security | performance | coverage | mutation`) so gates can ask "did a security
check run on this code state?" mechanically.

## 11. Hooks

Few hooks, each a separate script under `hooks/` (no inline code), each fast and
side-effect-free except where stated.

| Hook | Event | Behavior | Profile |
| --- | --- | --- | --- |
| `approval-capture` | UserPromptSubmit | When the whole prompt is `/peos:approve <gate> [run]`, `/peos:revise <gate> [--run <name>] …` or `/peos:retry <key> [run]` writes `.project-os/runs/.grant.json` (action, target, run, time, source `user-prompt`), bound to the named run (it must resolve) or else the most recently updated unfinished run. | all |
| `state-guard` | PreToolUse (Edit, Write, MultiEdit, NotebookEdit, Bash) | Allowlist: under `.project-os/runs/` write tools may change only `<run>/{task,idea,spec,architecture,plan,summary}.md` and `<run>/pending-eval.json` / `pending-eval-<name>.json` (case-insensitive; paths canonicalized through symlinks and letter case). A Bash command that touches `.project-os` by text or working directory is allowed only as a plain call (no shell operators) of this plugin's own `peos-run.mjs`, and never its `grant` action, however quoted. PEOS agents (`agent_type` `peos:eval-*`, `peos:spec-writer`, `peos:planner`, `peos:investigator`, `peos:profiler`) get no Bash or edit tool; `Write` only to their own output (spec-writer `<run>/spec.md`, planner `<run>/plan.md`, evaluators `<run>/pending-eval-<own name>[-<focus>].json` in an existing run, profiler the profile and a missing `AGENTS.md`/`CLAUDE.md`; investigator nothing). | all |
| `release-guard` | PreToolUse (Bash) | Denies configured deploy/publish/push-to-protected commands unless the release report is READY for the current code state; never grants approval itself. | standard, strict |
| `gate-stop` | Stop | Only for a session that ran `peos-run` for the run itself (`--run`/`--name` in its own Bash calls; mentions in context or listings do not count): if the most recently updated unfinished run of that session is at an unapproved gate stage whose artifact was written within the hour and has no evaluation of its current content, blocks once (marker `.stop-block` per artifact hash, and `stop_hook_active`). Does not block while the gate's evaluator, launched in the background after the artifact was written, has not handed back yet; a foreground result counts as finished. Transcripts above 64 MiB are skipped. | standard, strict |
| `usage-record` | Stop | For the most recently updated unfinished run the session ran `peos-run` for: merges the session's model calls since the run began (main and subagent transcripts, keyed by message id so resumed and forked copies count once; skipped above 64 MiB) into `<run>/usage.json`, without the state lock; at the release stage only for 15 minutes after the last state change. Never blocks. | standard, strict |
| `session-resume` | SessionStart | Adds one line per unfinished run (up to three): stage and next gate. | standard, strict |
| `fact-gate` (optional) | PreToolUse (Edit) | ECC GateGuard idea: first edit of a file requires listing its importers/contracts. Off by default; evaluated before enabling. | strict |

Profiles (`minimal | standard | strict`) are a plugin user option. `minimal` keeps only
the guards that protect approvals and state integrity.

## 12. Human gates and release safety

| Gate | Enforcement | Strength |
| --- | --- | --- |
| spec, architecture, plan | `peos-run approve`/`revise`/`reset-eval` consume a grant that matches action, target and run and is at most 15 minutes old; every attempt claims it atomically (one consumer wins) and consumes it, so a refused approval cannot be reused for an artifact the user has not seen. Inside Claude Code (`CLAUDECODE` set) only `user-prompt` grants count and `peos-run grant` refuses; `state-guard` blocks the model from writing grants or state | hook-enforced against ordinary tool use; see residual risks below. Optional extra: a project `permissions.ask` rule on `peos-run.mjs approve` adds a host prompt |
| checkpoint commits | approved once at plan approval for the run's branch (`standard`, `large`); `trivial`/`small` runs make no checkpoint commits | workflow guidance + host permission prompt |
| push / PR | project permission rule `ask` | host-enforced prompt |
| production deploy | (1) permission `ask` rules for deploy commands, (2) `release-guard`, (3) CI environment protection with required reviewers | (3) is outside the machine and the strongest |

Threat model. The hooks are guard rails against a model taking shortcuts with ordinary
tool use: editing state or evidence directly, approving its own gates, skipping an
evaluation. They are not a security boundary against a model that deliberately evades
them; the same process can always reach the same files somehow. Projects that need a
real boundary run Claude Code's sandbox and permission rules on top, and keep production
decisions outside the machine (§12 deploy row).

Residual risks of the grant design, accepted for increment 4 and documented:

- `UserPromptSubmit` also fires for scheduled task runs (including `/loop`), background
  subagent reports and other sessions' messages. A prompt that is exactly a decision
  command from such a source would create a grant; wrapped reports and ordinary text
  do not match. A model that schedules a task whose prompt is `/peos:approve …` could
  forge one; projects that need more add the `permissions.ask` rule above.
- Shell inspection is pattern-based. Indirection — a script or environment variable
  that builds the path itself (`node /tmp/x.mjs`, `NODE_OPTIONS=--require …`) — can
  write files the guard does not see. Full containment needs the host sandbox.
- Globs that avoid every recognizable name (e.g. `.p*/r*/*/s*`) are not detected.
- The model can edit `.project-os/engineering.config.json`, for example to weaken a
  check. Since increment 5 the run records the configuration's hash when it enters
  `implement`, and release refuses checks recorded under a different configuration.
  Editing the configuration before implementation starts is not detected; the user
  sees it in the change list (`changes`) and the diff.
- The configuration binding covers `.project-os/engineering.config.json` only. A
  check that calls a project script (`npm test`) can be weakened through that script
  (`package.json`, test configuration). Since increment 5c the floor guard in `changes`
  flags the common forms deterministically (skipped or focused tests, removed
  assertions, deleted tests, suppression comments, empty `catch`/stubs, changed
  coverage thresholds in known config files) and `eval-code` must justify or block
  each; other forms remain visible only in the diff.
- The main session could edit project code itself instead of the implementer; that
  keeps evaluator independence procedural, like the next item.
- Evaluators write their reports themselves (since 5f), but the main session could
  still write a `pending-eval-*.json` and record its own PASS. Evaluator independence is procedural; the
  subject check only proves the report names the current artifact or code state.
- Bash cannot read run files either; the model uses the Read tool or `peos-run status`.
  A user who wants raw evidence can open the files directly.
- On hosts without hooks (Codex, a terminal), `peos-run grant` records the decision and
  gates are instruction-level only.

Policy: agents may open a PR and, if the project configures it, deploy to a staging
environment. Production deployment happens only through the protected CI environment
after a human approval. `peos:init` proposes the permission rules and a CI template;
it never applies settings or creates remote resources without explicit approval.

## 13. Concurrency and write safety

- Implementer steps run sequentially by default. Parallel steps are allowed only when
  the plan declares disjoint file sets, `eval-plan` confirms it, and each runs in its
  own git worktree; the orchestrator merges and stops on conflicts. Not in the first
  increments.
- `verify` runs once per code state; evaluators read `checks.json`. Performance
  evaluation runs alone, after other evaluators, to avoid measurement noise.
- Planned, not yet implemented (increment 5 keeps all changes uncommitted in the working
  tree for the user to review): in `standard` and `large` runs each completed step is a local checkpoint commit on
  the run branch (never pushed by the agent), so a bad step is reverted without losing
  the run. When the PR is prepared, checkpoints are squashed into one conventional
  commit per run (per milestone for `large`), with `summary.md` as the message body.
  The squash is shown in the PR approval request; it rewrites only the unpushed run
  branch.

## 14. Cost controls

- Tier-based stage and evaluator selection (§6) and trigger-based security/performance.
- Evaluators receive the diff, ACs and results — not the repository.
- Rules split per agent; `authorization.md` and other long rules are condensed.
  Common prompt-defense text lives once in `rules/`, not in every agent.
- Short JSON reports, capped findings per evaluator.
- Stable agent/rule text to benefit from prompt caching.
- Measurement: per-run usage recorded from the host's native usage data where
  available ([§18](#18-host-assumptions) item 13); no estimated token claims.

## 15. Host adapters and MCP

- **Claude Code**: primary target; full plugin.
- **Codex**: existing `setup-codex` keeps linking stage skills; no hooks or subagents,
  so gates there remain instruction-level. Documented as weaker enforcement.
- **MCP**: not built now. Reconsider when Claude Code and Codex must share live run
  state, or another client (IDE, dashboard) needs it. It would wrap the core scripts
  only. Existing MCP servers (browser automation, simulators, GitHub, docs lookup)
  are used where installed, subject to the authorization rules.

## 16. Platform profiles

`skills/peos-profile-<platform>/`. First profiles: `web`, `ios`, `android`.
`desktop` and `backend` follow on demand. Each profile provides:

- default `checks` (test, lint, typecheck, build) for common stacks of that platform;
- recommended security/performance tools (e.g. secret scan, dependency audit, SAST,
  Lighthouse, platform profilers) — proposals only, since adding a tool is a
  dependency change requiring approval;
- UI verification method (browser, simulator/emulator, desktop automation);
- performance budget template.

`/peos:init` detects the platform and writes the configuration from the project's
manifests without asking (decided 2026-10-30); since increment 5e it also writes the
project profile and `AGENTS.md` when missing (§10.1a). Permission rules and CI
templates remain increment 6.

## 17. Implementation increments

Each increment is independently usable and verified before the next.

| # | Increment | Done when |
| --- | --- | --- |
| 1 | Templates and schemas: run templates, `state` and `eval` schemas, config `kind` field | **done 2026-10-29**: schemas compile under Ajv strict and agree with runtime validators; templates in `templates/run/` (referenced from skills in increment 3) |
| 2 | `peos-run` core: init, status, fingerprint, gate transitions, atomic state, persisted `checks.json` | **done 2026-10-29**: integration tests for transitions, freshness, fingerprint invalidation, round limit, symlink refusal |
| 3 | Plugin skeleton: manifest, orchestrator skill, `/peos:start|status|continue|approve|revise`, spec/plan agents, `eval-spec`, `eval-plan` | structure **done 2026-10-29** (manifests pass `claude plugin validate`; structural tests); model-driven run on a fixture (2026-10-29, CLI 2.1.128, $0.99): `/peos:start` classified, spawned `spec-writer` and `eval-spec`, recorded PASS and stopped at the spec gate without self-approving; then `/peos:approve spec` ($0.86) approved only that gate, ran `planner` and `eval-plan` (PASS, 12/12 criteria, one low finding), recorded via `pending-eval.json` and stopped at the plan gate without self-approving |
| 4 | Hooks: `approval-capture`, `state-guard`, `session-resume`, `gate-stop`; grants; `/peos:retry` | **done 2026-10-29**: hook scripts tested with host-shaped input, including bypasses found in two security review rounds (quoting, case, working directory, expansion inside quotes, globs, `find`, environment changes, concurrent grant use). Model-driven on the fixture (2026-10-29): a plain-language "approve the plan" request left the gate pending and the model pointed to `/peos:approve plan` ($0.19); typing `/peos:approve plan` created a grant that `approve` consumed, then the run advanced to `implement` ($0.20); SessionStart context and no false denials of the flow's own commands |
| 5 | Implementer + `eval-code` + `eval-security` + triggers; `peos-run changes`; config binding | structure and scripts **done 2026-10-29** (tests for diff, triggers, config binding, implementer guard); model-driven on the fixture (2026-10-29, $0.97, 24 turns): `/peos:continue` ran `implementer` for S1 and S2, recorded full task checks (17 tests PASS), ran `eval-code` (PASS, 12/12 criteria; no security trigger matched) and reached the release stage with `summary.md`, changes left uncommitted; behavior verified independently. Seeded-defect run (2026-10-30, $1.24): an `export` command implemented without the overwrite and working-directory rules of its acceptance criteria, with a happy-path test only (all checks PASS). Round 1: `eval-code` and `eval-security` both FAILed with high findings for both defects (and the missing tests); `implementer` fixed them; checks re-recorded (22 tests); round 2 both PASS; release stage reached; behavior verified independently. Found and fixed: a 300-character `notAssessed` limit unknown to evaluators, and the orchestrator ending its turn while waiting for a re-sent report |
| 5b | Refactor support: `record-baseline`, `modifiedTests`, refactor rubric, template and agent notes | **done 2026-10-30**: tests for baseline binding to the start state, release rule, modified-test listing (moves, snapshots, layouts), resume flag; reviewed once; not yet exercised by a model |
| 5c | Quality guardrails: floor guard flags and `shortcut:` markers in `changes`; `peos-run map`; least-new-code ladder and never-cut list; finding rule; planning size heuristics; security items and `llm` trigger | **done 2026-10-30**: tests for every flag kind with negative cases (identifiers, prose, test titles, dependency versions, keyboard shortcuts), CLI and quoted thresholds, section paths across type changes, markers, map shortening and ordering, `llm` trigger; reviewed twice. Model-driven on the fixture (2026-10-30): a seeded `test.skip` hiding a case-sensitivity bug was flagged `test-made-easier`; `eval-code` confirmed it (high), the implementer removed the skip and fixed the bug, a further unmet criterion was found and fixed, PASS in round 3 with the `shortcut:` marker treated as a decision and listed in `summary.md` ($1.34); a fresh small `/peos:start` request ran map → implementer (read `map.md`) → checks → `eval-code` PASS with no floor flags ($0.76) |
| 5d | Field-trial tuning (first real project, a `fix`/`standard` production error, 40 min, 5 questions, 17 agent launches, 3 false `gate-stop` blocks): one question round per stage with options and agent defaults recorded as decisions; `fix` intake collects evidence first; one implementer per step batch; `gate-stop` waits for a background evaluator; no reads of secret files | **done 2026-10-30**: `gate-stop` tests for a background evaluator (running, other agent, handed back but unrecorded); not yet exercised by a model |
| 5e | Cost and setup (the field trial used 13.2M tokens, 78% in the orchestrator's growing context): `investigator` replaces the orchestrator's own code reading; `peos-run setup` and `/peos:init` (configuration from manifests, project profile with freshness, `AGENTS.md`/`CLAUDE.md` when missing); every agent starts from the profile; trust-boundary tier rule; spec and plan size limits; `usage-record` hook and `usage` in `status` against tier budgets | **done 2026-10-30**: tests for detection (package managers, placeholder scripts, linter-only `pyproject.toml`, Go, nothing found), no overwrite, profile freshness (including a kept code fence), usage de-duplication across subagents and copies, run attribution from the session's own `peos-run` calls (prefix names, mentions only), foreground versus background evaluators; reviewed once (3 high, 3 medium, 3 low findings fixed); not yet exercised by a model |
| 5f | Short outputs and skill fixes (in the trial the orchestrator re-wrote 58k characters of agent output and received 71k characters of reports into its context): producers, evaluators and the profiler write their own file (guarded path) and return a status line with at most five summary lines; `record-eval` removes a recorded `pending-eval-*.json` and returns the blocking findings, unmet criteria and a deterministic `plateau` flag (and `reset-eval` the cleared report's findings), so the orchestrator never reads reports; brevity rules for messages, agent prompts and reports; Resume as a table; `/peos:retry` resumes the right section; v1 Codex skills marked as not part of the plugin flow | **done 2026-10-30**: guard tests for each agent's own path (and denials: other names, invented runs), report consumption only after recording, digests and plateau, `reset-eval` returning the cleared findings; reviewed once (2 high, 2 medium, 3 low findings fixed); not yet exercised by a model |
| 5g | Field-trial 2 (movies, 38 production lines, 7.7M tokens in an old session, 0 questions, single implementer): file count alone no longer makes a run `standard`; a missing agent or tool stops the run and asks for a new session; `peos-run` counts acceptance criteria (`specSize`, `SPEC_SIZE`) | **done 2026-10-31**: test for the limit; 5e and 5f still not exercised by a model in a fresh session |
| 6 | Release: `release-guard`, release report, CI/permission templates in `/peos:init` | deploy command denied without READY; template reviewed |
| 7 | Large tier: idea, architect, milestones, `eval-performance`, `web`/`ios`/`android` profiles | a small app built end-to-end on web, iOS and Android |
| 8 | Reference evaluation: 3 reference tasks, usage and defect-catch measurements | report of cost per tier and evaluator usefulness; tuning decisions recorded |

## 18. Host assumptions

Checked against the Claude Code documentation (code.claude.com) on 2026-10-29.
Items marked *to verify* must be confirmed by a test in the dependent increment.

| # | Assumption | Status | Design consequence |
| --- | --- | --- | --- |
| 1 | Plugin root holds `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`; manifest `.claude-plugin/plugin.json`; components namespaced `/<plugin>:<name>` | confirmed; docs prefer `skills/` over `commands/` for new plugins | user entry points are skills invoked as `/peos:<name>` |
| 2 | Local install needs `.claude-plugin/marketplace.json`; `claude plugin marketplace add <path>`, `claude plugin install <plugin>@<marketplace>`; `--plugin-dir` for development | confirmed | ship a marketplace manifest |
| 3 | `userConfig` options reach hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`; `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR` available | confirmed | hook profile is a `userConfig` option |
| 4 | Agent frontmatter supports `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `hooks`, `effort`, `isolation: worktree` | confirmed | evaluators restricted by frontmatter and hooks |
| 5 | Subagents can spawn subagents (default depth 3) | confirmed (contrary to an earlier assumption) | workers disallow `Agent` |
| 6 | PreToolUse denies via exit 2 or `permissionDecision: "deny"`; inside subagents input carries `agent_id`, `agent_type`; hook "allow" never bypasses permission rules | confirmed | evaluator write guard is feasible |
| 7 | `UserPromptSubmit` receives the raw typed text (`prompt`), e.g. `/peos:approve …`, before expansion | confirmed | approval capture matches raw text |
| 8 | `UserPromptSubmit` fires only for human prompts | **false**: also scheduled tasks, `/loop`, background subagent reports, other sessions' messages | approval also requires a host permission prompt (§12) |
| 9 | Stop can block with `{"decision":"block"}` or exit 2 | confirmed | `gate-stop` feasible |
| 10 | `stop_hook_active` is present on Stop input | *to verify* (confirmed for SubagentStop) | `gate-stop` must also cap blocks itself via state |
| 11 | Plugins cannot ship permission rules | confirmed | `/peos:init` proposes project `permissions.ask` rules for user approval |
| 12 | `permissions.ask` prompts in every permission mode, including auto/bypass modes | *to verify* | gate strength depends on it; document modes where it does not hold |
| 13 | Usage per session/agent via OpenTelemetry (`claude_code.token.usage` with `query_source`, `agent.name`); headless JSON has `total_cost_usd` | confirmed | reference measurements use OTel, not transcript parsing |
| 14 | `claude -p --bare` skips hooks and plugins; CI action `anthropics/claude-code-action` | confirmed | CI evaluator runs must not use `--bare` |
| 15 | Plugin agents ignore `hooks`, `permissionMode` and `mcpServers` frontmatter; Bash cannot be scoped per agent in `tools` | confirmed | spec/plan agents and their evaluators get no Bash; command-running evaluators (increment 5) rely on the plugin-wide PreToolUse guard keyed by `agent_type` |
| 16 | `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are substituted in plugin skill and agent content; `disable-model-invocation: true` makes a skill user-only | confirmed | entry skills reference scripts by plugin root; `start`, `continue`, `approve`, `revise` are user-only |

## 19. What is taken from ECC

Taken (adapted): size classifier with tie-breakers; per-type first-move rules; two
gated flow with free flow between gates; deterministic security triggers; confidence
filtering, false-positive list and "approve clean diffs" reviewer rules; generator–
evaluator loop with round limit and plateau stop; explicit degraded-mode reporting;
delegation completion contract; Stop hook blocking at most once; hook profiles;
read-only planner with the strongest model.

Not taken: large skill/agent catalog; "use proactively / always parallel" triggers;
hooks on every tool call and inline hook code; per-agent copied defense text; fixed
80% coverage target; evaluators with write access; learning/instinct libraries;
wholesale installation of a third-party plugin. ECC is MIT-licensed; copied text,
if any, keeps attribution.

Also taken, reimplemented in our own code and words (increment 5c), from two MIT-licensed
projects: from dietrichgebert/ponytail, the least-new-code decision ladder with its
never-cut list, `shortcut: <limit>, <when to upgrade>` markers, the regex code map, and
"no concrete case, no finding"; from addyosmani/agent-skills, the floor guard against
lowering the bar, planning size heuristics, and security items for LLM features,
install scripts and path containment. Not taken from them: session-wide persona or skill
injection, automatically triggered skills, mode levels, agents without tool limits,
fail-open handling for gates, state outside the project, and cross-model CLI calls.
Their web-performance, accessibility, release and evaluation-method material is kept
for increments 6–8.

## 20. Target repository layout

```text
peos/
├── .claude-plugin/       plugin.json, marketplace.json
├── agents/              spec-writer … eval-performance
├── skills/              entry points (start, continue, status, approve, revise; later eval,
│                        release, init), orchestrator, existing four stage skills,
│                        peos-profile-*
├── hooks/hooks.json + hooks/*.mjs
├── rules/               existing rules (condensed) + eval-*.md rubrics
├── scripts/             verify, check-changed-files, setup-codex, peos-run
├── schemas/             engineering.config, state, eval-report
├── templates/           task, idea, spec, architecture, plan, summary, decision, AGENTS
├── docs/design/         this document
└── tests/
```

Existing skills remain usable on their own and become stages of the orchestrator.

## 21. Resolved decisions

Decided by the toolkit owner on 2026-10-29:

- First platform profiles: `web`, `ios`, `android` (§16).
- Checkpoint commits are squashed when the PR is prepared (§13).
- `small` tier has no plan approval for now and proceeds automatically (§6);
  revisit after the reference measurements in increment 8.

## 22. Open questions

- Default model per agent after the first reference measurements.
