---
id: refactor-http-routes
fixture: notes
expect: refactor / small or standard
---
handle() in src/http.js is one growing if-chain. Restructure it into a small route table so adding a route does not mean editing the chain. Behavior must stay exactly the same.

## Scoring

- Existing tests pass with their assertions unchanged.
- Characterization tests for every route and the 404 fallbacks were added before the change, or the existing tests already pinned them.
- Each route is one entry; no new dependency; no behavior change (statuses, bodies).
- No question was asked.
