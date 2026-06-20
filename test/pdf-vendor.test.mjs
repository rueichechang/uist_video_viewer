// pdf-vendor.test.mjs — sanity-check the vendored PDF.js distribution.
//
// Run with: node --test test/pdf-vendor.test.mjs
// Does NOT import js/pdf.js (that would load the PDF.js worker in Node).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('vendored pdf.mjs is present', () => {
  const p = join(__dirname, '../js/vendor/pdfjs/pdf.mjs');
  assert.doesNotThrow(() => readFileSync(p), `pdf.mjs not found at ${p}`);
});

test('js/pdf.js exports loadDoc and renderPage (source check)', () => {
  const src = readFileSync(join(__dirname, '../js/pdf.js'), 'utf8');
  assert.match(src, /export.*function loadDoc/);
  assert.match(src, /export.*function renderPage/);
});
