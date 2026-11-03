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
- Large tier: milestones are missing, `M1` is not runnable and testable on its own, or a
  step belongs to no milestone. For a new application (`app`), `M1` is not a walking
  skeleton whose first step creates the manifests, `.gitignore` (build output and
  installed packages) and a root test command with one passing test.
- A step installs a dependency the approved architecture does not list.

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

## Focus `architecture`

Input: `architecture.md`, `spec.md`, `idea.md`, and `investigation.md` and the project
profile when given. Set `"focus": "architecture"`. Use `criteria` for each `AC-n`:
`met` when a component, contract or data entity provides for it, otherwise `not_met`.

Blocking: a criterion no component provides for; a new dependency or service used but
not listed under "External services and dependencies"; a choice that contradicts the
spec, a non-goal, or the existing project's stack and boundaries without a stated
reason; data ownership, authentication or authorization the spec implies but the
architecture leaves open; secrets placed in code or configuration that is committed;
an open question left for the implementer.

Non-blocking: a heavier stack than the spec needs, a dependency the platform's standard
library makes unnecessary, a component without an established need, a risk without
mitigation. Do not judge taste in technology; judge fit to the spec and the project.
