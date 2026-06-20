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

test('setPageCount clamps the page list to the real page count', () => {
  reset();
  const v = { name: 'p.pdf', kind: 'pdf', type: 'application/pdf', size: 1, mtimeMs: 1, url: '' };
  store.reconcile([v]);                       // default pages 1..10
  store.setPageCount(v, 18);                  // 18-page PDF: keep 1..10
  assert.equal(store.doc.clips['p.pdf'].pages.length, 10);
  store.setPageCount(v, 5);                   // shrink: keep 1..5
  assert.deepEqual(store.doc.clips['p.pdf'].pages.map((x) => x.page), [1, 2, 3, 4, 5]);
  assert.equal(store.doc.clips['p.pdf'].pageCount, 5);
});

test('setPageCount resets to defaults when every page is out of range', () => {
  reset();
  const v = { name: 'q.pdf', kind: 'pdf', type: 'application/pdf', size: 1, mtimeMs: 1, url: '' };
  store.reconcile([v]);
  store.doc.clips['q.pdf'].pages = [{ page: 50, seconds: 6 }, { page: 99, seconds: 6 }];
  store.setPageCount(v, 3);                   // all dropped -> reset to 1..3
  assert.deepEqual(store.doc.clips['q.pdf'].pages.map((x) => x.page), [1, 2, 3]);
});

test('trimmedLength sums per-page seconds for a PDF clip', () => {
  reset();
  const clip = { kind: 'pdf', pages: [{ page: 1, seconds: 6 }, { page: 2, seconds: 4 }, { page: 5, seconds: 2 }] };
  assert.equal(store.trimmedLength(clip), 12);
});

test('clipValidity for PDF clips: needs a title and >=1 in-range page', () => {
  reset();
  const ok = { kind: 'pdf', title: 'Paper', missing: false, pages: [{ page: 1, seconds: 6 }], pageCount: 10 };
  assert.equal(store.clipValidity(ok, null).valid, true);

  const noTitle = { kind: 'pdf', title: '', missing: false, pages: [{ page: 1, seconds: 6 }], pageCount: 10 };
  assert.deepEqual(store.clipValidity(noTitle, null).reasons.includes('needs title'), true);

  const noPages = { kind: 'pdf', title: 'P', missing: false, pages: [{ page: 99, seconds: 6 }], pageCount: 3 };
  assert.equal(store.clipValidity(noPages, null).valid, false);

  const missing = { kind: 'pdf', title: 'P', missing: true, pages: [{ page: 1, seconds: 6 }], pageCount: 3 };
  assert.deepEqual(store.clipValidity(missing, null).reasons.includes('file missing'), true);
});
