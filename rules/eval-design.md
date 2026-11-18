# Design evaluation rubric

Input: `design.md`, `design-preview.html` and where it is served (`preview url`),
`spec.md`, and `architecture.md`, the project profile and the design references when
given; in an existing project, the theme and component files the design says it extends.
You judge the design as written and as rendered against the spec, the platform,
accessibility, the existing design system and `rules/design-craft.md`.

## Procedure

1. Read the spec's "User interface" section and interface criteria, then `design.md`.
2. Look at the preview rendered. With a `preview url`, open it in the isolated browser
   you have (the built-in browser pane or Playwright, never the user's own Chrome), at a
   desktop width (1440) and, for a mobile or responsive product, a phone width (390);
   take a full-page screenshot when the tool has one, otherwise one per part of the
   page (at most 5 images in all: each stays in your context and is read again on every
   later step), and read
   the page text and the console messages once: a blocked script or network request
   there shows the preview tried to run or load one. Open only that URL; do not click, type or run scripts.
3. Without a usable browser or URL, read `design-preview.html` as source instead, set
   `mode` to `degraded`, name "rendered preview not observed" in `notAssessed`, and
   report as craft findings only what the source shows beyond doubt. Never `BLOCKED` for
   a missing browser.
4. Use `criteria` for each `AC-n` about the interface: `met` when a screen and state of
   the design shows it, otherwise `not_met`; leave other criteria out.

## Blocking (`high`)

Fit:

- A screen or state the spec's "User interface" section lists that the design does not
  describe, or an interface criterion no screen shows.
- A color used for text without a token pair, or a text pair below WCAG AA (4.5:1, 3:1
  for large text) in either scheme the spec requires; touch targets below the platform
  minimum; no dark values when the spec or platform requires dark mode.
- Tokens or components that replace an existing design system's without a stated reason.
- A font, icon set or asset that needs a dependency the architecture does not list.
- A preview that is missing, loads anything from the network, runs script or
  contradicts `design.md` (a color, size or component the tokens do not define).
- An open question left for the implementer.

Craft, as rendered (each names the screen and what is visible):

- A sign listed under "Signs of a generated interface" in `rules/design-craft.md`
  without a reason in the direction.
- A screen with no single strongest action, or two filled accent actions side by side.
- Broken rendering: overlapping, clipped or overflowing text or controls, a horizontal
  scrollbar, elements visibly off their shared edge.
- Placeholder or filler content on a screen.
- The same kind of component drawn two ways (radius, border, shadow, padding).
- A dark scheme that is the light one inverted (same surface for every level, accent
  unreadable).
- No direction stated, or screens that contradict the stated one.

## Medium

Other rules of `rules/design-craft.md` visibly not followed: spacing that ignores
grouping, more than three levels of text emphasis, cards around homogeneous rows, line
length outside 45 to 75 characters for body text, mixed icon weights, a state designed
with less care than the default one, a platform convention not followed without a reason.

## Low

Single alignment or spacing nits, copy suggestions, a component that could reuse an
existing one.

## Not findings

Whether you would have chosen another direction, palette or layout; anything the user
decided in the spec or `## Answers`; native control details the static preview only
approximates. A finding names the screen and what is visibly wrong and gives the change
that fixes it.
