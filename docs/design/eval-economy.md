# PEOS — evaluation economy

- Status: Implemented (increment 7c)
- Date: 2026-11-08
- Scope: extends [peos-next.md](peos-next.md) §5

## 1. Problem

The first full `app`/`large` run (Artlas, 2026-11-06) used about 208M tokens against a
30M budget; evaluators used two thirds of it:

- Re-approving the plan after a spec revision cleared every step and code evaluation:
  all five milestones were implemented and evaluated again (about 52M tokens) although
  the revision touched the museum seed only.
- Any fix changed the code state, so every evaluator, including those that had passed,
  judged the whole change again (32 of 81 evaluations were such repeats).
- `eval-security` ran 18 times, on every milestone and round.
- Each evaluation read the diff since the run's base commit; by the last milestone it
  passed 512 KB and was cut, so evaluators read files one by one (3–4M tokens each).

## 2. Decision

An evaluation is bound to a code snapshot, and later evaluations judge only what changed
since then.

- **Snapshot.** When a code evaluation is recorded, `peos-run` writes the working tree
  (as Git sees it, without run files) to a Git tree object through a temporary index and
  keeps its ID in the evaluation's state entry (`tree`). Nothing in the working tree or
  the real index changes, and the user's Git hooks do not run.
- **Delta evaluation.** An evaluation that is stale but has a snapshot, or a code
  evaluation of a later milestone, is spawned with `basis: delta`: the diff from the
  snapshot to the current code, its previous report, and the full diff for context. The
  evaluator re-judges what the delta touches, carries over the rest of its previous
  report, and still writes a complete report. A delta larger than half of the full diff,
  or a snapshot Git no longer has, falls back to a full evaluation.
- **Carry-over.** A passed evaluation of the same scope whose delta is empty, and a
  passed security evaluation whose delta has no security trigger, is carried to the
  current code state by `peos-run` without a model (`carried: true` in state, listed in
  `summary.md`). A base (below) judged another milestone's scope or an earlier plan, so
  only security, which judges no criteria, carries from one; `carry-eval` enforces this
  itself. A carry that fails falls back to an evaluator.
- **Milestones.** Completing a milestone before the last keeps each passed code
  evaluation as a base (`evalBases`, report kept as `evals/<key>.base.json`); the next
  milestone's evaluations start from it with `basis: delta`. The acceptance evaluation
  (`code-acceptance`, or `code-all` on smaller tiers) of the last open milestone is
  always full: it judges every criterion. The last open milestone is the one after which
  no milestone is left undone, also when a re-approval kept later ones done.
- **Plan re-approval.** On plan approval `peos-run` records a digest of each step
  (its plan section, the whole text of the criteria it covers and the architecture) and
  of each milestone (its step list). Re-approving a plan keeps steps whose digest is unchanged, and milestones
  whose step list is unchanged and whose steps are all kept; passed code evaluations
  become bases as at a milestone boundary.
- **Smaller diffs.** Sections over 64 KB and lock files, Xcode project files, source maps
  and minified files are listed with their size instead of their content; triggers,
  floor flags and markers are computed before that.

## 3. Acceptance criteria

- AC-1: Recording a code evaluation stores the snapshot tree in its state entry when the
  code did not change while it was taken; the working tree and index are unchanged.
- AC-2: `peos-run delta --run <run> --since <tree>` writes the diff from that tree to the
  current code and returns its size, the full diff size, its security triggers and
  whether it is empty.
- AC-3: `next` spawns a stale evaluation that has a snapshot with `basis: delta`, the
  delta diff and the previous report; a delta over half of the full diff, or a missing
  tree, gives a full evaluation.
- AC-4: A passed security evaluation is carried over a delta with no security trigger,
  and any passed evaluation over an empty delta, without spawning an evaluator.
- AC-5: Completing a non-final milestone turns passed code evaluations into bases; the
  next milestone's evaluations use them with `basis: delta`, except the last milestone's
  acceptance evaluation, which is full. A scoped PASS is still never release evidence.
- AC-6: Re-approving a plan keeps unchanged steps and milestones done; a step whose
  section, covered criteria or architecture changed is implemented again.
- AC-7: Large and generated diff sections are listed, not shown; security triggers still
  see their added lines.
- AC-8: `rules/evaluation.md` defines the delta contract; existing tests pass, and unit
  tests cover AC-1 to AC-7.

Non-goals: changing evaluator models, splitting `eval-code` foci differently, caching
evaluator context across rounds.

## 4. Risks

- A delta evaluator can miss an interaction between changed and unchanged code. The
  delta contract tells it to read further when the change reaches beyond the delta, and
  the last milestone's acceptance evaluation is always full.
- Carry-over trusts the security triggers, which are hints, not proof. A carried PASS is
  named in `summary.md`, so it is visible to the user.
- Spec sections other than the criteria are not in the step digest: a changed goal or
  non-functional requirement with unchanged criteria keeps the steps. The full
  acceptance evaluation at the end judges the result against the current spec.
- Snapshot trees are unreferenced Git objects; `git gc` may prune them after its grace
  period (two weeks by default). A missing tree gives a full evaluation.
