# Codex integration (version one)

## Verified mechanisms

Official documentation checked on 2026-09-18:

- [Skill discovery and invocation](https://learn.chatgpt.com/docs/build-skills):
  repository skills are discovered under `.agents/skills` from the working directory
  through the repository root. Symlinked skill directories are supported. Each
  `SKILL.md` needs `name` and `description`; Codex can match descriptions or the user
  can mention `$skill-name` (CLI/IDE also offer `/skills`). Names are prefixed `peos-`
  to reduce collisions. No optional UI metadata is needed for this integration.
- [Project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md):
  Codex builds instructions at session start from global scope and the project path.
  At each directory, `AGENTS.override.md` takes precedence over `AGENTS.md`, then
  configured fallback names. More local instructions specialize earlier guidance.
  The default combined project instruction budget is 32 KiB. Restart after editing
  instructions. Host-level instructions and permissions retain their precedence.

These documented mechanisms were checked separately from executable evidence in
[VALIDATION.md](../tests/VALIDATION.md). A Markdown file in `rules/` or `skills/`
outside a discovery location does not register a command or create an agent.
The root toolkit `AGENTS.md` is loaded through the consuming project's explicit
instruction to read it; Markdown links are not automatic imports.

## Setup

Keep this toolkit in a stable location. Run setup only when the consuming project
owner authorizes integration. Building/testing the toolkit itself does not run setup
against any real application. No global configuration is changed.

1. Inspect the project's current instructions and `.project-os/engineering.config.json`.
   If configuration is absent, create `.project-os/` and copy
   [the example](../templates/engineering.config.json) there without overwriting an
   existing file. Edit it for the project's actual terminating checks. The example
   assumes npm and Jest's `--runInBand` plus an existing build script; it is not universal.
   Use the project's own tools, e.g. `python`, `go`, or `make`, as appropriate.
2. Review command side effects and authorization. Configuration is trusted executable
   input, not text to populate from retrieved instructions. Never encode secrets.
3. Run (paths may contain spaces when quoted):

   ```sh
   node "/path/to/personal-engineering-os/scripts/setup-codex.mjs" --project "/path/to/project"
   ```

The setup script validates existing configuration, adds a relative symlink at
`.project-os/toolkit`, and links the four skill directories into `.agents/skills/`.
It appends exactly the marked section in [templates/AGENTS.md](../templates/AGENTS.md)
to an existing project `AGENTS.md`, preserving its previous bytes. If absent, it
creates that file. Existing matching links/section make repeated setup a no-op.
Collisions, edited markers, symlinked parent directories or AGENTS files, and an
`AGENTS.override.md` cause a clear error before mutation. File-link collisions are
not overwritten. On write failure, new links are removed; empty directories or a
partial instruction append may remain for inspection. Do not run concurrent setups.

For an override file or custom fallback instruction filename, manually add the
same short section to the active instructions after reviewing the host hierarchy,
and create the five links described above. Automatic setup supports ordinary
`AGENTS.md` only; it does not change Codex fallback settings. Nested project policies
may further specialize this guidance. Very large ancestor instruction files may
truncate the appended section; verify active instructions in the actual session.

Start a fresh session at the consuming project root. In CLI/IDE, use `/skills` or
`$` to inspect discovered names, then prompt, for example:

```text
$peos-task-planning Fix the reported backend bug; first establish expected versus actual behavior.
$peos-implementation Implement the agreed task contract and verify its acceptance criteria.
$peos-code-review Review the selected diff without editing files.
$peos-release-check Assess readiness using this project's release requirements. Report only.
```

Desktop selection UI may differ. Natural-language routing is an instruction convention;
there are no toolkit `/feature`, `/bugfix`, or `/release` commands. Planning,
implementation, review and release checking are responsibilities within a session,
not automatically spawned agents. Descriptions allow implicit selection, but it is
not deterministic enforcement. Ask Codex to identify active project instructions,
the consuming project and configuration before using a newly integrated project.

## Project configuration

Only `<explicit-project>/.project-os/engineering.config.json` is loaded. There is no
search or `--config` option. Missing configuration is an error. References resolve
against the target project root; checks run in that root, independent of the caller's
working directory, toolkit location, package manager or language.

[The Draft 2020-12 schema](../schemas/engineering.config.schema.json) is the structural
contract. [The focused runtime validator](../scripts/lib/config.mjs) checks it before
execution and applies defaults without mutating the input. It also enforces IDs
unique across automated and manual checks. Standard JSON Schema cannot express
uniqueness by one property of otherwise different array objects: its `$comment`
documents this semantic constraint, and tests cover it separately from structural
schema/runtime agreement. No custom JSON Schema engine or undocumented keyword is used.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Required integer, exactly `1` |
| `projectName` | Required non-blank string |
| `outputLanguage` | Optional non-blank response language; defaults to `tr` |
| `references` | Optional `instructions`, `architecture`, `design` path arrays; defaults to `{}` |
| `checks` | Non-empty list of `id`, `executable`, `args`, `phases`, `required`, `timeoutMs` |
| `manualChecks` | Optional list of `id`, `description`, `phases`, `required`; defaults to `[]` |
| `approvalRequiredFor` | Optional action set; defaults to every action enumerated in the schema |

Unknown fields, duplicate IDs, duplicate phases/references/approval actions and
invalid types are rejected. Args are ordered and may repeat or be empty strings.
Executable names and arguments cannot contain NUL. Timeout is an integer from 1 to
2,147,483,647 milliseconds (Node's timer limit). Phases contain `task`, `release`,
or both. Reference paths use forward slashes, cannot be absolute or contain `..`
segments, control characters, colons or backslashes. Missing referenced documents
are for the workflow to assess; the validator does not invent them. Symlinks inside
a project may resolve outside it; this is lexical validation, not access control.

Omitted approval configuration requires explicit authorization for commit, push,
pull-request, deploy, publish, migration and external-write. An explicit empty set
adds no toolkit approval requests, but cannot override project/host policy or grant
permission. Response language applies to agent responses; executable status labels,
diagnostics and machine-report keys remain English in version one.

## Exact script invocations

All examples use the same explicit target; neither scripts nor setup change the
caller's directory. Commands are executed directly with an argument array and
`shell: false`. Programs must be available on PATH or via an appropriate executable
path. Relative executable paths with a slash resolve from the project root.
No package.json is required by the runner.

```sh
# Full automated task phase, human output (default)
node /path/to/personal-engineering-os/scripts/verify.mjs --project /path/to/project --phase task

# Target only named checks. --checks takes a JSON array, including IDs with commas.
node /path/to/personal-engineering-os/scripts/verify.mjs --project /path/to/project --phase task --checks '["tests"]' --json

# Full automated release phase; not a readiness declaration
node /path/to/personal-engineering-os/scripts/verify.mjs --project /path/to/project --phase release --json

# HEAD versus index/worktree layers, including untracked files
node /path/to/personal-engineering-os/scripts/check-changed-files.mjs --project /path/to/project --mode working-tree --json

# Current branch since its common ancestor with an explicitly chosen reference
node /path/to/personal-engineering-os/scripts/check-changed-files.mjs --project /path/to/project --mode reference --reference main --json
```

Options may occur once; positional arguments and unknown options are errors.
`--reference` is valid only in reference mode. `--json` is available on all three
scripts and emits exactly one JSON object on stdout, including handled errors.
There is no generic shell-command-string field or eval. Do not configure watch loops.

### Verification results

The result includes target/project name, phase, selected IDs, `verification` (`full`
or `partial`), omitted required phase checks, resolved references, per-check results,
and manual requirements explicitly marked `NOT_ASSESSED`. An explicit `--checks`
selection is always labeled partial, even if it happens to name all phase checks.

| Per-check status | Meaning |
| --- | --- |
| PASS | Executed and exited successfully |
| FAIL | Executed and exited unsuccessfully |
| BLOCKED | Startup/execution problem, signal, timeout or interruption |
| SKIPPED | Outside phase or deliberately omitted from a targeted run; reason recorded |

Each check records ID, required flag, exit code (null if unavailable), duration,
reason, and signal when applicable. Optional failures remain in the report. An
applicable selected required check is never silently skipped; interruption marks
remaining selected checks BLOCKED. Empty selections, unknown/out-of-phase IDs and
phases without checks are errors.

Exit codes: `0` means selected required automated checks passed; `1` means a required
selected check failed/was blocked; `2` means invalid invocation/configuration or a
handled tool error. SIGINT/SIGTERM cancellation returns `130`/`143`. An optional-only
failure may coexist with aggregate PASS and exit 0; inspect per-check results.
A partial PASS does not establish that the phase passed. No result determines
release readiness, validates manual evidence, or proves future freshness.

Subprocess stdout/stderr are drained and captured up to 64 KiB per stream; report
metadata counts total bytes and indicates truncation. **All raw log contents are
suppressed in both output modes**, including failures: arbitrary text cannot be
reliably stripped of secrets. No executable arguments or environment dump is printed.
For diagnostics, rerun an authorized native project check in an appropriate terminal
and inspect its logs locally. IDs, project names and paths are metadata and should
not contain secrets. Output bounds apply per stream, not to configuration size.

The verifier runs checks sequentially. POSIX process groups receive SIGTERM followed
by SIGKILL after 200 ms on cancellation/timeout, including ordinary descendants even
when the direct child already exited. If exit cannot be confirmed within one more
second after SIGKILL, the result remains BLOCKED and reports unconfirmed cleanup.
SIGKILL of the runner, machine loss, hostile
processes creating a new session, and commands deliberately leaving detached services
are outside this mechanism. Use terminating checks; this is not a process sandbox.

### Change discovery results

Working-tree mode reports staged HEAD→index, unstaged index→worktree, and untracked
entries separately. One path can therefore appear twice; even staged changes undone
in the worktree remain visible as two layers. It does not collapse them into a net diff.

Reference mode resolves the supplied commit-ish with `rev-parse --verify
--end-of-options`, computes the merge base and compares it to HEAD, equivalent to
`git diff <reference>...HEAD`. It reports current-branch changes since the common
ancestor, not differences between branch endpoints. Additional staged/unstaged/
untracked changes are listed separately as excluded. Invalid references, unrelated
history, ambiguous multiple merge bases and missing history fail without fallback
or automatic fetching.

The target must be the Git working-tree root. Repositories without an initial
commit return `NO_HEAD`; a clean initialized repository is a valid empty result.
NUL-delimited Git output preserves spaces, tabs, newlines, leading dashes and UTF-8
names. Renames retain source/destination paths; detection uses Git's similarity
heuristics. Arbitrary non-UTF-8 filename bytes are not losslessly supported. Git
operations are bounded to 10 seconds and 16 MiB each, fail clearly on overflow,
disable external diff/textconv and optional index locking, and never stage or edit.
Nested submodule internals are not recursively inventoried; inspect them separately
when relevant. Concurrent repository edits can make a multi-command report stale;
ensure a stable worktree and do not treat a SHA alone as freshness evidence.

Categories `potentially-sensitive`, `migration`, `schema`, `dependency`, and `tooling`
are filename hints for further review. File contents are never printed. A lockfile-only
change is not inherently wrong; categories are neither a secret scan nor evidence
of migration safety or security.

## What is enforced and what is guided

Scripts enforce config/CLI validation, command outcome reporting, bounded log handling,
phase/selection semantics, process cancellation, structured Git discovery and setup
collision checks. Skills guide planning, context retrieval, review, approvals and
readiness evidence. Project policy owns implementation choices and check commands.
No script enforces all agent actions or verifies that commands are non-destructive.
Normal feature work does not automatically run every release check.

## Removal

Inspect links with `ls -l` first. Remove only the five links this integration created:
`.project-os/toolkit` and `.agents/skills/peos-task-planning`, `peos-implementation`,
`peos-code-review`, `peos-release-check` (the latter four all under `.agents/skills/`).
Use `unlink` on those exact paths, not recursive deletion. Remove only the marked
`personal-engineering-os:start` through `personal-engineering-os:end` section from
the active project instructions. Keep all other guidance, skills, configuration,
task/decision records and application work. Do not delete `.project-os/` wholesale.
Restart Codex and verify the skills no longer appear. Shared toolkit updates are
visible through symlinks; review them before use. Relocation requires reviewing and
recreating the links; there is no automatic updater or global installation.
