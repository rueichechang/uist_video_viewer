#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency static + API server for the Showreel app.
 *
 *   - Serves the front-end (index.html, js/, styles.css, ...) from the project root.
 *   - GET /api/videos  -> JSON list of playable video files found in ./videos
 *   - Serves any file (incl. /videos/<file>) with proper HTTP Range (206) support
 *     so the browser can seek, so trimmed IN/OUT playback works, and so Safari —
 *     which refuses to play/report duration without a compliant 206 — works at all.
 *
 * Design notes (the things people get wrong):
 *   - A MALFORMED or multi-range "Range" header is ignored -> full 200 (RFC 7233),
 *     never 416. A 416 on a harmless-but-odd header stalls Safari's media stack.
 *   - 416 is reserved for WELL-FORMED but unsatisfiable ranges (start past EOF),
 *     and always carries "Content-Range: bytes *​/<size>" so the client can recover.
 *   - createReadStream's {start,end} `end` is INCLUSIVE, matching HTTP byte ranges,
 *     so we pass `end` straight through (no +1) and Content-Length = end-start+1.
 *   - Strong ETag ("<size>-<mtimeMs>") + Last-Modified + 304 on the non-range path
 *     lets the browser reuse buffered bytes within a session but refetch if a file
 *     is re-encoded in place (its mtime, hence ETag, changes).
 *   - Path traversal is blocked by canonicalizing (realpath) and requiring the
 *     result to stay inside the project root; this also defeats symlink escapes.
 *
 * Usage:  node server.js [port]      (default port 5173, binds 127.0.0.1)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = fs.realpathSync(__dirname);
const VIDEO_DIR = path.join(ROOT, 'videos');
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

// Extensions the browser can typically decode + their MIME types. (No .mkv:
// neither Chrome nor Safari decode Matroska in <video>; the client also gates
// with canPlayType() since the server can't know codec support.)
const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_TYPES[ext] || STATIC_TYPES[ext] || 'application/octet-stream';
}

function isVideoPath(filePath) {
  return VIDEO_TYPES[path.extname(filePath).toLowerCase()] !== undefined;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  send(res, status, body, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
}

/**
 * Resolve a URL path to a real file inside ROOT, refusing anything that escapes
 * it (path traversal) or that resolves through a symlink to the outside. Returns
 * an absolute *real* path, or null if the request must be rejected (-> 404).
 */
function safeResolve(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (_) {
    return null; // malformed percent-encoding
  }
  if (decoded.indexOf('\0') !== -1) return null; // NUL byte injection
  // Reject any ".." path segment outright before touching the filesystem.
  if (decoded.split('/').some((seg) => seg === '..')) return null;

  const joined = path.normalize(path.join(ROOT, decoded));
  if (joined !== ROOT && !joined.startsWith(ROOT + path.sep)) return null;

  // Canonicalize to defeat symlink escapes; ENOENT here -> 404 upstream.
  let real;
  try {
    real = fs.realpathSync(joined);
  } catch (_) {
    return null;
  }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) return null;
  return real;
}

function listVideos() {
  let entries;
  try {
    entries = fs.readdirSync(VIDEO_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile())
    // Skip dotfiles, incl. macOS .DS_Store and ._AppleDouble files (the latter
    // would otherwise pass the extension test as a phantom 0-byte "video").
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => VIDEO_TYPES[path.extname(e.name).toLowerCase()])
    .map((e) => {
      const full = path.join(VIDEO_DIR, e.name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtimeMs = Math.round(st.mtimeMs);
      } catch (_) {
        /* ignore unreadable entries */
      }
      return {
        name: e.name,
        url: '/videos/' + encodeURIComponent(e.name),
        type: VIDEO_TYPES[path.extname(e.name).toLowerCase()],
        size,
        mtimeMs,
      };
    })
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
}

/**
 * Stream a file to the response with HTTP Range support + conditional GET.
 */
function serveFile(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return send(res, 404, 'Not found');
  }
  if (!stat.isFile()) return send(res, 404, 'Not found');

  const total = stat.size;
  const type = contentType(filePath);
  const video = isVideoPath(filePath);
  const etag = `"${total}-${Math.round(stat.mtimeMs)}"`;

  const baseHeaders = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    // Revalidate every session: lets the browser reuse buffered bytes via the
    // ETag yet catch an in-place re-encode. App assets also no-cache so edits show.
    'Cache-Control': 'no-cache',
  };

  const range = req.headers.range;

  // Conditional GET (only meaningful on the full-file path, not on ranges).
  if (!range) {
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    const notModified =
      (inm && inm.split(',').some((t) => t.trim() === etag)) ||
      (!inm && ims && !Number.isNaN(Date.parse(ims)) &&
        Math.floor(stat.mtime.getTime() / 1000) <= Math.floor(Date.parse(ims) / 1000));
    if (notModified) {
      res.writeHead(304, baseHeaders);
      return res.end();
    }
  }

  // Parse a single well-formed byte range. Anything else (malformed, multi-range,
  // empty-empty) is ignored -> full 200, per RFC 7233.
  let parsedRange = null;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && !(m[1] === '' && m[2] === '')) {
      let start;
      let end;
      if (m[1] === '') {
        // suffix range: last N bytes
        start = Math.max(0, total - Number(m[2]));
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
      }
      if (Number.isFinite(start) && Number.isFinite(end)) {
        parsedRange = { start, end };
      }
    }
  }

  if (parsedRange) {
    const { start, end } = parsedRange;
    if (start > end || start >= total) {
      return send(res, 416, 'Requested range not satisfiable', {
        'Content-Range': `bytes */${total}`,
        ETag: etag,
      });
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': chunkSize,
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  }

  // No (satisfiable) range: full file.
  res.writeHead(200, { ...baseHeaders, 'Content-Length': total });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  return stream.pipe(res);
}

function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  let parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch (_) {
    return send(res, 400, 'Bad request');
  }
  let pathname = parsed.pathname;

  if (pathname === '/api/videos') {
    try {
      return sendJson(res, 200, { videos: listVideos() });
    } catch (err) {
      return sendJson(res, 500, { error: String((err && err.message) || err) });
    }
  }

  if (pathname === '/') pathname = '/index.html';

  const resolved = safeResolve(pathname);
  if (!resolved) return send(res, 404, 'Not found'); // 404, not 403, to avoid info leak

  return serveFile(req, res, resolved);
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    /* eslint-disable no-console */
    console.log(`\n  Showreel running:  http://${HOST}:${PORT}\n`);
    console.log(`  Serving app from:       ${ROOT}`);
    console.log(`  Looking for videos in:  ${VIDEO_DIR}`);
    console.log(`\n  Drop .mp4/.mov/.webm files into ./videos and reload.\n`);
  });
}

module.exports = { handler, server, listVideos, safeResolve };
