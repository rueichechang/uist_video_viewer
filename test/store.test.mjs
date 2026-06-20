// store.test.mjs — unit tests for store reconciliation/cleanup logic.
//
// Run with: npm test   (i.e. `node --test`).
// The js/ folder is marked "type":"module" so these ESM imports resolve in Node
// without a build step; the browser ignores that package.json entirely.

import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../js/store.js';

// `store` is a module singleton; reset its clips at the start of each test and
// stub persist() so nothing reaches localStorage (absent in Node).
function seed(clips) {
  store.persist = () => {};
  store.doc.clips = clips;
}

test('forgetMissing removes only the clips flagged missing and returns the count', () => {
  seed({
    'auto-accept/present-1.mp4': { title: 'P1', missing: false },
    'auto-accept/uist26a-sub9141-i8.mp4': { title: '9141', missing: true },
    'auto-accept/uist26a-sub1071-i8.mp4': { title: '1071', missing: true },
    'auto-accept/present-2.mp4': { title: 'P2', missing: false },
  });

  const removed = store.forgetMissing();

  assert.equal(removed, 2);
  assert.deepEqual(Object.keys(store.doc.clips).sort(), [
    'auto-accept/present-1.mp4',
    'auto-accept/present-2.mp4',
  ]);
});

test('forgetMissing is a no-op returning 0 when nothing is missing', () => {
  seed({ 'a.mp4': { title: 'A', missing: false } });

  const removed = store.forgetMissing();

  assert.equal(removed, 0);
  assert.deepEqual(Object.keys(store.doc.clips), ['a.mp4']);
});

test('forgetMissing emits clip-changed only when it actually removed something', () => {
  // Removes -> one event carrying the count.
  seed({ 'gone.mp4': { title: 'G', missing: true }, 'here.mp4': { title: 'H', missing: false } });
  let events = [];
  store.on('clip-changed', (e) => events.push(e.detail));
  const removed = store.forgetMissing();
  assert.equal(removed, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].removedMissing, 1);

  // No missing clips -> no event.
  seed({ 'here.mp4': { title: 'H', missing: false } });
  events = [];
  assert.equal(store.forgetMissing(), 0);
  assert.equal(events.length, 0);
});
