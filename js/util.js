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

/** Default title derived from a filename. */
export function titleFromName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled';
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
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
export function canBrowserPlay(mimeType) {
  if (!_probe) _probe = document.createElement('video');
  if (!mimeType) return true;
  const verdict = _probe.canPlayType(mimeType);
  return verdict === 'probably' || verdict === 'maybe';
}
