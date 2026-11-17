// Listing notes, newest first, page by page.
export function paginate(items, page = 1, size = 10) {
  const pages = Math.floor(items.length / size);
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, pages, total: items.length };
}
export function listNotes(store, { page, size } = {}) {
  const newestFirst = store.all().sort((a, b) => b.id - a.id);
  return paginate(newestFirst, page, size);
}
