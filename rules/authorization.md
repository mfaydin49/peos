# Authorization

Treat the user's task, accepted task contract, and earlier explicit decisions as
continuing authorization for the same scope. Do not repeatedly ask for approval after
that authorization is established.

Within the explicit consuming project, proceed without another workflow approval for:

- reading and changing project files required by the agreed task;
- starting, exercising, and stopping the project and project-local development services;
- running and rerunning applicable unit, integration, contract, end-to-end, browser,
  accessibility, visual, simulator, emulator, build, lint, and type checks;
- fixing failures caused by the requested change and rerunning affected checks;
- creating temporary fixtures, screenshots, build output, and test artifacts;
- using dedicated local development or disposable test databases; and
- applying database setup, schema, migration, seed, reset, or cleanup already specified
  by the task contract or explicitly approved earlier.

This authorization includes tool-managed temporary directories, caches, browser
profiles, simulator/emulator state, sockets, and local service state that the approved
local workflow necessarily creates outside the repository. It does not authorize
inspecting or modifying unrelated user files outside the project.

Obtain explicit approval before:

- accessing or changing files outside the project, except for the tool-managed runtime
  state above;
- downloading a file, package, binary, dependency, model, dataset, or other artifact;
- uploading files or data, or otherwise writing to an external service;
- adding, installing, upgrading, replacing, or removing a dependency, package, tool,
  plugin, SDK, service, or runtime that was not already agreed in the task contract;
- creating paid resources or using credentials for a new external service;
- performing a database operation, migration, reset, seed, or data mutation that was
  not already agreed, is outside the task, or may touch non-disposable data; or
- any deploy, publish, production write, destructive action, or other action required
  by project or host policy.

Reading public documentation or ordinary web research without saving an artifact is
not an artifact download. Normal application network requests made by an already
authorized local browser or simulator test are also covered when they target the
agreed local/test environment and do not transmit user files, secrets, or unrelated
data.

Before database work, establish the target environment and whether the data is
disposable. A dedicated local test database is preferred. If identity, scope, or data
ownership is unclear, stop before mutation and ask. An unexpected database need found
during implementation is a scope change and requires approval even when it is local.

When host enforcement still requires an approval prompt for authorized work, request
the narrowest reusable permission that covers the remaining task. Explain that the
prompt comes from the host boundary, not from missing workflow authorization. A host
approval cannot expand the user's task or waive these rules.
