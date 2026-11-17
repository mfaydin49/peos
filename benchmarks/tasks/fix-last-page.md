---
id: fix-last-page
fixture: notes
expect: fix / trivial or small
---
With 25 notes and a page size of 10, the list says there are 2 pages, so the last five notes can never be reached from the page count.

## Scoring

- The page count is 3 for 25 notes and size 10, and stays 2 for 20 notes.
- A regression test fails on the fixture as shipped and passes after the fix.
- The diff touches `src/query.js` and one test file, nothing else.
- No question was asked.
