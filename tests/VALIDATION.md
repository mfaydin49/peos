# Validation record

Date: 2026-09-18. Evidence applies to this delivered source state, not future edits.
The destination was empty before creation. All consuming-project fixtures and Git
commits were isolated under OS temporary directories. No application code, host
instructions, global tool settings, production resources or real Git history were
changed. No ECC installation, external plugin, MCP server, deployment, publishing,
migration, commit/push to a user repository or pull request was performed.

## Automated executable tests

Environment: macOS 27.2, arm64, Git 2.50.1 (Apple Git-155).
Tested Node.js versions: **22.0.0 (declared minimum)** and **25.8.1 (pre-existing local
runtime)**. Node 25 is only additional compatibility evidence, not a recommended
supported production release. The official Node 22.0.0 binary was extracted in a
temporary directory without replacing the installed Node or global configuration.

Run from the toolkit directory:

```sh
npm ci --ignore-scripts
npm test
```

The built-in runner uses `node:test` and `node:assert/strict`. The normal suite has
63 passing executable tests and one opt-in Codex test skipped. Coverage includes:

- Valid/example configuration, defaults without mutation, missing/malformed config,
  unknown fields, duplicate IDs/set values, type errors, paths and schema agreement.
  Ajv independently evaluates Draft 2020-12 fixtures. Projected-ID uniqueness is
  documented and tested as an additional runtime invariant, not falsely attributed
  to standard JSON Schema.
- Successful/failed/optional commands; missing and non-executable programs; child
  signals; timeout and SIGINT/SIGTERM interruption; ordinary grandchildren ignoring
  SIGTERM; remaining checks blocked; working directory and literal argument forwarding.
- JSON-only stdout even with noisy child streams; raw log suppression and truncation
  metadata; structured handled errors and exit codes; targeted/empty selections;
  manual evidence left explicitly unassessed; no project package.json requirement.
- Separate staged/unstaged entries for the same path; untracked/deleted/renamed files;
  rename source/destination; spaces, tabs, newlines, quotes, Unicode and leading dashes;
  category hints without reading contents; pre-existing index/content preservation.
- Diverged branches where merge-base differs from endpoint comparison; excluded
  local changes; invalid references, unrelated history, non-Git/unborn repositories,
  root validation and clean empty discovery results.
- Additive, repeatable setup, exact preservation of existing instruction bytes and
  unrelated work/skills/configuration, collision refusal and symlink-parent safeguards.

Ordinary suite fixtures do not read global Git config, use user hooks/templates,
sign commits, contact remotes, or modify global Git settings. Tests clean up only
owned temporary directories. No universal coverage percentage is asserted.

## Actual Codex runtime discovery

The opt-in probe was run against **codex-cli 0.141.0**, using Node **22.0.0**:

```sh
PEOS_CODEX_DISCOVERY=1 node --test tests/codex-discovery.test.mjs
```

Result: **1 passed**. The probe creates a temporary consuming Git project, applies
setup, initializes a real Codex app-server over stdio, and calls `skills/list` for
the project root and a nested working directory. It asserts all four `peos-*` names
are enabled, repository-scoped, and parsed without skill errors. This is actual
Codex discovery, not merely a filesystem assertion or hypothetical walkthrough.
The local protocol shape was checked using the installed CLI's generated schemas.

The first probe could not initialize Codex's state database inside the host sandbox.
The final probe used invocation-local `sqlite_home` and `log_dir` paths within its
fixture, and an approved retry. No persistent Codex configuration was edited.
The state-location override follows [official configuration documentation](https://learn.chatgpt.com/docs/config-file/environment-variables).
The probe does not send a model turn or intentionally call an account API; Codex
startup can perform its own environment-dependent initialization. No credentials
or discovered global skill inventory are printed.

Not tested: model execution of `$peos-*`, implicit routing choices, instruction-chain
loading into a model conversation, or desktop UI behavior. Setup tests prove the
additive section exists; official docs substantiate the instruction discovery mechanism.
They do not prove every instruction will be obeyed. These parts remain unverified.
No manual model-session integration result or independent-agent review is claimed.
The bundled skill validator was unavailable because its Python environment lacked
PyYAML; the actual Codex parser successfully parsed all four skills instead.

## Documented scenario walkthroughs (not runtime tests)

These are desk reviews of instructions, not observations of a model executing tasks.

| Representative request | Routing and intended evidence | Assessment boundary |
| --- | --- | --- |
| Small backend bugfix: missing ownership check | Brief expected/actual contract; owning handler, authorization boundary and focused regression test; task checks and read-only review | No repository map or persistent task file without a persistence trigger; missing auth evidence prevents unsupported completion claims |
| Frontend behavior: keyboard-operable dialog | Contract for visible states and keyboard/focus behavior; project component/design references; relevant tests, viewport and interaction evidence | Visual/manual evidence must be actually obtained or reported unavailable; no invented design system |
| Documentation-only correction | Relevant document and links, project documentation checks, scoped review | No unrelated backend/UI context or automatic full release run; a targeted report remains partial and omitted required checks must be accounted for |
| Cross-cutting feature | Independently verifiable increments; public contracts, backend authorization/data access and frontend states; affected tests and review | Persist a project-local continuation record only on defined criteria; unresolved product choices are raised, not invented |
| Release with missing environment prerequisite | Full required automated release checks plus manual requirement still unassessed | Automated PASS can coexist with readiness BLOCKED. An established release failure gives NOT READY. No deployment or migration follows |

## Review and remaining limits

A separate self-review pass examined executable failure paths, instruction scope,
documented promises, and test evidence. It is not independent review. It added a
bounded cleanup deadline after SIGKILL so an unconfirmed process exit cannot cause
an unbounded runner wait, and retained that limitation in the documented contract.

Linux/Windows, non-UTF-8 filenames, hostile detached process containment, concurrent
repository mutation, and every possible Codex version are not verified. The runner
executes trusted project tools; it neither authorizes their side effects nor proves
manual evidence, release readiness, or security. There is no measured token-savings
claim. The remaining adoption step is to review a consuming project's config, apply
setup explicitly, and verify active instructions and skill invocation in that project.
