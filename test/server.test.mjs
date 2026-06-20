// server.test.mjs — /api/videos listing: PDFs surface only for video-less stems.
import test from 'node:test';
import assert from 'node:assert/strict';
import server from '../server.js'; // CommonJS default import; require.main guard => no socket bind
const { listVideos } = server;

test('listVideos tags videos and surfaces PDF-only submissions as kind:pdf', () => {
  const all = listVideos();
  const videos = all.filter((v) => v.kind === 'video');
  const pdfs = all.filter((v) => v.kind === 'pdf');

  // Every entry is classified.
  assert.ok(all.every((v) => v.kind === 'video' || v.kind === 'pdf'));

  // The two video-less submissions become PDF entries.
  assert.deepEqual(
    pdfs.map((p) => p.name).sort(),
    ['auto-accept/uist26a-sub1771-i7.pdf', 'auto-accept/uist26a-sub5059-i7.pdf']
  );
  assert.equal(pdfs[0].type, 'application/pdf');
  assert.equal(pdfs.find((p) => p.name.includes('1771')).category, 'auto-accept');

  // PDFs that have a sibling video are NOT listed (e.g. sub3869 has a .mov).
  assert.ok(!all.some((v) => v.name === 'auto-accept/uist26a-sub3869-i7.pdf'));

  // The video count is unchanged (33 playable videos in the dataset).
  assert.equal(videos.length, 33);
});
