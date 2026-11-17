---
id: feature-tag-filter
fixture: notes
expect: feature / small or standard
---
Let me filter the note list by tag: GET /notes?tag=home should return only notes with that tag, still paged and newest first. An unknown tag is just an empty list.

## Scoring

- `?tag=` filters before paging, so `pages` and `total` describe the filtered list.
- Without `tag` the list is unchanged; existing tests pass unmodified.
- The filter lives beside the listing logic (`src/query.js`), not in `src/http.js`.
- Tests cover a matching tag, an unknown tag, and paging of a filtered list.
- At most one question was asked.
