// store.js — config document, persistence, reconciliation, durations cache.
//
// The persisted document is the single source of truth for authoring data:
//   { schemaVersion, options, clips: { [filename]: ClipEntry } }
// Clips are keyed by filename (the only stable identity a static file server
// offers); entries for files that vanish are MARKED missing, never deleted.

import { MIN_CLIP, clamp, debounce, round3, titleFromName } from './util.js';

const CONFIG_KEY = 'showreel.config.v1';
const BAK_KEY = 'showreel.config.v1.bak';
const DUR_KEY = 'showreel.durations.v1';
// Previous key names (app was called "marquee"); migrated on first load.
const LEGACY = { config: 'marquee.config.v1', bak: 'marquee.config.v1.bak', dur: 'marquee.durations.v1' };
const SCHEMA_VERSION = 1;

const DEFAULT_OPTIONS = {
  mode: 'sequential-loop',
  titleOverlayEnabled: true,
  startMuted: false,
};

function nowISO() {
  return new Date().toISOString();
}

function defaultClip(name, fileSig, order) {
  return {
    title: titleFromName(name),
    in: 0,
    out: 0,
    outIsEnd: true, // play to the end until the user pins a specific OUT
    duration: null,
    enabled: true,
    order,
    missing: false,
    changed: false,
    fileSig: fileSig || null,
    modifiedAt: nowISO(),
  };
}

function freshDoc() {
  return { schemaVersion: SCHEMA_VERSION, options: { ...DEFAULT_OPTIONS }, clips: {} };
}

/** Coerce an arbitrary parsed object into a valid in-memory doc. */
function normalizeDoc(raw) {
  const doc = freshDoc();
  if (!raw || typeof raw !== 'object') return doc;
  doc.options = { ...DEFAULT_OPTIONS, ...(raw.options || {}) };
  if (!['sequential-loop', 'sequential-once', 'shuffle', 'shuffle-loop'].includes(doc.options.mode)) {
    doc.options.mode = DEFAULT_OPTIONS.mode;
  }
  doc.options.titleOverlayEnabled = !!doc.options.titleOverlayEnabled;
  doc.options.startMuted = !!doc.options.startMuted;

  const clips = (raw.clips && typeof raw.clips === 'object') ? raw.clips : {};
  let order = 0;
  for (const [name, c] of Object.entries(clips)) {
    if (!c || typeof c !== 'object') continue;
    const dur = Number.isFinite(c.duration) ? c.duration : null;
    doc.clips[name] = {
      title: typeof c.title === 'string' ? c.title.slice(0, 120) : titleFromName(name),
      in: Number.isFinite(c.in) ? Math.max(0, round3(c.in)) : 0,
      out: Number.isFinite(c.out) ? Math.max(0, round3(c.out)) : 0,
      outIsEnd: c.outIsEnd !== false, // default true
      duration: dur,
      enabled: c.enabled !== false,
      order: Number.isFinite(c.order) ? c.order : (order += 10),
      missing: !!c.missing,
      changed: false,
      fileSig: (c.fileSig && Number.isFinite(c.fileSig.size) && Number.isFinite(c.fileSig.mtimeMs)) ? c.fileSig : null,
      modifiedAt: typeof c.modifiedAt === 'string' ? c.modifiedAt : nowISO(),
    };
  }
  return doc;
}

class Store extends EventTarget {
  constructor() {
    super();
    this.doc = freshDoc();
    this.library = []; // runtime list from /api/videos: {name,url,type,size,mtimeMs}
    this.durations = {}; // cache: "name|size|mtime" -> seconds
    this.storageOk = true;
    this._save = debounce(() => this._write(), 300);
  }

  // ---- lifecycle -------------------------------------------------------
  load() {
    this._migrateLegacyKeys();
    try {
      const raw = localStorage.getItem(CONFIG_KEY) || localStorage.getItem(BAK_KEY);
      this.doc = raw ? normalizeDoc(JSON.parse(raw)) : freshDoc();
    } catch (err) {
      this.doc = freshDoc();
      this.emit('storage-error', { phase: 'read', err });
    }
    try {
      this.durations = JSON.parse(localStorage.getItem(DUR_KEY) || '{}') || {};
    } catch (_) {
      this.durations = {};
    }
  }

