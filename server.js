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

// Sidecar caption files, matched to a video by filename stem (see captionStem).
const CAPTION_TYPES = new Set(['.srt', '.vtt', '.txt']);

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
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

/**
 * Reduce a filename to the stem shared between a clip and its caption sidecar:
 * drop the extension, then the trailing instance tag (e.g. "-i8", "-i42") so
 * "uist26a-sub3869-i8.mov" and "uist26a-sub3869-i42.txt" both map to
 * "uist26a-sub3869".
 */
function captionStem(name) {
  return name.replace(/\.[^.]+$/, '').replace(/-i\d+$/i, '');
}

/** Percent-encode a relative path, keeping "/" separators intact. */
function encodePath(rel) {
  return rel.split('/').map(encodeURIComponent).join('/');
}

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

/**
 * Recursively collect files under `dir`, recording each one's path relative to
 * VIDEO_DIR (POSIX separators) and the relative directory it lives in. Dotfiles
 * and dot-directories (.DS_Store, ._AppleDouble, .git, …) are skipped so they
 * never pass the extension test as phantom entries.
 */
function walkFiles(dir, relBase, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      walkFiles(path.join(dir, e.name), rel, out);
    } else if (e.isFile()) {
      out.push({ name: e.name, rel, dir: relBase });
    }
  }
}

/**
 * List every playable video anywhere under videos/ (including category
 * subfolders like videos/auto-accept/). Each entry's `name` is its path
 * relative to videos/ — the stable identity the client keys clips by — and
 * `category` is its top-level subfolder ('' for files sitting directly in
 * videos/). A caption sidecar is matched only within the SAME folder.
 */
function listVideos() {
  const all = [];
  walkFiles(VIDEO_DIR, '', all);

  // Index caption sidecars by (folder, stem) so a clip only claims a caption
  // beside it (unchanged from before).
  const captions = new Map();
  for (const f of all) {
    if (CAPTION_TYPES.has(path.extname(f.name).toLowerCase())) {
      const key = `${f.dir}\0${captionStem(f.name)}`;
      if (!captions.has(key)) captions.set(key, f.rel);
    }
  }

  // Group every file by (folder, submission stem). A stem with a video plays as
  // a video; a stem with no video but a PDF plays as a PDF slideshow.
  const groups = new Map(); // key -> { videos: [f], pdfs: [f] }
  for (const f of all) {
    const ext = path.extname(f.name).toLowerCase();
    const isVideo = VIDEO_TYPES[ext] !== undefined;
    const isPdf = ext === '.pdf';
    if (!isVideo && !isPdf) continue;
    const key = `${f.dir}\0${captionStem(f.name)}`;
    let g = groups.get(key);
    if (!g) { g = { videos: [], pdfs: [] }; groups.set(key, g); }
    (isVideo ? g.videos : g.pdfs).push(f);
  }

  // For each group pick the file(s) to expose: all videos when present,
  // otherwise the first PDF (sorted) for a video-less stem.
  const chosen = [];
  for (const g of groups.values()) {
    if (g.videos.length) {
      for (const f of g.videos) chosen.push({ f, kind: 'video' });
    } else if (g.pdfs.length) {
      const f = g.pdfs.slice().sort((a, b) => a.rel.localeCompare(b.rel))[0];
      chosen.push({ f, kind: 'pdf' });
    }
  }

  return chosen
    .map(({ f, kind }) => {
      const full = path.join(VIDEO_DIR, f.rel);
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtimeMs = Math.round(st.mtimeMs);
      } catch (_) { /* ignore unreadable entries */ }
      const caption = captions.get(`${f.dir}\0${captionStem(f.name)}`) || null;
      return {
        name: f.rel,
        url: '/videos/' + encodePath(f.rel),
        type: kind === 'pdf' ? 'application/pdf' : VIDEO_TYPES[path.extname(f.name).toLowerCase()],
        size,
        mtimeMs,
        category: f.dir ? f.dir.split('/')[0] : '',
        captionUrl: caption ? '/videos/' + encodePath(caption) : null,
        kind,
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
    console.log(`\n  Drop .mp4/.mov/.webm files (and optional .srt/.vtt/.txt captions)`);
    console.log(`  into ./videos or any subfolder, then reload.\n`);
  });
}

module.exports = { handler, server, listVideos, safeResolve };
