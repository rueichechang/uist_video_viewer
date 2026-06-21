// resume.test.mjs — resume snapshot persistence + resolution against a playlist.
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage stub (Node has none without --localstorage-file).
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: (k) => { _ls.delete(k); },
};

const { store } = await import('../js/store.js');

const SNAP = {
  order: ['a.mp4', 'b.pdf', 'c.mp4'],
  name: 'b.pdf', kind: 'pdf', segIdx: 0, time: 0, pageIdx: 3,
  mode: 'sequential-once', savedAt: '2026-06-20T00:00:00.000Z',
};

test('setResume / getResume / clearResume roundtrip', () => {
  _ls.clear();
  assert.equal(store.getResume(), null);
  store.setResume(SNAP);
  assert.deepEqual(store.getResume(), SNAP);
  store.clearResume();
  assert.equal(store.getResume(), null);
});

test('getResume tolerates garbage and missing name', () => {
  _ls.clear();
  _ls.set('showreel.resume.v1', '{not json');
  assert.equal(store.getResume(), null);
  _ls.set('showreel.resume.v1', JSON.stringify({ order: [], time: 5 })); // no name
  assert.equal(store.getResume(), null);
});

test('resolveResume maps names to indices and locates the active clip', () => {
  const playlist = [
    { name: 'a.mp4' }, { name: 'b.pdf' }, { name: 'c.mp4' },
  ];
  const plan = store.resolveResume(SNAP, playlist);
  assert.deepEqual(plan.order, [0, 1, 2]);
  assert.equal(plan.pos, 1);
  assert.equal(plan.name, 'b.pdf');
  assert.equal(plan.kind, 'pdf');
  assert.equal(plan.pageIdx, 3);
  assert.equal(plan.mode, 'sequential-once');
});

test('resolveResume drops missing names from order and recomputes pos', () => {
  const playlist = [{ name: 'c.mp4' }, { name: 'b.pdf' }]; // a.mp4 gone, reordered
  const plan = store.resolveResume(SNAP, playlist);
  // order maps surviving names in snapshot order: b.pdf->1, c.mp4->0
  assert.deepEqual(plan.order, [1, 0]);
  assert.equal(plan.pos, 0); // b.pdf is first surviving
});

test('resolveResume returns null when the active clip is gone', () => {
  const playlist = [{ name: 'a.mp4' }, { name: 'c.mp4' }]; // b.pdf gone
  assert.equal(store.resolveResume(SNAP, playlist), null);
  assert.equal(store.resolveResume(SNAP, []), null);
  assert.equal(store.resolveResume(null, playlist), null);
});