  /** One-time copy of config saved under the old "marquee.*" keys. */
  _migrateLegacyKeys() {
    try {
      if (localStorage.getItem(CONFIG_KEY) == null) {
        const old = localStorage.getItem(LEGACY.config);
        if (old != null) localStorage.setItem(CONFIG_KEY, old);
        const oldBak = localStorage.getItem(LEGACY.bak);
        if (oldBak != null) localStorage.setItem(BAK_KEY, oldBak);
      }
      if (localStorage.getItem(DUR_KEY) == null) {
        const oldDur = localStorage.getItem(LEGACY.dur);
        if (oldDur != null) localStorage.setItem(DUR_KEY, oldDur);
      }
    } catch (_) { /* storage unavailable */ }
  }

  _write() {
    if (!this.storageOk) return;
    try {
      const prev = localStorage.getItem(CONFIG_KEY);
      if (prev) localStorage.setItem(BAK_KEY, prev); // keep a backup of the last good blob
      localStorage.setItem(CONFIG_KEY, JSON.stringify(this.doc));
    } catch (err) {
      this.storageOk = false; // likely QuotaExceededError or private mode
      this.emit('storage-error', { phase: 'write', err });
    }
  }

  persist() { this._save(); }
  flush() { this._save.flush(); }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, fn); }

  // ---- options ---------------------------------------------------------
  get options() { return this.doc.options; }
  setOption(key, value) {
    this.doc.options[key] = value;
    this.persist();
    this.emit('options-changed', { key, value });
  }

  // ---- clips -----------------------------------------------------------
  getClip(name) { return this.doc.clips[name]; }

  updateClip(name, patch) {
    const clip = this.doc.clips[name];
    if (!clip) return;
    Object.assign(clip, patch, { modifiedAt: nowISO() });
    this.persist();
    this.emit('clip-changed', { name });
  }

  forgetClip(name) {
    delete this.doc.clips[name];
    this.persist();
    this.emit('clip-changed', { name, removed: true });
  }

  _nextOrder() {
    const orders = Object.values(this.doc.clips).map((c) => c.order).filter(Number.isFinite);
    return (orders.length ? Math.max(...orders) : 0) + 10;
  }

  /**
   * Reconcile the persisted clips against the live folder listing:
   *  - new file        -> create a default entry
   *  - present file    -> clear `missing`; if its size/mtime changed, force a
   *                       duration re-read by clearing the cached duration
   *  - vanished file   -> mark `missing` (keep the authoring data)
   */
  reconcile(library) {
    this.library = library;
    const present = new Set(library.map((v) => v.name));

    for (const v of library) {
      const sig = { size: v.size, mtimeMs: v.mtimeMs };
      let clip = this.doc.clips[v.name];
      if (!clip) {
        clip = defaultClip(v.name, sig, this._nextOrder());
        // adopt a cached duration if we have one for this exact file signature
        const cached = this.getCachedDuration(v);
        if (cached != null) clip.duration = cached;
        this.doc.clips[v.name] = clip;
        continue;
      }
      clip.missing = false;
      const old = clip.fileSig;
      const changedOnDisk = !old || !Number.isFinite(old.mtimeMs) || old.size !== sig.size || old.mtimeMs !== sig.mtimeMs;
      if (changedOnDisk) {
        clip.fileSig = sig;
        clip.changed = !!old; // only flag as "changed" if it existed before
        clip.duration = this.getCachedDuration(v); // null unless cached for new sig
      } else if (clip.duration == null) {
        const cached = this.getCachedDuration(v);
        if (cached != null) clip.duration = cached;
      }
    }

    for (const [name, clip] of Object.entries(this.doc.clips)) {
      if (!present.has(name)) clip.missing = true;
    }

    this.persist();
    this.emit('reconciled', {});
  }

  // ---- durations cache -------------------------------------------------
  _durKey(v) { return `${v.name}|${v.size}|${v.mtimeMs}`; }

  getCachedDuration(v) {
    const d = this.durations[this._durKey(v)];
    return Number.isFinite(d) ? d : null;
  }

  setDuration(v, seconds) {
    if (!Number.isFinite(seconds)) return;
    const dur = round3(seconds);
    this.durations[this._durKey(v)] = dur;
    try { localStorage.setItem(DUR_KEY, JSON.stringify(this.durations)); } catch (_) { /* ignore */ }
    const clip = this.doc.clips[v.name];
    if (clip) {
      clip.duration = dur;
      clip.changed = false;
      // Snap to the now-known length and keep IN/OUT within [0, dur] in BOTH
      // the outIsEnd and explicit-out cases (preserves the data invariant).
      clip.out = clip.outIsEnd ? dur : clamp(clip.out || 0, 0, dur);
      clip.in = clamp(clip.in || 0, 0, Math.max(0, dur));
      this.persist();
    }
    this.emit('duration', { name: v.name, duration: dur });
  }

  // ---- validity --------------------------------------------------------
  /** Effective IN/OUT in seconds, clamped to the known duration. */
  effectiveTrim(clip) {
    const dur = clip.duration;
    const inP = clamp(clip.in || 0, 0, dur != null ? dur : Number.MAX_VALUE);
    let outP = clip.outIsEnd ? dur : (Number.isFinite(clip.out) ? clip.out : null);
    if (dur != null) outP = clamp(outP != null ? outP : dur, 0, dur);
    return { in: inP, out: outP, duration: dur };
  }

  /** Trimmed (played) length, or null if unknowable yet. */
  trimmedLength(clip) {
    const { in: i, out: o } = this.effectiveTrim(clip);
    if (o == null) return null;
    return Math.max(0, o - i);
  }

  clipValidity(clip, serverEntry) {
    const reasons = [];
    if (clip.missing) reasons.push('file missing');
    if (!clip.title || !clip.title.trim()) reasons.push('needs title');
    if (serverEntry && serverEntry.unplayable) reasons.push('unsupported format');
    const { in: i, out: o } = this.effectiveTrim(clip);
    if (i < 0) reasons.push('start before 0');
    if (o != null && !(o - i >= MIN_CLIP)) reasons.push('end too close to start');
    if (clip.duration != null && i >= clip.duration) reasons.push('start past end of file');
    return { valid: reasons.length === 0, reasons };
  }

  /** Clips that should appear in the showreel, in `order`, with server entries. */
  playablePlaylist(serverByName) {
    return Object.entries(this.doc.clips)
      .map(([name, clip]) => ({ name, clip, server: serverByName.get(name) }))
      .filter((x) => x.clip.enabled)
      .filter((x) => this.clipValidity(x.clip, x.server).valid)
      .sort((a, b) => a.clip.order - b.clip.order);
  }

  // ---- export / import -------------------------------------------------
  exportJSON() {
    return JSON.stringify(
      { app: 'showreel', schemaVersion: SCHEMA_VERSION, exportedAt: nowISO(), ...this.doc },
      null,
      2
    );
  }

  /**
   * Validate an imported JSON string. Returns { ok, doc?, error? }.
   * A newer schemaVersion is refused outright (never partially applied).
   */
  parseImport(text) {
    let raw;
    try { raw = JSON.parse(text); }
    catch (_) { return { ok: false, error: 'Not valid JSON.' }; }
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Unexpected JSON shape.' };
    const v = Number(raw.schemaVersion);
    if (Number.isFinite(v) && v > SCHEMA_VERSION) {
      return { ok: false, error: `Made with a newer version (schema ${v}). Update the app first.` };
    }
    return { ok: true, doc: normalizeDoc(raw) };
  }

  /** Replace the whole document with an imported one. */
  replaceWith(doc) {
    this.doc = doc;
    this.persist();
    this.emit('imported', { mode: 'replace' });
  }

  /** Merge imported clips/options into the current doc (imported wins per key). */
  mergeFrom(doc) {
    this.doc.options = { ...this.doc.options, ...doc.options };
    for (const [name, clip] of Object.entries(doc.clips)) {
      this.doc.clips[name] = { ...this.doc.clips[name], ...clip };
    }
    this.persist();
    this.emit('imported', { mode: 'merge' });
  }
}

export const store = new Store();
