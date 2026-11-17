# PEOS — design gate

- Status: Implemented (increment 7d)
- Date: 2026-11-08
- Scope: extends [peos-next.md](peos-next.md) §5; [eval-ui.md](eval-ui.md) judges the
  rendered result later

## 1. Problem

The Artlas run built a new iOS application without any design decision: the spec had no
place for screens or states, no agent chose a visual direction, tokens or layout, and
the implementer improvised colors and spacing screen by screen. `rules/ui-ux.md` was six
lines of general guidance. Nothing at a gate showed the user what the app would look
like before it was built.

## 2. Decision

A run whose spec introduces new user interface gets a `design` gate between the
architecture and the plan, with its own producer and evaluation.

- **Spec.** `spec.md` gets a `## User interface` section, removed when the change has
  no interface: a `Design: new` or `Design: existing` line, the screens with the states
  each must show, and the visual direction the user gave. `Design: new` (a new
  application, new screens or a visual direction to set) asks for a design;
  `Design: existing` follows the existing screens and the project's design system.
- **Gate presence.** `next` adds a pending `design` gate to a `standard` or `large` run
  whose `spec.md` has `Design: new` (emphasis and code marks around it are ignored), and
  removes one not approved on the current spec when the line is gone. Gate order: spec, architecture, design, plan.
- **Designer.** `peos:designer` writes `design.md` (visual direction, tokens for color,
  typography, spacing, radius and motion in light and dark, components, every screen
  with layout and states, platform conventions and accessibility) and a self-contained
  `design-preview.html` that renders the tokens and the main screens. In an existing
  project it extends the profiled design system instead of inventing one.
- **Evaluation.** (Since 7f: `eval-design`, key `design`, which looks at the preview
  rendered; see [quality-loop.md](quality-loop.md).) `eval-plan` with focus `design` (key `plan-design`) judged the design
  against the spec and the architecture.
- **Freshness.** The design's hash covers `design.md` and the preview, so a fix to either
  is evaluated again and a preview changed after approval makes the gate stale. A new
  evaluation of an artifact drops the evaluations of every later gate (a standard run
  approves them together, so they must judge the current spec and design). A design gate
  not approved on the current spec goes when the spec drops `Design: new`.
- **Decision.** A `large` run decides the design at its own gate, with the preview path
  shown. A `standard` run passes the design on its `PASS` and decides spec, design and
  plan together at the plan gate.
- **Use.** The planner makes the first interface step create the theme (tokens) from
  `design.md`, and each interface step names the screens it builds; the implementer and
  the code evaluators get `design.md`, and `quality` judges the code against it.
- **Re-approval.** A changed `design.md` changes every step digest, like the
  architecture ([eval-economy.md](eval-economy.md)).

## 3. Acceptance criteria

- AC-1: The spec template has the `User interface` section; `eval-spec` blocks an
  interface criterion that names no screen or state, and an `app` with an interface
  whose spec does not say `Design: new`.
- AC-2: `next` adds the `design` gate when the spec says `Design: new` on a `standard`
  or `large` run, removes an unapproved one when it no longer does, and never adds one
  on `trivial` or `small` runs.
- AC-3: The design gate spawns `peos:designer` with the spec, architecture, profile,
  design references, template and both output paths, then `eval-plan` with focus
  `design`; a `large` run stops at a `design` gate whose artifacts include the preview.
- AC-4: A `standard` run with a design evaluates spec, design and plan and asks for one
  decision; `approve plan` approves all three.
- AC-5: `approve`, `revise`, the approval hook, the stop hook and the state guard know
  the gate; the designer may write only `design.md` and `design-preview.html`.
- AC-6: The planner, implementer and code evaluators receive `design.md` when the run
  has one; a changed design changes every step digest.
- AC-7: `rules/ui-ux.md` states concrete rules (tokens only, states, touch targets,
  contrast, dynamic type, dark mode, platform conventions).
- AC-8: Unit tests cover AC-2 to AC-6; the existing suite passes.

Non-goals: rendering or screenshots of the built app ([eval-ui.md](eval-ui.md)),
generating image assets, a design tool integration.

## 4. Risks

- The preview is HTML; on iOS or Android it approximates native controls. It shows
  direction, tokens and layout, not pixel-exact screens.
- A model's design taste is uneven. The user sees the preview at the gate and can
  revise it before any code is written; the evaluator judges fit and accessibility, not
  taste.
- `Design: existing` on a change that really needs new design skips the gate. The spec
  evaluation checks the line against the request.
