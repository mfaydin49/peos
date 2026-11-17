import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { handle } from '../src/http.js';

test('a note is created, read and removed', () => {
  const store = createStore(() => new Date('2026-01-01T00:00:00Z'));
  const created = handle(store, { method: 'POST', path: '/notes', body: { title: ' Shopping ', tags: ['home'] } });
  assert.deepEqual([created.status, created.body.title, created.body.tags], [201, 'Shopping', ['home']]);
  assert.equal(handle(store, { method: 'GET', path: '/notes/1' }).body.id, 1);
  assert.equal(handle(store, { method: 'DELETE', path: '/notes/1' }).status, 204);
  assert.equal(handle(store, { method: 'GET', path: '/notes/1' }).status, 404);
});

test('a note needs a title', () => {
  assert.equal(handle(createStore(), { method: 'POST', path: '/notes', body: { title: ' ' } }).status, 400);
});

test('notes are listed newest first, a page at a time', () => {
  const store = createStore();
  for (let index = 1; index <= 20; index++) store.add({ title: `Note ${index}` });
  const first = handle(store, { method: 'GET', path: '/notes', query: { page: '1', size: '10' } }).body;
  assert.deepEqual([first.items[0].title, first.items.length, first.pages, first.total], ['Note 20', 10, 2, 20]);
});
