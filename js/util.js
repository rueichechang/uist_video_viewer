// util.js — pure helpers shared across modules.

export const MIN_CLIP = 0.1; // minimum trimmed clip length (seconds)

export function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  wrapped.flush = (...args) => {
    if (t) { clearTimeout(t); t = null; }
    fn(...args);
  };
  wrapped.cancel = () => { if (t) { clearTimeout(t); t = null; } };
  return wrapped;
}

/** Unbiased Fisher–Yates shuffle, returns a new array. */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Format seconds as [h:]mm:ss.cs. Returns "—" for unknown/invalid. */
export function formatTime(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  let s = Math.floor(sec);
  // carry rounding of centiseconds
  let centi = cs;
  if (centi === 100) { centi = 0; s += 1; }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  const cc = pad(centi);
  if (h > 0) return `${h}:${pad(m)}:${pad(ss)}.${cc}`;
  return `${pad(m)}:${pad(ss)}.${cc}`;
}

/** Short duration like "4:32" (no centiseconds) for summaries. */
export function formatShort(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(ss)}`;
  return `${m}:${pad(ss)}`;
}

/**
 * Parse a user-typed time. Accepts plain seconds ("12.5"), "m:ss(.cs)",
 * "h:mm:ss(.cs)", and comma decimals ("12,5"). Returns NaN if unparseable.
 */
export function parseTime(str) {
  if (typeof str !== 'string') return NaN;
  const t = str.trim().replace(',', '.');
  if (t === '') return NaN;
  if (t.indexOf(':') === -1) {
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }
  const parts = t.split(':');
  if (parts.length > 3) return NaN;
  let total = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0) return NaN;
    total = total * 60 + n;
  }
  return total;
}

/** Round to milliseconds to avoid float noise in stored config. */
export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** Last path segment of a relative name (clips are keyed by "folder/file"). */
export function baseName(name) {
  const i = name.lastIndexOf('/');
  return i === -1 ? name : name.slice(i + 1);
}

/** Default title derived from a filename (folder prefix is ignored). */
export function titleFromName(name) {
  const base = baseName(name).replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled';
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The short clip ID for the library: the four digits after "sub" in a download
 * filename (e.g. "abc_sub0421_final.mp4" -> "0421"). Downloads share a long
 * common prefix, so this is the only distinguishing part. Falls back to the
 * full filename when there's no "sub####" to extract.
 */
export function idFromName(name) {
  const m = /sub(\d{4})/i.exec(name);
  return m ? m[1] : baseName(name);
}

/** Encode a relative path for use as a URL, preserving "/" separators. */
export function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// ---- a tiny DOM helper -------------------------------------------------
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // only used with trusted strings
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

// ---- codec support gate ------------------------------------------------
let _probe;
function _probes(mimeType) {
  if (!_probe) _probe = document.createElement('video');
  const verdict = _probe.canPlayType(mimeType);
  return verdict === 'probably' || verdict === 'maybe';
}

export function canBrowserPlay(mimeType) {
  if (!mimeType) return true;
  if (_probes(mimeType)) return true;
  // QuickTime (.mov) containers usually wrap H.264/AAC — the same codecs a
  // browser already decodes inside .mp4 — yet Chrome/Firefox report "" for the
  // bare "video/quicktime" type. Fall back to probing the equivalent .mp4
  // codec string so playable .mov files aren't flagged as unsupported.
  if (mimeType === 'video/quicktime') {
    return (
      _probes('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') ||
      _probes('video/mp4')
    );
  }
  return false;
}

// ---- captions ----------------------------------------------------------
/** Parse one timestamp ("H:MM:SS.mmm", "MM:SS,mmm", …) to seconds, or null. */
function _parseTimestamp(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/.exec(s.trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3].replace(',', '.'));
  if (!Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return h * 3600 + min * 60 + sec;
}

/** First whitespace-delimited token of a string (strips VTT cue settings). */
function _firstToken(s) {
  return s.trim().split(/\s+/)[0] || '';
}

/** Pull {start,end} from a cue's timing line (SRT/VTT "-->" or SBV comma). */
function _parseTiming(line) {
  let left;
  let right;
  if (line.includes('-->')) {
    const parts = line.split('-->');
    left = _firstToken(parts[0]);
    right = _firstToken(parts[1] || '');
  } else if (line.includes(',')) {
    // SBV/YouTube: "0:00:03.369,0:00:07.128" (ms uses '.', so ',' splits cleanly)
    const idx = line.indexOf(',');
    left = _firstToken(line.slice(0, idx));
    right = _firstToken(line.slice(idx + 1));
  } else {
    return null;
  }
  const start = _parseTimestamp(left);
  const end = _parseTimestamp(right);
  if (start == null || end == null) return null;
  return { start, end };
}

/**
 * Parse SRT, WebVTT, or SBV caption text into sorted cues
 * [{ start, end, text }] in seconds. Index lines and headers are ignored,
 * inline tags (<b>, <i>, …) are stripped. Returns [] for non-caption text.
 */
export function parseCaptions(text) {
  if (!text || typeof text !== 'string') return [];
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    let timing = null;
    let textStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = _parseTiming(lines[i]);
      if (t) { timing = t; textStart = i + 1; break; }
    }
    if (!timing || !(timing.end > timing.start)) continue;
    const body = lines.slice(textStart).join('\n')
      .replace(/<[^>]+>/g, '')   // strip SRT/VTT inline formatting tags
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    if (body) cues.push({ start: timing.start, end: timing.end, text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}
