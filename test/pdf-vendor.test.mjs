// pdf-vendor.test.mjs — tests for js/pdf.js wrapper.
//
// Run with: node --test test/pdf-vendor.test.mjs
// Tests presence and parsing of the vendored PDF.js module.

import test from 'node:test';
import assert from 'node:assert/strict';

test('pdf.js wrapper module can be imported', async () => {
  const pdf = await import('../js/pdf.js');
  assert.ok(pdf.loadDoc, 'loadDoc function exists');
  assert.ok(pdf.renderPage, 'renderPage function exists');
});

test('vendored PDF.js files are present and accessible', async () => {
  const { readFileSync } = await import('fs');
  const { dirname, join } = await import('path');
  const { fileURLToPath } = await import('url');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pdfMjsPath = join(__dirname, '../js/vendor/pdfjs/pdf.mjs');
  const pdfWorkerPath = join(__dirname, '../js/vendor/pdfjs/pdf.worker.mjs');

  assert.doesNotThrow(() => {
    readFileSync(pdfMjsPath, 'utf8');
  }, 'pdf.mjs can be read');

  assert.doesNotThrow(() => {
    readFileSync(pdfWorkerPath, 'utf8');
  }, 'pdf.worker.mjs can be read');
});
