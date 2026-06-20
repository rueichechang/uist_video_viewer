// pdf-store.test.mjs — PDF clip data model (defaults + normalization).
import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../js/store.js';

function reset() {
  store.persist = () => {};            // no localStorage in Node
  store.doc = { schemaVersion: 2, options: {}, clips: {} };
  store.durations = {};
  store.pageCounts = {};
}

test('reconcile creates a PDF clip with default pages 1..10 @ 6s', () => {
  reset();
  store.reconcile([
    { name: 'auto-accept/uist26a-sub1771-i7.pdf', kind: 'pdf', type: 'application/pdf', size: 10, mtimeMs: 20, url: '' },
  ]);
  const clip = store.doc.clips['auto-accept/uist26a-sub1771-i7.pdf'];
  assert.equal(clip.kind, 'pdf');
  assert.equal(clip.pages.length, 10);
  assert.deepEqual(clip.pages[0], { page: 1, seconds: 6 });
  assert.deepEqual(clip.pages[9], { page: 10, seconds: 6 });
  assert.equal(clip.pageCount, null);
});

test('reconcile still creates a video clip with segments', () => {
  reset();
  store.reconcile([
    { name: 'a/clip.mp4', kind: 'video', type: 'video/mp4', size: 1, mtimeMs: 2, url: '' },
  ]);
  const clip = store.doc.clips['a/clip.mp4'];
  assert.equal(clip.kind, 'video');
  assert.ok(Array.isArray(clip.segments));
  assert.equal(clip.pages, undefined);
});

test('normalizeDoc (via parseImport) sorts, dedupes, and floors page seconds', () => {
  reset();
  const res = store.parseImport(JSON.stringify({
    schemaVersion: 2,
    clips: {
      'x.pdf': {
        kind: 'pdf', title: 'X',
        pages: [{ page: 3, seconds: 2 }, { page: 1, seconds: 0.1 }, { page: 3, seconds: 9 }],
      },
    },
  }));
  assert.ok(res.ok);
  const c = res.doc.clips['x.pdf'];
  assert.equal(c.kind, 'pdf');
  // sorted ascending; page 3 de-duped (first wins); 0.1 floored to MIN 0.5
  assert.deepEqual(c.pages, [{ page: 1, seconds: 0.5 }, { page: 3, seconds: 2 }]);
});

test('normalizeDoc gives a PDF clip with no pages the default list', () => {
  reset();
  const res = store.parseImport(JSON.stringify({
    schemaVersion: 2, clips: { 'y.pdf': { kind: 'pdf', title: 'Y', pages: [] } },
  }));
  assert.equal(res.doc.clips['y.pdf'].pages.length, 10);
});
