// Maps a request ({ method, path, query, body }) to a response ({ status, body }).
import { listNotes } from './query.js';

export function handle(store, { method, path, query = {}, body }) {
  if (method === 'GET' && path === '/notes') {
    return { status: 200, body: listNotes(store, { page: Number(query.page ?? 1), size: Number(query.size ?? 10) }) };
  }
  if (method === 'POST' && path === '/notes') {
    try { return { status: 201, body: store.add(body ?? {}) }; }
    catch (error) { return { status: 400, body: { error: error.message } }; }
  }
  const id = /^\/notes\/(\d+)$/.exec(path)?.[1];
  if (id && method === 'GET') {
    const note = store.get(Number(id));
    return note ? { status: 200, body: note } : { status: 404, body: { error: 'not found' } };
  }
  if (id && method === 'DELETE') return store.remove(Number(id)) ? { status: 204, body: null } : { status: 404, body: { error: 'not found' } };
  return { status: 404, body: { error: 'not found' } };
}
