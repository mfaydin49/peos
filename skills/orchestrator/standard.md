# PEOS orchestrator: standard run

Follows ${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md; its Fixed rules apply.

## 3. Standard: produce → evaluate → one decision

For each stage, in order `spec`, then `plan`:

| Stage | Producer | Template | Artifact | Evaluator |
| --- | --- | --- | --- | --- |
| spec | `peos:spec-writer` | `templates/run/spec.md` | `spec.md` | `peos:eval-spec` |
| plan | `peos:planner` | `templates/run/plan.md` | `plan.md` | `peos:eval-plan` |

1. `peos-run advance --to <stage>`.
2. Spawn the producer. Before the first planner, run `peos-run map --run <run>` and give
   it `<directory>/map.md`. Give the spec-writer the request, the evidence and every
   answer the user has already given. On `STATUS: QUESTIONS`, drop the questions the
   project or the evidence answers, ask the rest in one round (see Fixed rules), then
   spawn the producer again with all answers.
3. On `STATUS: DRAFT`, the producer has written `<directory>/<artifact>`; keep its
   summary lines for step 7 and do not read the artifact yourself.
4. `peos-run brief --run <run>` and take `artifacts.<stage>` as the subject (missing:
   the producer did not write it; spawn it again once). If `specSize.over` is true,
   spawn the spec-writer once more to merge criteria down to `specSize.limit`;
   `record-eval` refuses an oversized spec (`SPEC_SIZE`).
5. Spawn the evaluator and record its report (see Fixed rules). On a later round also
   give it the previous `blocking` findings and the producer's summary of what changed.
6. `FAIL`: spawn the producer again with the findings; repeat from 3. A finding that is
   a reversible detail gets a default, not a question. Stop and ask the
   user when `record-eval` returns `limitReached: true` (third failed round) or
   `plateau: true` (the same blocking findings two rounds in a row). Show the remaining
   blocking findings and the user's options: `/peos:revise <stage> <feedback>` to
   redirect the work, `/peos:retry <key>` to try again as is, or stop.
   `BLOCKED`: report what the evaluator could not assess and ask the user.
7. Spec `PASS`: say so in one line and continue with the plan stage in the same turn.
   Plan `PASS`: show both producers' summary lines together (at most about eight lines),
   the count of remaining non-blocking findings and both artifact paths, then end your
   turn with: approve with `/peos:approve`, or request changes with
   `/peos:revise <spec|plan> <feedback>`.

Until that approval the spec is not frozen. When a user's answer or an evaluator finding
at the plan stage changes the spec, spawn the spec-writer with the change, evaluate the
new spec, then revise the plan and evaluate it; do not ask for `/peos:revise`. Recording
the new spec evaluation discards the plan evaluation. Once the gates are approved, a
change of scope needs the user's `/peos:revise`.

After the approval, continue with section 4 in the same turn: the approved spec and plan
are the user's consent to implement them.
