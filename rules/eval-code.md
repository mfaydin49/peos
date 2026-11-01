# Code evaluation rubric

Input: the spec (or task), the plan, `changes.diff`, `checks.json`, and the files the
diff touches. Read the changed files around each hunk; do not judge hunks in isolation.
`checks.json` holds results only (logs are suppressed); a failed or missing required
check of the recorded phase is itself blocking. A check `SKIPPED` as outside the phase
is not missing. A command the project's instructions ask for that no task-phase check
runs is a `low` finding, never blocking: the configuration, not the run, is the gap.

When the orchestrator says this is an evidence round, the code did not change since the
previous report and only check evidence was missing: Read that report and `checks.json`,
keep its criteria and non-blocking findings, and judge only that evidence.

## Focus `acceptance`

For each `AC-n`, report `met` only with concrete evidence: the test name that exercises
it, or the code path plus a passing check. Otherwise `not_met` (blocking) or
`not_assessed` with the reason. Blocking: an unmet criterion; behavior outside scope or
contradicting a non-goal; a required check that failed or is missing.

## Focus `quality`

Blocking: dead or obsolete code left behind; an abstraction, layer or option without an
established need; duplication of an existing helper; a violation of the project's
conventions or architecture (layer boundaries, error handling, naming); an unexplained
change outside the plan's files; mutation of inputs or shared state the design forbids.
Non-blocking: naming and readability improvements, small simplifications.

## Focus `tests`

Blocking: a criterion or important edge case with no test; tests that assert
implementation details rather than behavior; tests weakened, skipped or deleted;
tests that cannot fail (no assertion, assertion on a mock of the code under test);
a bug fix without a regression test. Non-blocking: test naming, helper reuse.

## Floor flags and shortcuts (every focus)

The orchestrator passes `floorFlags` from `changes`: pattern-based signs that the bar may
have been lowered (tests skipped, focused or deleted, assertions removed, checkers
silenced, empty `catch` or unfinished work, thresholds changed). Read each flagged line
in context. If it is not a lowering of the bar (a pattern false positive), dismiss it in
one line under `notAssessed` ("flag X dismissed: reason"). If it is, it is blocking unless
the spec, plan or a stated decision explains it (a test removed with its feature is
fine); name the flag in the finding. `shortcuts` lists `shortcut:` markers: one with an
upgrade trigger that does not cut a never-cut item is a decision, not a finding; one
without a trigger is a `low` finding.

## Focus `all`

Apply all three sections and report every criterion in `criteria`.

## Refactor runs

The orchestrator says when the run type is `refactor` and passes `modifiedTests`, the
existing test files changed or removed since the base commit. In addition to your focus:

Blocking: any observable behavior change (outputs, errors, exit codes, public API,
persisted formats, performance-relevant algorithms) the spec does not list as intended;
an existing test whose assertions, inputs or expected values changed or that was removed
(only mechanical edits such as import paths and renamed symbols are acceptable, and each
must be visible in the diff); refactored code with no test exercising it when the plan
called for characterization tests; dead code or compatibility shims left behind without
a stated reason. If you accept entries of `modifiedTests` as mechanical, report them
together as one `low` finding listing the files and why, so the user can see them.
