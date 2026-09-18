# Personal Engineering OS

A small development workflow toolkit for turning natural-language requests into
scoped, verifiable changes. It separates reusable rules, skills and executable
checks, inspired by ECC's separation of responsibilities without installing or
copying its framework. It is not application runtime code.

Projects retain their architecture, technology, design system, domain policy,
check commands, budgets, approvals, task records and decisions. The toolkit supplies
routing, four focused skills, five rule documents, project templates, a schema,
and three local scripts. No hooks, agents, command registry, indexer or plugin package.

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
commands and their side effects before execution. Future hooks or plugin packaging
would require a separately justified extension; neither is implemented here.
