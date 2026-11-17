---
id: app-habits
fixture: empty
expect: app / large
---
Build a small habit tracker web app. I add habits (a name and how many times a week), tick them off each day, and see my current streak per habit and this week at a glance. It runs in the browser, keeps my data on my device, and should feel calm and focused, something I would open every morning.

## Scoring

- The app starts with one command, and its test, lint and typecheck commands pass.
- Adding a habit, ticking it today, reloading and seeing it still ticked all work.
- The streak is correct across a missed day and across a week boundary.
- Empty state (no habits yet) says what to do and offers the action.
- Layout holds at 390 px and 1440 px, in light and dark.
- The interface shows none of the "Signs of a generated interface" in `rules/design-craft.md`.
- Source files sit where `architecture.md` "Structure" says; the boundary rule runs in `lint`.
- At most four questions were asked, in one round, and two decisions were needed (direction, plan).
