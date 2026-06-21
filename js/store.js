// store.js — config document, persistence, reconciliation, durations cache.
//
// The persisted document is the single source of truth for authoring data:
//   { schemaVersion, options, clips: { [filename]: ClipEntry } }
// Each ClipEntry carries an ordered list of trim `segments` ({ in, out,
// outIsEnd }); the clip plays each segment in turn before advancing. A single
// whole-clip trim is just a one-element list, so the common case is unchanged.
// Clips are keyed by filename (the only stable identity a static file server
// offers); entries for files that vanish are MARKED missing, never deleted.

import { MIN_CLIP, clamp, debounce, round3, titleFromName, baseName } from './util.js';

const CONFIG_KEY = 'showreel.config.v1';
const BAK_KEY = 'showreel.config.v1.bak';
const DUR_KEY = 'showreel.durations.v1';
const PAGES_KEY = 'showreel.pagecounts.v1';
const RESUME_KEY = 'showreel.resume.v1';
// Previous key names (app was called "marquee"); migrated on first load.
const LEGACY = { config: 'marquee.config.v1', bak: 'marquee.config.v1.bak', dur: 'marquee.durations.v1' };
// v1 stored a single flat trim (in/out/outIsEnd) per clip; v2 stores a
// `segments` array. normalizeDoc() migrates v1 docs transparently on load.
const SCHEMA_VERSION = 2;

const DEFAULT_PDF_PAGES = 10;
const DEFAULT_PAGE_SECONDS = 6;
const MIN_PAGE_SECONDS = 0.5;

const DEFAULT_OPTIONS = {
  mode: 'sequential-loop',
  titleOverlayEnabled: true,
  startMuted: false,
};

function nowISO() {
  return new Date().toISOString();
}

/** The canonical "whole clip" segment: play from 0 to the end of the file. */
function defaultSegment() {
  return { in: 0, out: 0, outIsEnd: true }; // outIsEnd: play to the end until a specific OUT is pinned
}

/** The default page list for a PDF clip: pages 1..min(10, pageCount) @ 6s. */
function defaultPdfPages(pageCount) {
  const last = pageCount != null ? Math.max(1, Math.min(DEFAULT_PDF_PAGES, pageCount)) : DEFAULT_PDF_PAGES;
  const pages = [];
  for (let p = 1; p <= last; p++) pages.push({ page: p, seconds: DEFAULT_PAGE_SECONDS });
  return pages;
}

/** Coerce one arbitrary object into a valid {page, seconds}. */
function coercePage(p) {
  const page = Number.isFinite(p.page) ? Math.max(1, Math.round(p.page)) : 1;
  const seconds = Number.isFinite(p.seconds) ? Math.max(MIN_PAGE_SECONDS, round3(p.seconds)) : DEFAULT_PAGE_SECONDS;
  return { page, seconds };
}

/** Resolve a PDF clip's page list: coerce, drop out-of-range, sort, dedupe by
 *  page (first wins), and guarantee at least one page. */
function normalizePages(c, pageCount) {
  let arr = Array.isArray(c.pages)
    ? c.pages.filter((p) => p && typeof p === 'object').map(coercePage)
    : [];
  if (pageCount != null) arr = arr.filter((p) => p.page <= pageCount);
  arr.sort((a, b) => a.page - b.page);
  const seen = new Set();
  arr = arr.filter((p) => (seen.has(p.page) ? false : (seen.add(p.page), true)));
  return arr.length ? arr : defaultPdfPages(pageCount);
}

/** Coerce one arbitrary object into a valid segment. `defaultEnd` is the
 *  outIsEnd value used when the field is absent (true for v1 migration, where
 *  a missing OUT meant "play to end"; false for explicit v2 arrays). */
function coerceSeg(s, defaultEnd) {
  return {
    in: Number.isFinite(s.in) ? Math.max(0, round3(s.in)) : 0,
    out: Number.isFinite(s.out) ? Math.max(0, round3(s.out)) : 0,
    outIsEnd: typeof s.outIsEnd === 'boolean' ? s.outIsEnd : defaultEnd,
  };
}

/** Only the LAST segment may "play to the end"; clear it on the others. */
function enforceLastOutIsEnd(segs) {
  return segs.map((s, i) => (i < segs.length - 1 && s.outIsEnd) ? { ...s, outIsEnd: false } : s);
}

/** Resolve a clip's segment list, migrating a v1 flat trim if needed. The
 *  duration (if known) is used to heal a collapsed range left by older builds —
 *  a non-"to end" segment whose OUT fell to <= IN, which would otherwise
 *  silently invalidate the whole clip and drop it from the showreel. */
