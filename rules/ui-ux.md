# UI/UX

- Use the project's design system and, in a run with a design, `design.md`. Every
  color, font, spacing, radius, elevation and duration comes from a token in the theme;
  no literal values in screens. Reuse existing components before adding one.
- Follow the platform: Apple Human Interface Guidelines on iOS and macOS (system font
  and text styles, SF Symbols, navigation and tab bars, sheets), Material on Android,
  native elements and semantics on the web. Do not imitate one platform on another.
- Every screen shows each state that applies: loading, empty (with the next action),
  error (what happened and how to recover), pending, success, disabled and destructive
  confirmation. No raw errors, `undefined`, placeholder or meaningless default text.
- Accessibility: text contrast at least 4.5:1 (3:1 for large text and controls) in
  light and dark; touch targets at least 44 pt on iOS, 48 dp on Android, 24 px on the
  web; text scales with dynamic type or browser zoom without clipping; every
  interactive element has an accessible name, keyboard or switch access and visible
  focus; respect reduced motion.
- Support dark mode wherever the platform does, unless the spec rules it out.
- Layout adapts to the smallest supported width (320 pt/px) and to landscape where the
  platform allows; no horizontal page scroll, clipped or overlapping text, or primary
  action off-screen.
- Verify the relevant sizes, schemes and interactions; record what was actually seen,
  or say plainly what could not be observed.
