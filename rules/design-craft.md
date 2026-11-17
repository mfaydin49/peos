# Design craft

What separates an interface a designer made from a generated one. Every rule is something
a person can point at on the screen. The designer follows them; the design and UI
evaluators check them in what is rendered. A direction the user asked for in the spec
or `## Answers` overrides a rule it contradicts: record that under Decisions.

## Direction

- Start from the product: who uses it, how often, on what device, in what mood. State
  the direction as three adjectives and one thing it is not ("calm, dense, precise; not
  playful"), and make every later choice follow from it.
- In an existing project the direction is the one its screens already have.

## Hierarchy and layout

- One primary action per screen, visibly the strongest element; secondary actions are
  quieter (outline, text or neutral), never a second filled accent button beside it.
- At most three levels of text emphasis on a screen (title, body, secondary). Emphasis
  comes from size and weight first, color last.
- Related things sit closer together than unrelated things; every gap is a step of the
  spacing scale; a screen has one page margin.
- Elements share edges: one left edge for a column of content, baselines aligned in a
  row. Text is left-aligned (start-aligned); centered text only for a short, single
  message such as an empty state.
- Homogeneous rows are a list or a table, not a grid of cards. A card is for a
  self-contained object; a section is separated by space or one hairline, not boxed.
- Width is used on purpose: body text 45 to 75 characters per line, forms and reading
  columns capped, tables and dashboards may fill.

## Color and surface

- Neutrals carry the interface; one accent hue marks the primary action, selection and
  links, and nothing decorative. Success, warning and error colors mean only that.
- Neutrals lean slightly toward the accent's hue instead of pure gray; pure black on
  pure white is avoided for long text.
- Depth by one means per level: a border or a shadow, not both; shadows are soft, short
  and neutral. One radius scale, the same radius for the same kind of component.
- No gradient fills on backgrounds, buttons or text, no glow, no glass blur, no
  decorative blobs or patterns, unless the direction asks for them.
- Dark is designed, not inverted: raised surfaces get lighter, the accent is adjusted
  for contrast, borders replace shadows.

## Type and content

- The platform's system font, or one family the project already ships. Sentence case;
  no all-caps sentences; no letter-spaced body text.
- Numbers that are compared are right-aligned with tabular figures; units and dates in
  one format.
- Real, plausible content everywhere it is shown: names, amounts, dates, one long value
  and one short. Never lorem ipsum, "Item 1", "John Doe", "Lorem Corp" or round fake
  numbers repeated.
- Copy says what the thing is and what happens next, in the product's words: no
  marketing taglines, exclamation marks or filler subtitles inside an application.
- Icons come from one set (the platform's), at one weight and size per context, and only
  where they carry meaning. Never emoji as icons; no icon in a colored circle as
  decoration.

## States

- Empty, loading and error states are designed like the default one: an empty state
  says what belongs here and offers the action that fills it; an error says what
  happened and how to recover, where it happened.
- Interactive elements show default, hover or pressed, focused and disabled; focus is
  visible.

## Signs of a generated interface

Each of these, visible without a reason in the direction, is a defect: a purple or blue
gradient hero or header; emoji used as icons; every block centered; every group in a
rounded shadowed card; three identical cards in a row as the main layout; pill badges on
everything; more than one accent hue; oversized radii on all elements; a tagline under
every title; placeholder names and numbers; an icon in a tinted circle before each list
item; uniform spacing that ignores grouping.