function normalizeSegments(c, dur) {
  let segs;
  if (Array.isArray(c.segments)) {
    const arr = c.segments.filter((s) => s && typeof s === 'object').map((s) => coerceSeg(s, false));
    segs = arr.length ? enforceLastOutIsEnd(arr) : [defaultSegment()];
  } else if ('in' in c || 'out' in c || 'outIsEnd' in c) {
    // v1 migration: synthesize a single segment from the old flat in/out/outIsEnd.
    segs = [coerceSeg(c, true)];
  } else {
    segs = [defaultSegment()];
  }
  if (dur != null) {
    segs = segs.map((s) => (!s.outIsEnd && s.out <= s.in) ? { ...s, out: round3(dur) } : s);
  }
  return segs;
}

function defaultClip(name, fileSig, order, kind) {
  const k = kind === 'pdf' ? 'pdf' : 'video';
  const base = {
    title: titleFromName(name),
    kind: k,
    duration: null,
    enabled: true,
    order,
    missing: false,
    changed: false,
    fileSig: fileSig || null,
    modifiedAt: nowISO(),
  };
  if (k === 'pdf') {
    base.pages = defaultPdfPages(null);
    base.pageCount = null;
  } else {
    base.segments = [defaultSegment()];
  }
  return base;
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
    const kind = c.kind === 'pdf' ? 'pdf' : 'video';
    const common = {
      title: typeof c.title === 'string' ? c.title.slice(0, 120) : titleFromName(name),
      kind,
      duration: dur,
      enabled: c.enabled !== false,
      order: Number.isFinite(c.order) ? c.order : (order += 10),
      missing: !!c.missing,
      changed: false,
      fileSig: (c.fileSig && Number.isFinite(c.fileSig.size) && Number.isFinite(c.fileSig.mtimeMs)) ? c.fileSig : null,
      modifiedAt: typeof c.modifiedAt === 'string' ? c.modifiedAt : nowISO(),
    };
    if (kind === 'pdf') {
      const pageCount = Number.isFinite(c.pageCount) ? Math.round(c.pageCount) : null;
      doc.clips[name] = { ...common, pages: normalizePages(c, pageCount), pageCount };
    } else {
      doc.clips[name] = { ...common, segments: normalizeSegments(c, dur) };
    }
  }
  return doc;
}

