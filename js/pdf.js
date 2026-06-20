// pdf.js — PDF.js wrapper (shared interface for player and UI).
// Handles document loading and page rendering via the vendored Mozilla PDF.js.

import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';

// Configure the worker to use the vendored distribution, served locally.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

// Per-URL document cache: one in-flight Promise per URL.
const _docs = new Map();

/**
 * Load a PDF document from a URL, deduplicating concurrent loads.
 * @param {string} url - The PDF URL (local or absolute).
 * @returns {Promise<{ doc, numPages }>} The parsed PDF doc and page count.
 */
export function loadDoc(url) {
  if (_docs.has(url)) return _docs.get(url);
  const promise = pdfjsLib.getDocument(url).promise.then((doc) => ({ doc, numPages: doc.numPages }));
  promise.catch(() => _docs.delete(url));
  _docs.set(url, promise);
  return promise;
}

/**
 * Render a 1-based page of a PDF document to a canvas.
 * Scales the page so its longest dimension fits opts.maxDim (default 1600).
 * Sets canvas width/height, fills white, then renders.
 * @param {Object} doc - The PDF document (from loadDoc).
 * @param {number} pageNum - 1-based page number.
 * @param {HTMLCanvasElement} canvas - Target canvas element.
 * @param {Object} [opts={}] - Options.
 * @param {number} [opts.maxDim=1600] - Maximum dimension in CSS pixels.
 * @returns {Promise<void>}
 */
export async function renderPage(doc, pageNum, canvas, opts = {}) {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const maxDim = opts.maxDim ?? 1600;
  const scale = maxDim / Math.max(viewport.width, viewport.height);
  const scaledViewport = page.getViewport({ scale });
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
}
