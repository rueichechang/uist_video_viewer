// pdf.js — PDF.js wrapper (shared interface for player and UI).
// Handles document loading and page rendering via the vendored Mozilla PDF.js.

import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';

// Configure the worker to use the vendored distribution, served locally.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

// Per-URL document cache: one fetch/parse per PDF per session.
const docCache = new Map();

/**
 * Load a PDF document from a URL, caching the parsed doc.
 * @param {string} url - The PDF URL (local or absolute).
 * @returns {Promise<{ doc, numPages }>} The parsed PDF doc and page count.
 */
export async function loadDoc(url) {
  if (docCache.has(url)) {
    const { doc, numPages } = docCache.get(url);
    return { doc, numPages };
  }

  const doc = await pdfjsLib.getDocument(url).promise;
  const numPages = doc.numPages;
  docCache.set(url, { doc, numPages });
  return { doc, numPages };
}

/**
 * Render a 1-based page of a PDF document to a canvas.
 * Scales the page to fit the canvas box (preserves aspect ratio, white background).
 * @param {Object} doc - The PDF document (from loadDoc).
 * @param {number} pageNum - 1-based page number.
 * @param {HTMLCanvasElement} canvas - Target canvas element.
 * @returns {Promise<void>}
 */
export async function renderPage(doc, pageNum, canvas) {
  const page = await doc.getPage(pageNum);

  // Get the page's native viewport (in user space units).
  const viewport = page.getViewport({ scale: 1 });

  // Calculate scale to fit the canvas while preserving aspect ratio.
  const canvasWidth = canvas.clientWidth || canvas.width;
  const canvasHeight = canvas.clientHeight || canvas.height;
  const scaleX = canvasWidth / viewport.width;
  const scaleY = canvasHeight / viewport.height;
  const scale = Math.min(scaleX, scaleY);

  // Create a scaled viewport.
  const scaledViewport = page.getViewport({ scale });

  // Set canvas dimensions to match the scaled viewport.
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;

  // Render the page to the canvas with a white background.
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const renderContext = {
    canvasContext: ctx,
    viewport: scaledViewport,
  };

  await page.render(renderContext).promise;
}
