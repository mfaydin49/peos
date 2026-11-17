// In-memory note store. A note: { id, title, body, tags, createdAt }.
export function createStore(now = () => new Date()) {
  const notes = new Map();
  let nextId = 1;
  return {
    add({ title, body = '', tags = [] }) {
      if (typeof title !== 'string' || !title.trim()) throw new RangeError('title is required');
      const note = { id: nextId++, title: title.trim(), body, tags: [...tags], createdAt: now().toISOString() };
      notes.set(note.id, note);
      return note;
    },
    get: id => notes.get(id) ?? null,
    remove: id => notes.delete(id),
    all: () => [...notes.values()]
  };
}
