# UI evaluation rubric

Input: the spec's "User interface" section and criteria, the plan's state-reaching
instructions, `design.md` when the run has one, the project profile's "Design system",
`changes.diff`, the UI triggers, and one source of observation: screenshots from a
ui-capture manifest or the run's local preview. You judge what is visible, not the code.

## Procedure

1. From the spec and the plan, list the screen, state, viewport and color scheme
   combinations the criteria and the spec's screen table need. Cap at 12 observations
   per round; when more are needed, observe every interface criterion once at its stated
   viewport and name what you skipped in `notAssessed`. On a later round, observe again
   the combinations behind the previous findings plus one per changed screen.
2. For each combination: with screenshots, open the matching image; with a preview,
   open the route, set the viewport and scheme, reach the state as the plan says, take a
   screenshot and read the main region's accessibility tree and the console errors.
3. Judge against the rules below. A criterion is `met` only when an observation showed
   it; its `evidence` names the screen, state, viewport and what was visible (the image
   file name when there is one).
4. `mode` is `full` when every listed combination was observed, otherwise `degraded`.

## Blocking (`high`)

- An interface criterion not visible in its stated screen, state or viewport.
- A state the spec lists missing, or showing raw errors, `undefined`, `null`,
  placeholder text, an endless spinner or an empty screen without explanation.
- Broken layout at a configured viewport: horizontal page scroll, clipped, truncated
  without intent or overlapping text or controls, a primary action off-screen or under
  the keyboard, content under the status bar or home indicator.
- Text unreadable in a configured color scheme on content the change introduced (for
  example dark text on a dark surface, or contrast clearly under 4.5:1).
- An interactive element without an accessible name, or not reachable by keyboard on
  the web, where a criterion involves it.
- A new console error on load or on a criterion's interaction.
- A `serious` or `critical` `a11y` entry from the manifest on a changed screen.

## Medium

- A value or component that ignores `design.md` or the profiled design system: a color,
  font, spacing or radius visibly outside the tokens, a hand-built control where the
  platform or library has one, a screen that does not match its described layout.
- Platform conventions broken without a reason in the design (navigation, controls,
  system font, safe areas), missing focus indication, touch targets visibly smaller
  than 44 pt (iOS), 48 dp (Android) or 24 px (web).

## Low

Alignment and spacing nits, copy suggestions.

## Not findings

Taste, a redesign the spec did not ask for, states the spec does not list, screens the
diff does not touch unless the change broke them, pixel differences from the static
design preview (it approximates native controls). A finding names the screen, state,
viewport and scheme, and what is visibly wrong; put the screen file in `file` when the
diff shows which one renders it.