class Store extends EventTarget {
  constructor() {
    super();
    this.doc = freshDoc();
    this.library = []; // runtime list from /api/videos: {name,url,type,size,mtimeMs}
    this.durations = {}; // cache: "name|size|mtime" -> seconds
    this.pageCounts = {}; // cache: "name|size|mtime" -> page count
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
    try {
      this.pageCounts = JSON.parse(localStorage.getItem(PAGES_KEY) || '{}') || {};
    } catch (_) {
      this.pageCounts = {};
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

  /**
   * Drop every clip currently flagged `missing` — authoring data kept for files
   * that have left the folder. Returns how many were removed so the UI can
   * confirm; only persists/emits when something actually changed.
   */
  forgetMissing() {
    const names = Object.keys(this.doc.clips).filter((n) => this.doc.clips[n].missing);
    for (const name of names) delete this.doc.clips[name];
    if (names.length) {
      this.persist();
      this.emit('clip-changed', { removedMissing: names.length });
    }
    return names.length;
  }

  /** A clip that carries no user authoring — exactly what defaultClip() makes
   *  (auto title, one whole-file segment, enabled). Such an entry is safe to
   *  overwrite when folding a moved clip onto it. */
  _isPristineDefault(clip, name) {
    if (!clip || clip.enabled === false) return false;
    if (clip.title !== titleFromName(name)) return false;
    const segs = clip.segments || [];
    return segs.length === 1 && (segs[0].in || 0) === 0 && segs[0].outIsEnd === true;
  }

  /**
   * Fold persisted clips whose file moved (so its identity path changed) onto
   * the matching live file, so a move never leaves a stale "Missing" duplicate
   * beside a fresh blank entry for the new path. For each orphaned entry, when
   * exactly one live file shares its basename:
   *   - no entry yet for that path, or a pristine auto-default -> adopt the
   *     orphan's authoring (keeping the live file's resolved duration/signature);
   *   - the path already has real authoring -> keep it.
   * Either way the orphan (a stale alias of a file that still exists) is removed.
   * Ambiguous basenames (same name in two folders) are left as Missing.
   */
  _migrateMovedClips(library, present) {
    const presentByBase = new Map(); // basename -> [live paths]
    for (const v of library) {
      const b = baseName(v.name);
      if (!presentByBase.has(b)) presentByBase.set(b, []);
      presentByBase.get(b).push(v.name);
    }
    for (const oldName of Object.keys(this.doc.clips)) {
      if (present.has(oldName)) continue; // file still there under this key
      const paths = presentByBase.get(baseName(oldName));
      if (!paths || paths.length !== 1) continue; // gone, or ambiguous -> keep Missing
      const newName = paths[0];
      const orphan = this.doc.clips[oldName];
      const target = this.doc.clips[newName];
      if (!target || this._isPristineDefault(target, newName)) {
        const dur = target && target.duration != null ? target.duration : orphan.duration;
        const sig = target && target.fileSig ? target.fileSig : orphan.fileSig;
        this.doc.clips[newName] = { ...orphan, duration: dur, fileSig: sig };
      }
      delete this.doc.clips[oldName];
    }
  }

  /**
   * Reconcile the persisted clips against the live folder listing:
   *  - new file        -> create a default entry
   *  - present file    -> clear `missing`; if its size/mtime changed, force a
   *                       duration re-read by clearing the cached duration
   *  - vanished file   -> mark `missing` (keep the authoring data)
   * Playback `order` is re-derived from each clip's position in `library`, so
   * the showreel always plays in the same order the library displays (there is
   * no separate user clip-reordering, so insertion order must not drift).
   */
  reconcile(library) {
    this.library = library;
    const present = new Set(library.map((v) => v.name));

    // Heal identity changes (e.g. clips moved into a subfolder, so the key went
    // from "x.mp4" to "auto-accept/x.mp4"): re-home an orphaned entry onto the
    // live file that shares its basename, preserving its title/trims instead of
    // stranding it as "Missing" while a blank default appears for the new path.
    this._migrateMovedClips(library, present);

    library.forEach((v, i) => {
      const sig = { size: v.size, mtimeMs: v.mtimeMs };
      let clip = this.doc.clips[v.name];
      if (!clip) {
        clip = defaultClip(v.name, sig, i * 10, v.kind);
        if (v.kind === 'pdf') {
          const cachedPages = this.getCachedPageCount(v);
          if (cachedPages != null) {
            clip.pageCount = cachedPages;
            clip.pages = clip.pages.filter((p) => p.page <= cachedPages);
            if (!clip.pages.length) clip.pages = defaultPdfPages(cachedPages);
          }
        } else {
          // adopt a cached duration if we have one for this exact file signature
          const cached = this.getCachedDuration(v);
          if (cached != null) clip.duration = cached;
        }
        this.doc.clips[v.name] = clip;
      } else {
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
      clip.order = i * 10; // keep playback order aligned with the library order
    });

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
      // Snap every segment to the now-known length, keeping IN/OUT within
      // [0, dur] in BOTH the outIsEnd and explicit-out cases.
      for (const seg of clip.segments) {
        seg.in = clamp(seg.in || 0, 0, Math.max(0, dur));
        seg.out = seg.outIsEnd ? dur : clamp(seg.out || 0, 0, dur);
        if (!seg.outIsEnd && seg.out <= seg.in) seg.out = dur; // heal a collapsed range
      }
      this.persist();
    }
    this.emit('duration', { name: v.name, duration: dur });
  }

  // ---- page-count cache (PDF clips) -----------------------------------
  _pageKey(v) { return `${v.name}|${v.size}|${v.mtimeMs}`; }

  getCachedPageCount(v) {
    const n = this.pageCounts[this._pageKey(v)];
    return Number.isFinite(n) ? n : null;
  }

  /** Record a PDF's resolved page count and clamp the clip's page list to it. */
  setPageCount(v, count) {
    if (!Number.isFinite(count) || count < 1) return;
    const n = Math.round(count);
    this.pageCounts[this._pageKey(v)] = n;
    try { localStorage.setItem(PAGES_KEY, JSON.stringify(this.pageCounts)); } catch (_) { /* ignore */ }
    const clip = this.doc.clips[v.name];
    if (clip && clip.kind === 'pdf') {
      clip.pageCount = n;
      let pages = (clip.pages || []).filter((p) => p.page >= 1 && p.page <= n);
      if (!pages.length) pages = defaultPdfPages(n);
      clip.pages = pages;
      this.persist();
    }
    this.emit('pagecount', { name: v.name, pageCount: n });
  }

  // ---- resume (playback position) ------------------------------------
  getResume() {
    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (!raw) return null;
      const r = JSON.parse(raw);
      return (r && typeof r === 'object' && typeof r.name === 'string') ? r : null;
    } catch (_) { return null; }
  }

  setResume(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    try { localStorage.setItem(RESUME_KEY, JSON.stringify(snapshot)); } catch (_) { /* ignore */ }
  }

  clearResume() {
    try { localStorage.removeItem(RESUME_KEY); } catch (_) { /* ignore */ }
  }

  /**
   * Resolve a saved snapshot against the current playlist (array of
   * {name, clip, server}). Returns a play plan or null when the active clip is
   * no longer playable (caller starts fresh). `order` maps snapshot.order names
   * -> indices into `playlist` (missing names dropped, order preserved); `pos`
   * is the active clip's index within that mapped order.
   */
  resolveResume(snapshot, playlist) {
    if (!snapshot || !Array.isArray(playlist) || !playlist.length) return null;
    const idxByName = new Map(playlist.map((e, i) => [e.name, i]));
    const names = Array.isArray(snapshot.order) ? snapshot.order : [];
    const order = names.map((nm) => idxByName.get(nm)).filter((i) => i != null);
    const activeIdx = idxByName.get(snapshot.name);
    if (activeIdx == null) return null;          // active clip gone -> fresh start
    const pos = order.indexOf(activeIdx);
    if (pos < 0) return null;
    return {
      order,
      pos,
      name: snapshot.name,
      kind: snapshot.kind === 'pdf' ? 'pdf' : 'video',
      segIdx: Number.isFinite(snapshot.segIdx) ? snapshot.segIdx : 0,
      time: Number.isFinite(snapshot.time) ? snapshot.time : 0,
      pageIdx: Number.isFinite(snapshot.pageIdx) ? snapshot.pageIdx : 0,
      mode: typeof snapshot.mode === 'string' ? snapshot.mode : 'sequential-loop',
    };
  }

  // ---- validity --------------------------------------------------------
  /**
   * Resolve a clip's segments to effective { in, out } pairs in seconds,
   * clamped to the known duration. `out` is null when it can't be known yet
   * (a "play to end" segment before the browser has reported the duration).
   */
  effectiveSegments(clip) {
    const dur = clip.duration;
    const segs = (clip.segments && clip.segments.length) ? clip.segments : [defaultSegment()];
    return segs.map((s) => {
      const inP = clamp(s.in || 0, 0, dur != null ? dur : Number.MAX_VALUE);
      let outP = s.outIsEnd ? dur : (Number.isFinite(s.out) ? s.out : null);
      if (dur != null) outP = clamp(outP != null ? outP : dur, 0, dur);
      return { in: inP, out: outP };
    });
  }

  /** Total played length: Σ page seconds for PDFs, Σ segment lengths for video. */
  trimmedLength(clip) {
    if (clip.kind === 'pdf') {
      return (clip.pages || []).reduce((sum, p) => sum + (Number.isFinite(p.seconds) ? p.seconds : 0), 0);
    }
    let total = 0;
    for (const { in: i, out: o } of this.effectiveSegments(clip)) {
      if (o == null) return null;
      total += Math.max(0, o - i);
    }
    return total;
  }

  clipValidity(clip, serverEntry) {
    const reasons = [];
    if (clip.missing) reasons.push('file missing');
    if (!clip.title || !clip.title.trim()) reasons.push('needs title');
    if (clip.kind === 'pdf') {
      const inRange = (clip.pages || []).filter(
        (p) => clip.pageCount == null || (p.page >= 1 && p.page <= clip.pageCount)
      );
      if (!inRange.length) reasons.push('no pages selected');
      return { valid: reasons.length === 0, reasons };
    }
    // ---- video (existing logic below) ----
    if (serverEntry && serverEntry.unplayable) reasons.push('unsupported format');
    const segs = this.effectiveSegments(clip);
    // Validate every segment; dedupe reasons so a clip with many bad segments
    // still reads cleanly (and the blocker tally stays meaningful).
    const segReasons = new Set();
    if (!segs.length) segReasons.add('no segments');
    for (const { in: i, out: o } of segs) {
      if (i < 0) segReasons.add('start before 0');
      if (o != null && !(o - i >= MIN_CLIP)) segReasons.add('end too close to start');
      if (clip.duration != null && i >= clip.duration) segReasons.add('start past end of file');
    }
    reasons.push(...segReasons);
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
