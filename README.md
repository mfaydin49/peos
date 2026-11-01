# Personal Engineering OS

A small development workflow toolkit for turning natural-language requests into
scoped, verifiable changes. It separates reusable rules, skills and executable
checks, inspired by ECC's separation of responsibilities without installing or
copying its framework. It is not application runtime code.

Projects retain their architecture, technology, design system, domain policy,
check commands, budgets, approvals, task records and decisions. The toolkit supplies
routing, four focused stage skills, rule documents, project and run templates, schemas,
and four local scripts. It is also a Claude Code plugin preview (below) with entry
skills, nine agents (project profile, investigation, spec, plan, implementation and four evaluators) and hooks that
protect run state and human gate decisions. The direction is specified in the [v2 design](docs/design/peos-v2-plugin.md);
increments 1–5 are implemented: request → spec → plan → implementation →
checks → independent code and security evaluation → release stage, with extra
behavior-preservation rules for refactor runs and deterministic quality guardrails
(floor guard, shortcut markers, code map). `/peos:init` (also run automatically by
`/peos:start`) writes the check configuration from the project's manifests, a project
profile for the agents, and `AGENTS.md` when the project has none.

The shared authorization policy lets already-approved project-local implementation,
tests, browser/simulator checks, project start/stop, and agreed local database work
continue without repeated workflow prompts. Project-owned loopback ports are included;
unrelated local ports and services are not. Once authorized, physical-device development
for the same project app also continues without repeated prompts. It requires approval
for project-external file access, artifact/package downloads, external registry access,
external uploads/writes, unapproved dependency changes, unplanned database operations,
new devices/apps, unrelated personal device data, and production/store distribution.
Host sandbox and device trust prompts remain independent.

## Claude Code plugin (preview)

This directory is also a Claude Code plugin (`peos`) and a local marketplace. It drives
a run through spec, plan, implementation, recorded checks and independent code and
security evaluation up to the release stage. The release report and PR flow arrive in
increment 6; see the [v2 design](docs/design/peos-v2-plugin.md).

### Start in a new project

The project needs a Git repository with at least one commit, and a root test command
PEOS can detect (a `test` script in `package.json`, pytest, `go test`, `cargo test`,
`swift test` or Gradle). Otherwise setup stops and tells you what is missing.

1. Open Claude Code in the project with the plugin loaded:

   ```sh
   cd /path/to/project
   claude --plugin-dir /path/to/personal-engineering-os
   ```

   Or install it once from the local marketplace, inside Claude Code:

   ```text
   /plugin marketplace add /path/to/personal-engineering-os
   /plugin install peos@peos-local
   ```

2. Prepare the project (optional, `/peos:start` does the same when something is missing):

   ```text
   /peos:init
   ```

   This writes `.project-os/engineering.config.json` from the project's manifests and
   `.project-os/project-profile.md`, creates `AGENTS.md` and `CLAUDE.md` when missing,
   and leaves them uncommitted for you to review. Review the configured checks: PEOS
   runs them as commands.

3. Describe the work in your own words:

   ```text
   /peos:start Add CSV export to the reports page.
   ```

PEOS investigates the request and picks a type and a tier. Override either one in the
request:

```text
/peos:start --tier standard --type fix Login fails after a password reset.
```

### Commands

| Command | Use it to |
| --- | --- |
| `/peos:init` | Prepare a project, or refresh its profile, without starting a run. |
| `/peos:start <request>` | Start a run. Options: `--type app\|feature\|change\|fix\|refactor`, `--tier trivial\|small\|standard\|large`. |
| `/peos:status [run]` | See runs, or the stage, evaluations, checks and token use of one run. Changes nothing. |
| `/peos:approve [gate] [run]` | Approve the pending decision. |
| `/peos:revise <spec\|plan> [--run <name>] <feedback>` | Send a spec or plan back with your feedback. |
| `/peos:continue [run]` | Resume an unfinished run, also in a new session. |
| `/peos:retry <evaluation> [run]` | Try again after an evaluation hit its three-round limit, for example `/peos:retry code-all`. |

### What happens in a run

| Tier | Typical work | Your decisions |
| --- | --- | --- |
| `trivial` | One file, a few lines | None |
| `small` | One concern, about 5 files, no user-level choice | None |
| `standard` | A real user-level choice, or a change to a trust boundary | One `/peos:approve` after the spec and plan both pass evaluation |
| `large` | New application or several open questions | Arrives in increment 7 |

The agent asks a question only when the choice is yours. Implementation, checks and
evaluation then run on their own. A run ends at the release stage with a summary in
`.project-os/runs/<run>/summary.md`.

Nothing is committed, pushed, deployed or migrated for you: the change stays in your
working tree. Review it, open it in the app, then commit it yourself.

Decisions take effect only right after you type the command yourself. See design §12
for what the hooks do and do not guarantee.

Start each run in a new session when you can: agents and hooks load at session start,
and a long conversation is read again on every model call, which costs the most tokens.

## Requirements

- Node.js **>=22.0.0**. On 2026-09-18, 22 was the lowest non-EOL LTS major,
  including Maintenance LTS, per the [official release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
  (20 ended 2026-04-30; 22 ends 2027-04-30). Use a current patched 22 LTS installation
  in practice; the minimum is a compatibility floor.
- Supported/tested OS: **macOS arm64**. POSIX process-group code also permits Linux,
  but Linux is unverified and not advertised as supported. Windows is unsupported.
- Git for change discovery and fixture tests; Codex for the skill integration.
- No runtime npm dependencies. Ajv is the sole development dependency: it provides
  independent Draft 2020-12 schema validation in tests, avoiding a homemade schema engine.

## Quick start

From this directory, test the toolkit:

```sh
npm ci --ignore-scripts
npm test
```

For a consuming project, first follow the [Codex setup guide](integrations/codex.md#setup)
to create and review its local configuration. Then, using explicit absolute paths:

```sh
node /path/to/personal-engineering-os/scripts/setup-codex.mjs --project /path/to/project
node /path/to/personal-engineering-os/scripts/verify.mjs --project /path/to/project --phase task
```

Start a fresh Codex session in that project and invoke `$peos-task-planning` with
your request. The [integration guide](integrations/codex.md) owns the exact setup,
invocations, configuration contract, report semantics, removal and runtime limitations.

## What a result establishes

The verifier reports **automated verification**, not task completion or release
readiness. A task also needs acceptance and review evidence. Release readiness
combines full required release checks with current manual/environment evidence;
the release skill reports READY, NOT READY or BLOCKED and stops there.

Instruction routing and approval policy guide the model; they do not restrict file
access, enforce every action, or sandbox trusted check commands. There are no claims
of guaranteed quality, security, performance, or measured token savings.

## Validation and limitations

See [validation evidence](tests/VALIDATION.md) for exact tested versions, automated
coverage, actual Codex discovery checks, and scenario walkthroughs kept separate
from runtime evidence. End-to-end model invocation and desktop UI routing remain
unverified. Integration uses local symlinks: moving the toolkit can break them.
Raw check logs are suppressed, reference paths are lexically contained (not a symlink
sandbox), and Git discovery is bounded and assumes UTF-8 paths. Review configured
commands and their side effects before execution.
