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
| `refactor` | behavior stays, structure improves | tests green before and after every step; no behavior change |

The orchestrator infers the type and states it with the tier; ambiguity is asked once.

## 8. Agents

All agents are plugin-scoped and spawned as `peos:<name>` (e.g. `peos:planner`). Each
loads only the rules it needs.

| Agent | Role | Tools | Model | Writes |
| --- | --- | --- | --- | --- |
| `spec-writer` | idea/request → spec, asks only consequential questions | Read, Grep, Glob | strongest | no (returns content) |
| `architect` | platform, stack, data model, components, ADR proposals | Read, Grep, Glob, docs lookup | strongest | no |
| `planner` | spec → ordered steps with files, AC coverage, tests | Read, Grep, Glob | strongest | no |
| `implementer` | one plan step: code + tests, targeted verify | Read, Grep, Glob, Edit, Write, Bash | mid | **yes** (project code only) |
| `eval-spec` | spec quality | Read, Grep, Glob | mid | no |
| `eval-plan` | plan/architecture quality | Read, Grep, Glob | strongest | no |
| `eval-code` | `focus`: `acceptance` \| `quality` \| `tests` \| `all` | Read, Grep, Glob, restricted Bash | mid | no |
| `eval-security` | security review + scanner results | Read, Grep, Glob, restricted Bash | strongest | no |
| `eval-performance` | measurements against budgets | Read, restricted Bash, browser/simulator | mid | no |

Notes:

- The test-authoring responsibility stays inside `implementer` (tests are
  written with the code, derived from acceptance criteria); `eval-code` with focus
  `tests` judges them. A separate test author is added only if evaluation shows
  implementer-written tests are systematically weak.
- One `eval-code` agent with a `focus` parameter replaces three near-duplicate agents;
  the large tier calls it once per focus, smaller tiers once with `all`.
- "Restricted Bash" = an allowlist of read-only/scanner commands, enforced by the
  write-guard hook ([§11](#11-hooks)), which identifies evaluator calls by the
  `agent_type` field hooks receive inside subagents.
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
| `spec.md` | standard, large | orchestrator from `spec-writer` | commit |
| `architecture.md` | large | orchestrator from `architect` | commit |
| `plan.md` | standard, large | orchestrator from `planner` | commit |
| `summary.md` | all | orchestrator | commit (becomes PR body) |
| `state.json` | all | `peos-run` script only | ignore |
| `checks.json` | all | `peos-run record-checks` (runs `verify`) | ignore |
| `evals/<key>.json` | all | `peos-run record-eval` from the evaluator's report | ignore |

`peos-run init` writes a run-local `.gitignore` for the ignored files, plus
`pending-eval.json`, where the orchestrator places an evaluator's report before
`record-eval` reads it. Run files are
read and written only as regular files inside real directories; symlinks are refused.

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
| `approval-capture` | UserPromptSubmit | When the whole prompt is exactly `/peos:approve <gate> <nonce>` or `/peos:revise …`, records the decision for the pending gate with the artifact hash. Second signal for gates; see §12 for why it is not sufficient alone. | all |
| `state-guard` | PreToolUse (Edit, Write, Bash) | Denies direct writes to `state.json`, `checks.json`, `evals/` and calls to `peos-run` subcommands reserved for hooks. | all |
| `eval-write-guard` | PreToolUse (Edit, Write, Bash) inside evaluator agents | Denies writes and non-allowlisted commands from `eval-*` agents. | all |
| `release-guard` | PreToolUse (Bash) | Denies configured deploy/publish/push-to-protected commands unless the release report is READY for the current code state; never grants approval itself. | standard, strict |
| `gate-stop` | Stop | If an active run is in an automatic stage with unmet gates, blocks once with the missing items; passes when `stop_hook_active` is true to avoid loops. | standard, strict |
| `session-resume` | SessionStart | Injects a one-line summary of the active run (stage, pending gate). | all |
| `fact-gate` (optional) | PreToolUse (Edit) | ECC GateGuard idea: first edit of a file requires listing its importers/contracts. Off by default; evaluated before enabling. | strict |

Profiles (`minimal | standard | strict`) are a plugin user option. `minimal` keeps only
the guards that protect approvals and state integrity.

## 12. Human gates and release safety

| Gate | Enforcement | Strength |
| --- | --- | --- |
| spec, architecture, plan | `peos-run approve` is the only command that sets a human gate and sits behind a project `permissions.ask` rule, so the host asks the human before it runs; `state-guard` blocks every other write path; `approval-capture` must also have seen the matching prompt | host-enforced prompt, assuming the `ask` rule holds in the session's permission mode ([§18](#18-host-assumptions)) |
| checkpoint commits | approved once at plan approval for the run's branch (`standard`, `large`); `trivial`/`small` runs make no checkpoint commits | workflow guidance + host permission prompt |
| push / PR | project permission rule `ask` | host-enforced prompt |
| production deploy | (1) permission `ask` rules for deploy commands, (2) `release-guard`, (3) CI environment protection with required reviewers | (3) is outside the machine and the strongest |

`UserPromptSubmit` alone is not proof of a human decision: the host also fires it for
scheduled task runs (including `/loop`), background subagent reports and messages
from other sessions. Hence the exact-prompt-plus-nonce match is combined with the
host permission prompt, and runs refuse gate approvals while a loop or scheduled
task drives the session.

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
- In `standard` and `large` runs each completed step is a local checkpoint commit on
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

`/peos:init` detects the platform, proposes a configuration from the profile and
writes it only after the user confirms.

## 17. Implementation increments

Each increment is independently usable and verified before the next.

| # | Increment | Done when |
| --- | --- | --- |
| 1 | Templates and schemas: run templates, `state` and `eval` schemas, config `kind` field | **done 2026-10-29**: schemas compile under Ajv strict and agree with runtime validators; templates in `templates/run/` (referenced from skills in increment 3) |
| 2 | `peos-run` core: init, status, fingerprint, gate transitions, atomic state, persisted `checks.json` | **done 2026-10-29**: integration tests for transitions, freshness, fingerprint invalidation, round limit, symlink refusal |
| 3 | Plugin skeleton: manifest, orchestrator skill, `/peos:start|status|continue|approve|revise`, spec/plan agents, `eval-spec`, `eval-plan` | structure **done 2026-10-29** (manifests pass `claude plugin validate`; structural tests); model-driven run on a fixture (2026-10-29, CLI 2.1.128, $0.99): `/peos:start` classified, spawned `spec-writer` and `eval-spec`, recorded PASS and stopped at the spec gate without self-approving; then `/peos:approve spec` ($0.86) approved only that gate, ran `planner` and `eval-plan` (PASS, 12/12 criteria, one low finding), recorded via `pending-eval.json` and stopped at the plan gate without self-approving |
| 4 | Hooks: `approval-capture`, `state-guard`, `session-resume`, `gate-stop` | tests show the model cannot set a gate; Stop blocks at most once |
| 5 | Implementer + `eval-code` + `eval-security` + triggers | a `standard` run reaches READY on a fixture; a seeded defect is caught |
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
