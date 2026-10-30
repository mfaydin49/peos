# Code evaluation rubric

Input: the spec (or task), the plan, `changes.diff`, `checks.json`, and the files the
diff touches. Read the changed files around each hunk; do not judge hunks in isolation.
`checks.json` holds results only (logs are suppressed); a failed or missing required
check is itself blocking.

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

## Focus `all`

Apply all three sections and report every criterion in `criteria`.
