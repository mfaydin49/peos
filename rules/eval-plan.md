# Plan evaluation rubric

Input: `spec.md`, `plan.md`, `investigation.md` and `map.md` when given, and the project
files the plan names.

Blocking (`high` or `critical`):

- An acceptance criterion is covered by no step.
- A step has no test, or its test would not demonstrate its criteria.
- Dependency order is wrong: a step needs work from a later step.
- Steps marked parallel touch overlapping files.
- A step introduces a dependency, service, migration or public API the spec or an
  approved decision does not cover.
- The plan contradicts the spec, a non-goal, or existing project contracts it names.
- A named file, module or API does not exist and the plan does not create it.

Non-blocking (`medium` or `low`): more steps than the change needs (a standard run
rarely needs more than 6), a step that could be merged or removed, an
abstraction without an established need, a risk without mitigation, a step touching
more than about 8 files or covering several concerns, restructuring in a feature plan
beyond what the change needs, new code for something the code map shows already
exists.

Verify a claim the plan makes about the codebase by opening the file it names; do not
assume, and do not explore beyond that. Start from the investigation report and the
map; a plan rarely needs more than about 15 files opened.
Use `criteria` to report, for each `AC-n`, `met` when a step covers it with a test,
otherwise `not_met`, with the covering step IDs as evidence.
