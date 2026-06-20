# PDF-only Submissions as Showreel Clips — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show video-less submissions (papers with a PDF but no video) in the Library and play them in the showreel as a timed, per-page PDF slideshow.

**Architecture:** The server groups files by submission stem and emits a `kind:'pdf'` entry for any stem that has a PDF but no video. The store gains a `kind` discriminator; PDF clips carry an ordered `pages: [{page, seconds}]` list (default first 10 pages @ 6 s, clamped to the PDF's real length). A thin `js/pdf.js` wrapper around **vendored** Mozilla PDF.js renders pages to a `<canvas>`, used both by the fullscreen player (a cleanly-branched path that leaves the video engine intact) and by the Library/authoring UI. The Library renders Videos / PDFs / Missing sections.

**Tech Stack:** Vanilla ES-module JS, zero-dependency Node static/range server, vendored PDF.js (committed dist files), Node's built-in `node --test`.

## Global Constraints

- **No npm runtime dependencies / no build step.** PDF.js is committed as static dist files under `js/vendor/pdfjs/`; the browser loads them directly. (Server stays zero-dependency.)
- **Must run fully offline** from `node server.js` (PDF.js worker is served locally; never a CDN at runtime).
- **`js/` files are ES modules** (`js/package.json` = `{"type":"module"}`); `server.js` stays CommonJS at the repo root. The browser ignores both.
- **Run command unchanged:** `node server.js` / `npm start`; tests via `npm test` (`node --test`).
- **Defaults (verbatim):** `DEFAULT_PDF_PAGES = 10`, `DEFAULT_PAGE_SECONDS = 6`, `MIN_PAGE_SECONDS = 0.5`.
- **Scope:** only stems with **no video** become PDF clips; pages are kept **ascending and de-duplicated**; PDF clips have no audio and no captions.
- **Sandbox note:** binding the server socket is blocked in the agent sandbox (`EPERM`) and PDF.js canvas rendering needs a real browser. Automated tests cover the server + store layers; player/UI rendering is verified by the user via a manual click-through.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server.js` | List PDF-only stems as `kind:'pdf'` entries; tag video entries `kind:'video'`; serve `.pdf` |
| `js/store.js` | `kind` discriminator; PDF `pages`/`pageCount`; defaults, normalization, `setPageCount`, length, validity |
| `js/vendor/pdfjs/` | **New** — committed `pdf.mjs` + `pdf.worker.mjs` (Mozilla PDF.js) |
| `js/pdf.js` | **New** — wrapper: `loadDoc(url)`, `renderPage(doc, pageNum, canvas, opts)` |
| `index.html` | `#pdfCanvas` player layer; `#pdfEditor` authoring block |
| `styles.css` | `.lib-section` headers; `#pdfCanvas`; PDF thumbnail; PDF editor |
| `js/main.js` | New DOM refs; wire `onPageCount` |
| `js/ui.js` | Library grouping; PDF card (thumb/meta/badge); PDF authoring editor + page ops |
| `js/player.js` | `#pdfCanvas` layer; PDF branches in `_prepare`/`_activate`/`_clearWatchers`/keys/`finish`; page timer |
| `test/server.test.mjs` | **New** — `/api/videos` listing emits/excludes PDFs correctly |
| `test/pdf-store.test.mjs` | **New** — PDF defaults, normalization, `setPageCount`, length, validity |
| `README.md` | Document PDF clips + Library sections |

**Task order & dependencies:** T1 (server) and T2–T3 (store) are independent and fully tested. T4 (vendor + wrapper) has no logic deps. T5 (HTML/CSS/refs) scaffolds elements that T6–T9 (UI/player) consume. T10 documents + does the final pass.

---

### Task 1: Server lists PDF-only submissions with a `kind` field

**Files:**
- Modify: `server.js` (`STATIC_TYPES`, `listVideos`)
- Test: `test/server.test.mjs` (create)

**Interfaces:**
- Produces: `/api/videos` entries now each carry `kind: 'video' | 'pdf'`. A stem (folder + `captionStem`) with no video file but ≥1 PDF yields one entry `{ name, url, type:'application/pdf', size, mtimeMs, category, captionUrl, kind:'pdf' }`. Video entries are unchanged except for added `kind:'video'`. `module.exports.listVideos` unchanged in name.

- [ ] **Step 1: Write the failing test**

Create `test/server.test.mjs`:

```js
// server.test.mjs — /api/videos listing: PDFs surface only for video-less stems.
import test from 'node:test';
import assert from 'node:assert/strict';
import server from '../server.js'; // CommonJS default import; require.main guard => no socket bind
const { listVideos } = server;

test('listVideos tags videos and surfaces PDF-only submissions as kind:pdf', () => {
  const all = listVideos();
  const videos = all.filter((v) => v.kind === 'video');
  const pdfs = all.filter((v) => v.kind === 'pdf');

  // Every entry is classified.
  assert.ok(all.every((v) => v.kind === 'video' || v.kind === 'pdf'));

  // The two video-less submissions become PDF entries.
  assert.deepEqual(
    pdfs.map((p) => p.name).sort(),
    ['auto-accept/uist26a-sub1771-i7.pdf', 'auto-accept/uist26a-sub5059-i7.pdf']
  );
  assert.equal(pdfs[0].type, 'application/pdf');
  assert.equal(pdfs.find((p) => p.name.includes('1771')).category, 'auto-accept');

  // PDFs that have a sibling video are NOT listed (e.g. sub3869 has a .mov).
  assert.ok(!all.some((v) => v.name === 'auto-accept/uist26a-sub3869-i7.pdf'));

  // The video count is unchanged (33 playable videos in the dataset).
  assert.equal(videos.length, 33);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.mjs`
Expected: FAIL — PDFs absent (`pdfs` empty) and/or `kind` undefined.

- [ ] **Step 3: Add the `.pdf` static MIME type**

In `server.js`, add `.pdf` to `STATIC_TYPES` (after the `.txt` line):

```js
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
```

- [ ] **Step 4: Rewrite `listVideos` to group by stem and emit PDF-only entries**

Replace the entire `listVideos` function body in `server.js` with:

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/server.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add server.js test/server.test.mjs
git commit -m "feat(server): list PDF-only submissions as kind:pdf entries

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Store — `kind`, PDF defaults, and normalization

**Files:**
- Modify: `js/store.js`
- Test: `test/pdf-store.test.mjs` (create)

**Interfaces:**
- Consumes: server entries carry `kind` (Task 1).
- Produces:
  - Module constants `DEFAULT_PDF_PAGES=10`, `DEFAULT_PAGE_SECONDS=6`, `MIN_PAGE_SECONDS=0.5`.
  - `defaultClip(name, fileSig, order, kind)` — PDF clips get `{ kind:'pdf', pages:[{page,seconds}], pageCount:null }`; video clips unchanged (`segments`).
  - `normalizeDoc` preserves `kind` and normalizes `pages` (ascending, de-duped, `seconds ≥ MIN_PAGE_SECONDS`, ≥1 page).
  - Clip shape for PDFs relied on by later tasks: `clip.kind === 'pdf'`, `clip.pages` (array of `{page:int≥1, seconds:number}`), `clip.pageCount` (`number|null`).

- [ ] **Step 1: Write the failing test**

Create `test/pdf-store.test.mjs`:

```js
// pdf-store.test.mjs — PDF clip data model (defaults + normalization).
import test from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../js/store.js';

function reset() {
  store.persist = () => {};            // no localStorage in Node
  store.doc = { schemaVersion: 2, options: {}, clips: {} };
  store.durations = {};
  store.pageCounts = {};
}

test('reconcile creates a PDF clip with default pages 1..10 @ 6s', () => {
  reset();
  store.reconcile([
    { name: 'auto-accept/uist26a-sub1771-i7.pdf', kind: 'pdf', type: 'application/pdf', size: 10, mtimeMs: 20, url: '' },
  ]);
  const clip = store.doc.clips['auto-accept/uist26a-sub1771-i7.pdf'];
  assert.equal(clip.kind, 'pdf');
  assert.equal(clip.pages.length, 10);
  assert.deepEqual(clip.pages[0], { page: 1, seconds: 6 });
  assert.deepEqual(clip.pages[9], { page: 10, seconds: 6 });
  assert.equal(clip.pageCount, null);
});

test('reconcile still creates a video clip with segments', () => {
  reset();
  store.reconcile([
    { name: 'a/clip.mp4', kind: 'video', type: 'video/mp4', size: 1, mtimeMs: 2, url: '' },
  ]);
  const clip = store.doc.clips['a/clip.mp4'];
  assert.equal(clip.kind, 'video');
  assert.ok(Array.isArray(clip.segments));
  assert.equal(clip.pages, undefined);
});

test('normalizeDoc (via parseImport) sorts, dedupes, and floors page seconds', () => {
  reset();
  const res = store.parseImport(JSON.stringify({
    schemaVersion: 2,
    clips: {
      'x.pdf': {
        kind: 'pdf', title: 'X',
        pages: [{ page: 3, seconds: 2 }, { page: 1, seconds: 0.1 }, { page: 3, seconds: 9 }],
      },
    },
  }));
  assert.ok(res.ok);
  const c = res.doc.clips['x.pdf'];
  assert.equal(c.kind, 'pdf');
  // sorted ascending; page 3 de-duped (first wins); 0.1 floored to MIN 0.5
  assert.deepEqual(c.pages, [{ page: 1, seconds: 0.5 }, { page: 3, seconds: 2 }]);
});

test('normalizeDoc gives a PDF clip with no pages the default list', () => {
  reset();
  const res = store.parseImport(JSON.stringify({
    schemaVersion: 2, clips: { 'y.pdf': { kind: 'pdf', title: 'Y', pages: [] } },
  }));
  assert.equal(res.doc.clips['y.pdf'].pages.length, 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pdf-store.test.mjs`
Expected: FAIL — `clip.kind` undefined / `clip.pages` undefined.

- [ ] **Step 3: Add constants and PDF helpers**

In `js/store.js`, after the `SCHEMA_VERSION` line, add:

```js
const DEFAULT_PDF_PAGES = 10;
const DEFAULT_PAGE_SECONDS = 6;
const MIN_PAGE_SECONDS = 0.5;
```

After `defaultSegment()`, add:

```js
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
```

- [ ] **Step 4: Branch `defaultClip` on kind**

Replace `defaultClip` in `js/store.js` with:

```js
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
```

- [ ] **Step 5: Branch `normalizeDoc` on kind**

In `js/store.js`, replace the `doc.clips[name] = { ... }` assignment block inside the `for (const [name, c] of Object.entries(clips))` loop with:

```js
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
```

- [ ] **Step 6: Pass `kind` from `reconcile` into `defaultClip`**

In `js/store.js` `reconcile`, change the clip-creation line:

```js
      if (!clip) {
        clip = defaultClip(v.name, sig, i * 10, v.kind);
```

(Leave the rest of `reconcile` unchanged for now; PDF page-count adoption is Task 3.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/pdf-store.test.mjs`
Expected: PASS (4 tests).
Run: `node --test` (full suite) — Expected: all prior tests still PASS.

- [ ] **Step 8: Commit**

```bash
git add js/store.js test/pdf-store.test.mjs
git commit -m "feat(store): add PDF clip kind, default pages, and normalization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Store — page-count resolution, length, and validity

**Files:**
- Modify: `js/store.js`
- Test: `test/pdf-store.test.mjs` (extend)

**Interfaces:**
- Produces:
  - `store.pageCounts` cache + `store.getCachedPageCount(v)` + `store.setPageCount(v, count)` (clamps the clip's pages to `[1, count]`, resets to defaults if all dropped, emits `'pagecount'`).
  - `store.trimmedLength(clip)` returns Σ page seconds for PDF clips.
  - `store.clipValidity(clip, serverEntry)` for PDF clips: invalid on `missing`, no title, or zero in-range pages.
  - `PAGES_KEY` localStorage key; `pageCounts` loaded in `load()` and initialized in the constructor.

- [ ] **Step 1: Write the failing test (extend file)**

Append to `test/pdf-store.test.mjs`:

```js
test('setPageCount clamps the page list to the real page count', () => {
  reset();
  const v = { name: 'p.pdf', kind: 'pdf', type: 'application/pdf', size: 1, mtimeMs: 1, url: '' };
  store.reconcile([v]);                       // default pages 1..10
  store.setPageCount(v, 18);                  // 18-page PDF: keep 1..10
  assert.equal(store.doc.clips['p.pdf'].pages.length, 10);
  store.setPageCount(v, 5);                   // shrink: keep 1..5
  assert.deepEqual(store.doc.clips['p.pdf'].pages.map((x) => x.page), [1, 2, 3, 4, 5]);
  assert.equal(store.doc.clips['p.pdf'].pageCount, 5);
});

test('setPageCount resets to defaults when every page is out of range', () => {
  reset();
  const v = { name: 'q.pdf', kind: 'pdf', type: 'application/pdf', size: 1, mtimeMs: 1, url: '' };
  store.reconcile([v]);
  store.doc.clips['q.pdf'].pages = [{ page: 50, seconds: 6 }, { page: 99, seconds: 6 }];
  store.setPageCount(v, 3);                   // all dropped -> reset to 1..3
  assert.deepEqual(store.doc.clips['q.pdf'].pages.map((x) => x.page), [1, 2, 3]);
});

test('trimmedLength sums per-page seconds for a PDF clip', () => {
  reset();
  const clip = { kind: 'pdf', pages: [{ page: 1, seconds: 6 }, { page: 2, seconds: 4 }, { page: 5, seconds: 2 }] };
  assert.equal(store.trimmedLength(clip), 12);
});

test('clipValidity for PDF clips: needs a title and >=1 in-range page', () => {
  reset();
  const ok = { kind: 'pdf', title: 'Paper', missing: false, pages: [{ page: 1, seconds: 6 }], pageCount: 10 };
  assert.equal(store.clipValidity(ok, null).valid, true);

  const noTitle = { kind: 'pdf', title: '', missing: false, pages: [{ page: 1, seconds: 6 }], pageCount: 10 };
  assert.deepEqual(store.clipValidity(noTitle, null).reasons.includes('needs title'), true);

  const noPages = { kind: 'pdf', title: 'P', missing: false, pages: [{ page: 99, seconds: 6 }], pageCount: 3 };
  assert.equal(store.clipValidity(noPages, null).valid, false);

  const missing = { kind: 'pdf', title: 'P', missing: true, pages: [{ page: 1, seconds: 6 }], pageCount: 3 };
  assert.deepEqual(store.clipValidity(missing, null).reasons.includes('file missing'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pdf-store.test.mjs`
Expected: FAIL — `store.setPageCount is not a function`.

- [ ] **Step 3: Add the `PAGES_KEY` constant and constructor/load wiring**

In `js/store.js`, after `const DUR_KEY = 'showreel.durations.v1';` add:

```js
const PAGES_KEY = 'showreel.pagecounts.v1';
```

In the `Store` constructor, after `this.durations = {};` add:

```js
    this.pageCounts = {}; // cache: "name|size|mtime" -> page count
```

In `load()`, after the `this.durations = ...` try/catch block, add:

```js
    try {
      this.pageCounts = JSON.parse(localStorage.getItem(PAGES_KEY) || '{}') || {};
    } catch (_) {
      this.pageCounts = {};
    }
```

- [ ] **Step 4: Add `getCachedPageCount` and `setPageCount`**

In `js/store.js`, immediately after the durations-cache section (`setDuration` method), add:

```js
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
```

- [ ] **Step 5: Adopt a cached page count in `reconcile`**

In `js/store.js` `reconcile`, inside the `if (!clip) { ... }` block (new-file branch), after adopting the cached duration, add a PDF branch. Replace:

```js
        clip = defaultClip(v.name, sig, i * 10, v.kind);
        // adopt a cached duration if we have one for this exact file signature
        const cached = this.getCachedDuration(v);
        if (cached != null) clip.duration = cached;
        this.doc.clips[v.name] = clip;
```

with:

```js
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
```

- [ ] **Step 6: Branch `trimmedLength` and `clipValidity` on kind**

In `js/store.js`, replace `trimmedLength` with:

```js
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
```

In `js/store.js`, at the very top of `clipValidity(clip, serverEntry)` (before the existing segment logic), add a PDF branch:

```js
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
```

(Keep the rest of the existing video `clipValidity` body unchanged after this point. Remove the now-duplicated leading `if (clip.missing)` / `if (!clip.title…)` lines that previously started the method — they are now at the top above the PDF branch.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test` (full suite)
Expected: PASS — all server + store tests green.

- [ ] **Step 8: Commit**

```bash
git add js/store.js test/pdf-store.test.mjs
git commit -m "feat(store): resolve/clamp PDF page count; PDF length and validity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Vendor PDF.js and add the `js/pdf.js` wrapper

**Files:**
- Create: `js/vendor/pdfjs/pdf.mjs`, `js/vendor/pdfjs/pdf.worker.mjs` (downloaded)
- Create: `js/pdf.js`
- Test: `test/pdf-vendor.test.mjs` (create — file presence + wrapper parse)

**Interfaces:**
- Produces: `js/pdf.js` exports `loadDoc(url) -> Promise<{ doc, numPages }>` (cached per URL) and `renderPage(doc, pageNum, canvas, opts?) -> Promise<void>` (`opts.maxDim` caps the rendered pixel size, default 1600). Consumed by `player.js` and `ui.js`.

- [ ] **Step 1: Download the vendored PDF.js dist (pinned v4.x)**

Run (needs network this once; pinned to a known stable 4.x release):

```bash
mkdir -p js/vendor/pdfjs
curl -fsSL https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.mjs        -o js/vendor/pdfjs/pdf.mjs
curl -fsSL https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.mjs -o js/vendor/pdfjs/pdf.worker.mjs
ls -lh js/vendor/pdfjs/
```
Expected: two `.mjs` files, ~300 KB (`pdf.mjs`) and ~1–2 MB (`pdf.worker.mjs`). If 4.10.38 is unavailable, use the latest `pdfjs-dist@4` and record the version in the commit message.

- [ ] **Step 2: Write the wrapper `js/pdf.js`**

```js
// pdf.js — thin wrapper over the vendored Mozilla PDF.js. One job: load a PDF
// (cached per URL) and render a page to a <canvas>, fitted to a pixel budget.
import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';

// The worker is served by our own static server, so this works fully offline.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

const _docs = new Map(); // url -> Promise<{ doc, numPages }>

/** Load + parse a PDF (cached per URL). Resolves with the doc and its length. */
export function loadDoc(url) {
  if (_docs.has(url)) return _docs.get(url);
  const promise = pdfjsLib.getDocument(url).promise.then((doc) => ({ doc, numPages: doc.numPages }));
  _docs.set(url, promise);
  promise.catch(() => _docs.delete(url)); // a failed load shouldn't poison the cache
  return promise;
}

/**
 * Render a 1-based page to `canvas`, scaled so its larger side is at most
 * `opts.maxDim` device pixels (default 1600). The canvas's intrinsic size is set
 * to the rendered size; CSS (max-width/height:100%) letterboxes it to fit.
 */
export async function renderPage(doc, pageNum, canvas, opts = {}) {
  const maxDim = opts.maxDim || 1600;
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(maxDim / base.width, maxDim / base.height);
  const viewport = page.getViewport({ scale });
  const ctx = canvas.getContext('2d');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
}
```

- [ ] **Step 3: Write the presence/parse test**

Create `test/pdf-vendor.test.mjs`:

```js
// pdf-vendor.test.mjs — the vendored library and wrapper are present & parseable.
// (Functional rendering needs a browser canvas and is verified manually.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('vendored PDF.js dist files exist', () => {
  assert.ok(existsSync(root + 'js/vendor/pdfjs/pdf.mjs'), 'pdf.mjs missing');
  assert.ok(existsSync(root + 'js/vendor/pdfjs/pdf.worker.mjs'), 'pdf.worker.mjs missing');
});

test('wrapper exports loadDoc and renderPage', () => {
  const src = readFileSync(root + 'js/pdf.js', 'utf8');
  assert.match(src, /export function loadDoc/);
  assert.match(src, /export async function renderPage/);
  assert.match(src, /GlobalWorkerOptions\.workerSrc/);
});
```

- [ ] **Step 4: Run the test + syntax-check the wrapper**

Run: `node --test test/pdf-vendor.test.mjs`
Expected: PASS (2 tests).
Run: `node --check js/pdf.js`
Expected: no output (parses cleanly).

- [ ] **Step 5: Commit (note: large vendored files)**

```bash
git add js/vendor/pdfjs/pdf.mjs js/vendor/pdfjs/pdf.worker.mjs js/pdf.js test/pdf-vendor.test.mjs
git commit -m "feat: vendor PDF.js (pinned 4.10.38) + canvas render wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: HTML, CSS, and DOM refs scaffolding

**Files:**
- Modify: `index.html` (player layer + authoring PDF editor block)
- Modify: `styles.css` (`.lib-section`, `#pdfCanvas`, PDF thumb, PDF editor)
- Modify: `js/main.js` (refs + `onPageCount` wiring)

**Interfaces:**
- Produces DOM ids consumed by Tasks 6–9: `#pdfCanvas` (player), and in `#pdfEditor`: `#pdfPreviewCanvas`, `#pdfPrevPageBtn`, `#pdfNextPageBtn`, `#pdfPageReadout`, `#pdfPageList`, `#pdfAddPageBtn`, `#pdfTitleInput`, `#pdfTitleError`, `#pdfEnabledInput`, `#pdfForgetBtn`. New `refs.*` of the same camelCase names. Player gains `onPageCount(server, n)` callback wired to `store.setPageCount`.

- [ ] **Step 1: Add the `#pdfCanvas` player layer**

In `index.html`, inside `<div id="player" …>`, after the two `<video>` elements (after the `videoB` line), add:

```html
    <canvas id="pdfCanvas" class="player__pdf" aria-hidden="true"></canvas>
```

- [ ] **Step 2: Add the PDF authoring editor block**

In `index.html`, inside `<section id="authoringPane" …>`, immediately after the closing `</div>` of `#authoringEditor` (and before `</section>`), add:

```html
        <div id="pdfEditor" class="editor editor--pdf" hidden>
          <div class="editor__preview">
            <canvas id="pdfPreviewCanvas" class="preview-pdf" aria-label="PDF page preview"></canvas>
            <div class="pdf-pagebar">
              <button id="pdfPrevPageBtn" class="btn btn--ghost btn--sm" type="button" aria-label="Preview previous page">‹ Prev</button>
              <span id="pdfPageReadout" class="muted" aria-live="polite">—</span>
              <button id="pdfNextPageBtn" class="btn btn--ghost btn--sm" type="button" aria-label="Preview next page">Next ›</button>
            </div>
          </div>

          <div class="editor__fields">
            <label class="field">
              <span class="field__label">Title <span class="req" aria-hidden="true">*</span></span>
              <input id="pdfTitleInput" class="field__input" type="text" maxlength="120"
                     required aria-required="true" aria-describedby="pdfTitleError"
                     placeholder="Title shown as the headline" />
              <span id="pdfTitleError" class="inline-error" role="alert" hidden>A title is required.</span>
            </label>

            <div class="segments">
              <div class="segments__head">
                <span class="field__label">Pages</span>
                <button id="pdfAddPageBtn" class="btn btn--ghost btn--sm" type="button"
                        aria-label="Add a page to the slideshow">+ Add page</button>
              </div>
              <ul id="pdfPageList" class="seg-list" aria-label="Pages in the slideshow"></ul>
            </div>

            <label class="field field--check">
              <input id="pdfEnabledInput" type="checkbox" checked />
              <span>Include this PDF in the showreel</span>
            </label>

            <button id="pdfForgetBtn" class="btn btn--ghost btn--sm" type="button" hidden>
              🗑 remove this PDF
            </button>
          </div>
        </div>
```

- [ ] **Step 3: Add CSS**

Append to `styles.css`:

```css
/* ---- Library section headers ---- */
.lib-section {
  list-style: none;
  padding: 10px 4px 4px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-2, #8a8f98);
}
.lib-section:first-child { padding-top: 0; }

/* ---- PDF clip badge + thumbnail ---- */
.badge--pdf { background: #5b3fbf; color: #fff; }
.lib-card__thumb canvas.thumb { width: 100%; height: 100%; object-fit: contain; background: #fff; }

/* ---- PDF page slideshow in the fullscreen player ---- */
.player__pdf {
  position: absolute; inset: 0; margin: auto;
  max-width: 100%; max-height: 100%;
  display: none; background: #fff;
}
.player__pdf.is-active { display: block; }

/* ---- PDF authoring editor ---- */
.editor--pdf .preview-pdf {
  width: 100%; max-height: 320px; object-fit: contain;
  background: #fff; border-radius: 8px;
}
.pdf-pagebar { display: flex; align-items: center; gap: 12px; justify-content: center; margin-top: 8px; }
.seg-row__seconds { width: 72px; }
```

- [ ] **Step 4: Add DOM refs and `onPageCount` wiring in `js/main.js`**

In `js/main.js`, add to the `refs` object — under `// player`, after `videoB`:

```js
  pdfCanvas: byId('pdfCanvas'),
```

…and under `// authoring`, after `forgetBtn`:

```js
  pdfEditor: byId('pdfEditor'),
  pdfPreviewCanvas: byId('pdfPreviewCanvas'),
  pdfPrevPageBtn: byId('pdfPrevPageBtn'),
  pdfNextPageBtn: byId('pdfNextPageBtn'),
  pdfPageReadout: byId('pdfPageReadout'),
  pdfPageList: byId('pdfPageList'),
  pdfAddPageBtn: byId('pdfAddPageBtn'),
  pdfTitleInput: byId('pdfTitleInput'),
  pdfTitleError: byId('pdfTitleError'),
  pdfEnabledInput: byId('pdfEnabledInput'),
  pdfForgetBtn: byId('pdfForgetBtn'),
```

In `js/main.js` `player.init({ … })`, add the `pdfCanvas` ref and the page-count callback. Add `pdfCanvas: refs.pdfCanvas,` to the object, and after the `onDuration` handler add:

```js
    onPageCount: (sv, n) => {
      if (!sv) return;
      store.setPageCount(sv, n);
      ui.renderCard(sv.name);
      if (ui.selected === sv.name) ui.renderAuthoring();
    },
```

- [ ] **Step 5: Verify it loads and serves (syntax + grep)**

Run: `node --check js/main.js`  → no output.
Run:
```bash
node -e 'const {handler}=require("./server.js"); console.log("server module loads OK")'
```
Expected: `server module loads OK`.
Run: `grep -c "pdfCanvas\|pdfEditor\|pdfPageList" index.html`
Expected: ≥ 3.

- [ ] **Step 6: Commit**

```bash
git add index.html styles.css js/main.js
git commit -m "feat(ui): scaffold PDF player canvas, authoring editor, and refs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Library grouping (Videos / PDFs / Missing)

**Files:**
- Modify: `js/ui.js` (`renderLibrary`)

**Interfaces:**
- Consumes: `store.library` entries with `kind` (Task 1); `_card(name, sv)` (existing).
- Produces: a sectioned library. Adds private helper `_sectionHeader(label, count)`. Headers are `<li class="lib-section" role="presentation">`; cards remain the listbox options (↑/↓ nav unaffected).

- [ ] **Step 1: Replace `renderLibrary` in `js/ui.js`**

```js
  renderLibrary() {
    const list = this.r.libraryList;
    const entries = store.library; // present files, already sorted by the server
    const videos = entries.filter((v) => v.kind !== 'pdf');
    const pdfs = entries.filter((v) => v.kind === 'pdf');
    const missing = Object.entries(store.doc.clips)
      .filter(([, c]) => c.missing)
      .map(([name]) => name);

    if (this.r.forgetMissingBtn) {
      this.r.forgetMissingBtn.hidden = missing.length === 0;
      this.r.forgetMissingBtn.textContent = `🗑 Forget ${missing.length} missing`;
    }

    list.textContent = '';
    const empty = entries.length === 0 && missing.length === 0;
    this.r.libraryEmpty.hidden = !empty;
    list.hidden = empty;
    if (empty) return;

    const smap = this.serverMap();
    if (videos.length) {
      list.append(this._sectionHeader('Videos', videos.length));
      for (const v of videos) list.append(this._card(v.name, smap.get(v.name)));
    }
    if (pdfs.length) {
      list.append(this._sectionHeader('PDFs', pdfs.length));
      for (const v of pdfs) list.append(this._card(v.name, smap.get(v.name)));
    }
    if (missing.length) {
      list.append(this._sectionHeader('⚠ Missing', missing.length));
      for (const name of missing) list.append(this._card(name, null));
    }
  }

  /** A non-interactive section header row for the library listbox. */
  _sectionHeader(label, count) {
    return el('li', { class: 'lib-section', role: 'presentation' }, `${label} (${count})`);
  }
```

- [ ] **Step 2: Syntax-check**

Run: `node --check js/ui.js`
Expected: no output.

- [ ] **Step 3: Manual verification (user, in browser)**

Start `npm start`, open the app. Expected: the Library shows a **Videos (33)** header above the video cards and a **PDFs (2)** header above two cards (1771, 5059). ↑/↓ arrow keys still move between cards, skipping headers. If there are stale missing clips, a **⚠ Missing (N)** section appears last.

- [ ] **Step 4: Commit**

```bash
git add js/ui.js
git commit -m "feat(ui): group the Library into Videos / PDFs / Missing sections

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: PDF Library card (thumbnail, meta, badge)

**Files:**
- Modify: `js/ui.js` (`_card`, `_metaText`, `_badges`, `_observeThumb`)
- Modify: `js/ui.js` imports (add `loadDoc`, `renderPage`)

**Interfaces:**
- Consumes: `js/pdf.js` (`loadDoc`, `renderPage`); server entry `kind`/`url`.
- Produces: PDF cards show a first-page canvas thumbnail, a `PDF` badge, and meta `"<n> pages · plays <Xs>"`.

- [ ] **Step 1: Import the PDF wrapper in `js/ui.js`**

At the top of `js/ui.js`, after the `import { store } …` line, add:

```js
import { loadDoc, renderPage } from './pdf.js';
```

- [ ] **Step 2: Branch the thumbnail in `_card`**

In `js/ui.js` `_card`, replace the thumbnail block:

```js
    const thumb = el('div', { class: 'lib-card__thumb' });
    if (clip.kind === 'pdf' && sv) {
      const cv = el('canvas', { class: 'thumb' });
      cv.setAttribute('aria-hidden', 'true');
      this._observePdfThumb(cv, sv);
      thumb.append(cv);
    } else if (sv && !sv.unplayable) {
      const vid = el('video', { class: 'thumb', muted: true, preload: 'none', playsInline: true });
      vid.setAttribute('aria-hidden', 'true');
      this._observeThumb(vid, sv, clip);
      thumb.append(vid);
    } else {
      thumb.append(el('span', { class: 'placeholder', text: clip.kind === 'pdf' ? '📄' : '🎞' }));
    }
```

- [ ] **Step 3: Add `_observePdfThumb`**

In `js/ui.js`, after `_observeThumb`, add:

```js
  /** Lazily render the first PDF page into a card thumbnail when it scrolls in. */
  _observePdfThumb(canvas, sv) {
    if (!this._pdfThumbObserver) {
      this._pdfThumbObserver = new IntersectionObserver((items) => {
        for (const it of items) {
          if (!it.isIntersecting) continue;
          const cv = it.target;
          this._pdfThumbObserver.unobserve(cv);
          loadDoc(sv.url)
            .then(({ doc }) => renderPage(doc, 1, cv, { maxDim: 400 }))
            .catch(() => { /* a broken PDF just shows blank */ });
        }
      }, { rootMargin: '200px' });
    }
    this._pdfThumbObserver.observe(canvas);
  }
```

- [ ] **Step 4: Branch `_metaText` and `_badges`**

In `js/ui.js` `_metaText`, add at the very top:

```js
    if (clip.missing) return 'File no longer in folder';
    if (clip.kind === 'pdf') {
      const n = (clip.pages || []).length;
      const len = store.trimmedLength(clip);
      const count = clip.pageCount != null ? ` of ${clip.pageCount}` : '';
      return `${n}${count} page${n === 1 ? '' : 's'} · plays ${formatShort(len)}`;
    }
```

(Remove the old standalone `if (clip.missing) return 'File no longer in folder';` line that previously started the method so it isn't duplicated.)

In `js/ui.js` `_badges`, after the `if (clip.missing) { … return wrap; }` line, add:

```js
    if (clip.kind === 'pdf') add('badge--pdf', 'PDF');
```

- [ ] **Step 5: Syntax-check**

Run: `node --check js/ui.js`
Expected: no output.

- [ ] **Step 6: Manual verification (user)**

Reload the app. Expected: cards 1771 and 5059 show a rendered first-page thumbnail, a purple `PDF` badge, and meta like `10 of 18 pages · plays 1:00`. (Page count appears after the PDF loads.)

- [ ] **Step 7: Commit**

```bash
git add js/ui.js
git commit -m "feat(ui): PDF card thumbnail, PDF badge, and page-based meta

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: PDF authoring editor (preview, page list, page ops)

**Files:**
- Modify: `js/ui.js` (`renderAuthoring`, new `_renderPdfEditor`, page ops, bindings)

**Interfaces:**
- Consumes: `#pdfEditor` ids (Task 5), `loadDoc`/`renderPage` (Task 4), `store.updateClip`, `store.forgetClip`.
- Produces: when a PDF clip is selected, `#pdfEditor` shows (and `#authoringEditor` hides). The user previews any page, edits per-page seconds, adds/removes pages; edits persist via `store.updateClip(name, { pages })` keeping pages ascending + de-duped.

- [ ] **Step 1: Bind PDF editor controls (in `init`)**

In `js/ui.js` `init`, after the existing `_bindConfigButtons();` call, add:

```js
    this._bindPdfEditor();
```

Then add the method (place it near `_bindAuthoring`):

```js
  _bindPdfEditor() {
    const r = this.r;
    if (!r.pdfEditor) return;
    this._pdfPreviewPage = 1;

    r.pdfTitleInput.addEventListener('input', () => {
      if (!this.selected) return;
      this._saveTitle(this.selected, r.pdfTitleInput.value);
      const clip = store.getClip(this.selected);
      r.pdfTitleError.hidden = !(clip && (!r.pdfTitleInput.value || !r.pdfTitleInput.value.trim()));
    });

    r.pdfEnabledInput.addEventListener('change', () => {
      if (!this.selected) return;
      store.updateClip(this.selected, { enabled: r.pdfEnabledInput.checked });
      this.renderCard(this.selected);
      this.updatePlayState();
      this._flashSaved();
    });

    r.pdfPrevPageBtn.addEventListener('click', () => this._stepPdfPreview(-1));
    r.pdfNextPageBtn.addEventListener('click', () => this._stepPdfPreview(1));
    r.pdfAddPageBtn.addEventListener('click', () => this._addPdfPage());

    r.pdfPageList.addEventListener('click', (e) => {
      const row = e.target.closest('.seg-row');
      if (!row) return;
      const page = Number(row.dataset.page);
      if (e.target.closest('button[data-act="del"]')) { this._removePdfPage(page); return; }
      this._pdfPreviewPage = page;
      this._renderPdfPreview();
      this._markPdfRowSelected(page);
    });
    r.pdfPageList.addEventListener('change', (e) => {
      const input = e.target.closest('input[data-act="seconds"]');
      if (!input) return;
      this._setPdfPageSeconds(Number(input.dataset.page), input.value);
    });

    r.pdfForgetBtn.addEventListener('click', () => {
      const name = this.selected;
      if (!name) return;
      store.forgetClip(name);
      this.selected = null;
      this.refreshAll();
      this._flashSaved();
      this.toast(`Forgot “${name}”.`);
    });
  }
```

- [ ] **Step 2: Branch `renderAuthoring` on kind**

In `js/ui.js` `renderAuthoring`, replace the method body with:

```js
  renderAuthoring() {
    const name = this.selected;
    const clip = name ? store.getClip(name) : null;
    const sv = name ? this.serverEntry(name) : null;
    const isPdf = !!(clip && clip.kind === 'pdf');

    this.r.authoringEmpty.hidden = !!clip;
    this.r.authoringEditor.hidden = !clip || isPdf;
    if (this.r.pdfEditor) this.r.pdfEditor.hidden = !isPdf;
    if (!clip) return;

    if (isPdf) { this._renderPdfEditor(clip, sv, name); return; }

    // ---- existing video editor path (unchanged) ----
    const prev = this.r.previewVideo;
    const missing = clip.missing || !sv;
    if (missing) {
      prev.removeAttribute('src');
      delete prev.dataset.for;
      this.r.trimPlayhead.hidden = true;
    } else {
      this._loadPreview(prev, sv, clip, name);
    }
    this.r.titleInput.value = clip.title || '';
    this.r.enabledInput.checked = clip.enabled !== false;
    this.r.forgetBtn.hidden = !clip.missing;
    this._syncEditor();
  }
```

- [ ] **Step 3: Add the PDF editor renderers and page ops**

In `js/ui.js`, add these methods (near `renderAuthoring`):

```js
  _renderPdfEditor(clip, sv, name) {
    const r = this.r;
    r.pdfTitleInput.value = clip.title || '';
    r.pdfTitleError.hidden = !!(clip.title && clip.title.trim());
    r.pdfEnabledInput.checked = clip.enabled !== false;
    r.pdfForgetBtn.hidden = !clip.missing;
    // Clamp the preview page to a page that's in the clip's list.
    const pages = clip.pages || [];
    if (!pages.some((p) => p.page === this._pdfPreviewPage)) {
      this._pdfPreviewPage = pages.length ? pages[0].page : 1;
    }
    this._renderPdfPageList(clip);
    this._renderPdfPreview();
  }

  _renderPdfPageList(clip) {
    const list = this.r.pdfPageList;
    list.textContent = '';
    const pages = clip.pages || [];
    this.r.pdfPageReadout.textContent = clip.pageCount != null
      ? `page ${this._pdfPreviewPage} of ${clip.pageCount}`
      : `page ${this._pdfPreviewPage}`;
    for (const p of pages) {
      const row = el('li', {
        class: `seg-row${p.page === this._pdfPreviewPage ? ' is-selected' : ''}`,
        dataset: { page: String(p.page) },
      });
      row.append(el('span', { class: 'seg-row__label', text: `Page ${p.page}` }));
      const ctrls = el('span', { class: 'seg-row__ctrls' });
      const sec = el('input', {
        class: 'field__input field__input--num seg-row__seconds',
        type: 'number', min: String(MIN_PDF_PAGE_SECONDS), step: '0.5',
        value: String(p.seconds), 'aria-label': `Seconds for page ${p.page}`,
        dataset: { act: 'seconds', page: String(p.page) },
      });
      ctrls.append(sec, el('span', { class: 'muted', text: 's' }),
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: '✕',
          'aria-label': `Remove page ${p.page}`, dataset: { act: 'del' } }));
      row.append(ctrls);
      list.append(row);
    }
  }

  _renderPdfPreview() {
    const clip = store.getClip(this.selected);
    const sv = this.serverEntry(this.selected);
    if (!clip || clip.kind !== 'pdf' || !sv) return;
    loadDoc(sv.url)
      .then(({ doc, numPages }) => {
        if (clip.pageCount == null) store.setPageCount(sv, numPages); // resolves count once
        const page = clamp(this._pdfPreviewPage, 1, numPages);
        this._pdfPreviewPage = page;
        return renderPage(doc, page, this.r.pdfPreviewCanvas, { maxDim: 1000 });
      })
      .then(() => { this.r.pdfPageReadout.textContent = `page ${this._pdfPreviewPage}${clip.pageCount != null ? ` of ${clip.pageCount}` : ''}`; })
      .catch(() => { /* broken PDF: leave the canvas as-is */ });
  }

  _stepPdfPreview(dir) {
    const clip = store.getClip(this.selected);
    if (!clip) return;
    const max = clip.pageCount != null ? clip.pageCount : this._pdfPreviewPage + 1;
    this._pdfPreviewPage = clamp(this._pdfPreviewPage + dir, 1, max);
    this._renderPdfPreview();
    this._markPdfRowSelected(this._pdfPreviewPage);
  }

  _markPdfRowSelected(page) {
    for (const row of $all('.seg-row', this.r.pdfPageList)) {
      row.classList.toggle('is-selected', Number(row.dataset.page) === page);
    }
  }

  /** Write a new page list (ascending, de-duped) back to the store. */
  _commitPdfPages(name, pages) {
    const seen = new Set();
    const clean = pages
      .map((p) => ({ page: Math.max(1, Math.round(p.page)), seconds: Math.max(MIN_PDF_PAGE_SECONDS, round3(p.seconds)) }))
      .sort((a, b) => a.page - b.page)
      .filter((p) => (seen.has(p.page) ? false : (seen.add(p.page), true)));
    store.updateClip(name, { pages: clean });
    this.renderAuthoring();
    this.renderCard(name);
    this.updatePlayState();
    this._flashSaved();
  }

  _setPdfPageSeconds(page, raw) {
    const clip = store.getClip(this.selected);
    if (!clip) return;
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < MIN_PDF_PAGE_SECONDS) { this.renderAuthoring(); return; }
    this._commitPdfPages(this.selected, clip.pages.map((p) => p.page === page ? { ...p, seconds } : p));
  }

  _removePdfPage(page) {
    const clip = store.getClip(this.selected);
    if (!clip || clip.pages.length <= 1) return; // keep at least one page
    this._commitPdfPages(this.selected, clip.pages.filter((p) => p.page !== page));
  }

  _addPdfPage() {
    const clip = store.getClip(this.selected);
    if (!clip) return;
    const used = new Set(clip.pages.map((p) => p.page));
    const max = clip.pageCount != null ? clip.pageCount : Infinity;
    let next = 1;
    while (used.has(next) && next <= max) next++;
    if (next > max) { this.toast('All pages are already in the slideshow.', 'warn'); return; }
    this._pdfPreviewPage = next;
    this._commitPdfPages(this.selected, [...clip.pages, { page: next, seconds: DEFAULT_PDF_PAGE_SECONDS }]);
  }
```

- [ ] **Step 4: Add UI-side constants**

In `js/ui.js`, after the imports, add (these mirror the store's defaults for the UI layer):

```js
const DEFAULT_PDF_PAGE_SECONDS = 6;
const MIN_PDF_PAGE_SECONDS = 0.5;
```

- [ ] **Step 5: Ensure selection clears stale state**

In `js/ui.js` `select(name)`, after `this.selSeg = 0;` add:

```js
    this._pdfPreviewPage = 1;
```

- [ ] **Step 6: Syntax-check**

Run: `node --check js/ui.js`
Expected: no output.

- [ ] **Step 7: Manual verification (user)**

Reload, click the **1771** card. Expected: the authoring pane shows a page preview with ‹ Prev / Next ›, a list of pages 1–10 each with an editable seconds field and a ✕, and `+ Add page`. Editing a page's seconds updates the card meta + playlist total; removing/adding a page updates the list; the page count `of 18` appears after the PDF loads.

- [ ] **Step 8: Commit**

```bash
git add js/ui.js
git commit -m "feat(ui): PDF authoring editor — page preview, per-page seconds, add/remove

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Player — PDF slideshow playback path

**Files:**
- Modify: `js/player.js` (imports, `init`, `reset`, `_prepare`, `_activate`, `_clearWatchers`, `_updateProgress`, `_onKey`, `finish`; new PDF methods)

**Interfaces:**
- Consumes: `loadDoc`/`renderPage` (Task 4); `this.pdfCanvas` ref + `onPageCount` callback (Task 5); `entry.clip.kind`/`pages`/`pageCount`.
- Produces: PDF clips play as a page slideshow inside the same sequence/`advance()` flow; the video engine is untouched.

- [ ] **Step 1: Import the wrapper and add refs/state**

In `js/player.js`, after the existing `import … from './util.js';` line, add:

```js
import { loadDoc, renderPage } from './pdf.js';
```

In `init`, after `this.captionEl = refs.captionEl;` (the line setting the caption overlay) add:

```js
    this.pdfCanvas = refs.pdfCanvas;
    this.onPageCount = refs.onPageCount || (() => {});
```

In `reset`, after the `this._captionText = null;` line add:

```js
    this._pdfTimer = null;
    this._pdfDoc = null;
    this._pdfPages = [];
    this._pdfIdx = 0;
    this._pdfPaused = false;
    this._pdfArmedAt = 0;
    this._pdfArmedMs = 0;
    this._pdfRemaining = null;
    if (this.pdfCanvas) this.pdfCanvas.classList.remove('is-active');
```

- [ ] **Step 2: Branch `_prepare` for PDFs**

In `js/player.js` `_prepare(v, baseIdx)`, add at the very top (before `const entry = this.base[baseIdx];` is used for video):

```js
  _prepare(v, baseIdx) {
    const entry = this.base[baseIdx];
    if (entry.clip.kind === 'pdf') {
      const url = entry.server ? entry.server.url : '/videos/' + encodePath(entry.name);
      return loadDoc(url).then(({ numPages }) => {
        if (entry.server) this.onPageCount(entry.server, numPages);
      });
    }
    // ---- existing video prepare below (unchanged) ----
    const url = entry.server ? entry.server.url : '/videos/' + encodePath(entry.name);
```

(The original method already declared `const entry`/`const url`; keep the rest of the body but ensure those two `const` declarations are not duplicated — the PDF branch returns before reaching them, and the video path keeps its own `const url`. Rename the PDF branch's local to avoid a clash, e.g. use the inline expression as shown.)

- [ ] **Step 3: Branch `_activate` for PDFs + add PDF activation**

In `js/player.js` `_activate(baseIdx)`, add at the very top:

```js
  _activate(baseIdx) {
    if (this.base[baseIdx].clip.kind === 'pdf') { this._activatePdf(baseIdx); return; }
    // ---- existing video activate below (unchanged) ----
    const v = this.videos[this.activeIdx];
```

Then add these methods after `_activate`:

```js
  _activatePdf(baseIdx) {
    const entry = this.base[baseIdx];
    const clip = entry.clip;
    this._activeClip = clip;

    for (const vid of this.videos) { try { vid.pause(); } catch (_) { /* */ } vid.classList.remove('is-active'); }
    this.pdfCanvas.classList.add('is-active');
    this._loadCaptions({}); // PDFs have no captions; clears any leftover overlay

    this.titleEl.textContent = clip.title || entry.name;
    this.titleEl.classList.toggle('is-visible', this.overlayEnabled);

    this._pdfPages = (clip.pages || []).filter((p) => clip.pageCount == null || p.page <= clip.pageCount);
    if (!this._pdfPages.length) this._pdfPages = [{ page: 1, seconds: 6 }];
    this._pdfIdx = 0;
    this._pdfPaused = false;
    this._pdfRemaining = null;
    this._updateProgress();

    const url = entry.server ? entry.server.url : '/videos/' + encodePath(entry.name);
    loadDoc(url).then(({ doc }) => {
      if (!this.running || this._activeClip !== clip) return;
      this._pdfDoc = doc;
      this._renderPdfAndArm();
    }).catch((e) => { this._segmentDonePdfFail(baseIdx, e); });
  }

  _segmentDonePdfFail(baseIdx, e) {
    // Mirror the video failure path so a broken PDF is skipped, not fatal.
    if (!this.running) return;
    this.failedBase.add(baseIdx);
    this._recordFailure(baseIdx, e);
    this.advance('pdf-error');
  }

  _renderPdfAndArm() {
    const tok = ++this.activeToken; // invalidate any prior timer
    const cur = this._pdfPages[this._pdfIdx];
    renderPage(this._pdfDoc, cur.page, this.pdfCanvas).catch(() => {});
    this._armPdfTimer(cur.seconds * 1000, tok);
  }

  _armPdfTimer(ms, tok) {
    clearTimeout(this._pdfTimer);
    this._pdfArmedAt = performance.now();
    this._pdfArmedMs = ms;
    this._pdfTimer = setTimeout(() => {
      if (tok !== this.activeToken || !this.running) return;
      this._pdfAdvancePage();
    }, ms);
  }

  _pdfAdvancePage() {
    if (this._pdfIdx < this._pdfPages.length - 1) {
      this._pdfIdx++;
      this._updateProgress();
      this._renderPdfAndArm();
    } else {
      this.advance('pdf-end'); // last page -> next clip (clears the timer via _clearWatchers)
    }
  }
```

- [ ] **Step 4: Clear the PDF timer in `_clearWatchers`**

In `js/player.js` `_clearWatchers`, after `clearTimeout(this._outTimer); this._outTimer = null;` add:

```js
    clearTimeout(this._pdfTimer);
    this._pdfTimer = null;
```

- [ ] **Step 5: Show a page label in `_updateProgress`**

In `js/player.js` `_updateProgress`, replace the `segLabel` line with:

```js
    let segLabel = '';
    if (this._activeClip && this._activeClip.kind === 'pdf') {
      segLabel = ` · page ${this._pdfIdx + 1}/${this._pdfPages.length}`;
    } else if (this._segs && this._segs.length > 1) {
      segLabel = ` · seg ${this._segIdx + 1}/${this._segs.length}`;
    }
```

- [ ] **Step 6: Handle keys for PDF clips**

In `js/player.js` `_onKey(e)`, at the top of the `switch`'s `' '` (Space), `'ArrowLeft'` cases, and the volume/mute cases, add PDF branches. Replace the Space case body with:

```js
      case ' ': case 'Spacebar':
        e.preventDefault();
        if (this._activeClip && this._activeClip.kind === 'pdf') {
          if (this._pdfPaused) {
            this._pdfPaused = false;
            this._armPdfTimer(this._pdfRemaining != null ? this._pdfRemaining : this._pdfPages[this._pdfIdx].seconds * 1000, this.activeToken);
          } else {
            this._pdfPaused = true;
            clearTimeout(this._pdfTimer); this._pdfTimer = null;
            this._pdfRemaining = Math.max(0, this._pdfArmedMs - (performance.now() - this._pdfArmedAt));
          }
          break;
        }
        if (v.paused) { v.play().catch(() => {}); this._armOutTimer(v, this._outP); }
        else { v.pause(); clearTimeout(this._outTimer); this._outTimer = null; }
        break;
```

Replace the `ArrowLeft` case body with:

```js
      case 'ArrowLeft':
        e.preventDefault();
        if (this._activeClip && this._activeClip.kind === 'pdf') {
          this._clearWatchers();
          this._pdfIdx = 0;
          this._pdfPaused = false;
          this._pdfRemaining = null;
          if (this.overlayEnabled) { this.titleEl.textContent = this._activeClip.title || ''; this.titleEl.classList.add('is-visible'); }
          this._updateProgress();
          this._renderPdfAndArm();
          break;
        }
        this._restartCurrent();
        break;
```

In the `ArrowUp`, `ArrowDown`, and `m`/`M` cases, add a guard as the first line of each case body so PDF audio keys are no-ops:

```js
        if (this._activeClip && this._activeClip.kind === 'pdf') { e.preventDefault(); break; }
```

(`ArrowRight` already calls `advance('skip')`, which works for PDFs via `_clearWatchers`/`_goNext` — leave it unchanged.)

- [ ] **Step 7: Release the PDF layer in `finish`**

In `js/player.js` `finish`, after the `for (const v of this.videos) { try { v.pause(); } … }` line add:

```js
    clearTimeout(this._pdfTimer); this._pdfTimer = null;
    if (this.pdfCanvas) this.pdfCanvas.classList.remove('is-active');
    this._pdfDoc = null;
```

- [ ] **Step 8: Syntax-check**

Run: `node --check js/player.js`
Expected: no output.

- [ ] **Step 9: Manual verification (user)**

Ensure 1771 and 5059 are enabled (they are by default) and titled, then **Play fullscreen**. Expected: video clips play as before; when a PDF clip comes up, the canvas shows page 1, advances every 6 s through the selected pages, the headline shows the title, the progress hint reads `… · page p/N`, **Space** pauses/resumes, **←** restarts at page 1, **→** skips to the next clip, and **Esc** exits.

- [ ] **Step 10: Commit**

```bash
git add js/player.js
git commit -m "feat(player): play PDF clips as a timed page slideshow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Documentation + full verification pass

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document PDF clips in the README**

In `README.md`, under the "Folder layout" / file-matching area, add a paragraph:

```markdown
### PDF-only submissions

A submission that has a **PDF but no video** still appears in the Library (under
a **PDFs** section) and plays in the showreel as a timed slideshow: by default
the **first 10 pages, 6 seconds each** (clamped to the PDF's length). Select it
to choose exactly which pages to show and set each page's own duration. PDFs are
rendered with a bundled copy of Mozilla PDF.js — no internet needed.
```

In the "Notes & limits" section, add a bullet:

```markdown
- **PDF clips** have no audio or captions; during playback `Space` pauses the
  page timer, `←` restarts at the first page, and `→` skips to the next clip.
```

- [ ] **Step 2: Run the full automated suite**

Run: `npm test`
Expected: all tests PASS (server listing, PDF store, vendor presence, plus the prior `forgetMissing` tests).

- [ ] **Step 3: Syntax-check every module**

Run:
```bash
for f in js/store.js js/ui.js js/main.js js/util.js js/player.js js/pdf.js server.js; do node --check "$f" && echo "ok: $f"; done
```
Expected: `ok:` for every file.

- [ ] **Step 4: Manual end-to-end (user)**

`npm start`, open the app, and confirm: Videos/PDFs sections; PDF thumbnails + `PDF` badge; authoring page edits persist across reload; fullscreen plays mixed video + PDF clips with correct page timing and controls.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document PDF-only submissions and PDF playback controls

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Scope (only video-less stems) → Task 1. ✓
- Vendored PDF.js → canvas → Tasks 4, 9. ✓
- Per-page selection + per-page duration; default 10 @ 6 s, clamped → Tasks 2, 3, 8. ✓
- Library Videos/PDFs/Missing split → Task 6. ✓
- PDF card (thumb/meta/badge) → Task 7. ✓
- Player branched path + timer + keys → Task 9. ✓
- `.pdf` MIME, `kind` field → Task 1. ✓
- Tests (server + store) + manual rendering note → Tasks 1–4, 10. ✓
- README → Task 10. ✓

**Type/name consistency (checked):** `kind`, `pages:[{page,seconds}]`, `pageCount`, `loadDoc`, `renderPage`, `setPageCount`, `getCachedPageCount`, `onPageCount`, the `'pagecount'` event, `#pdfCanvas`, `#pdfEditor` and its child ids, and `refs.*` names are used identically across server, store, wrapper, UI, player, and HTML.

**Placeholder scan:** none — every code step contains complete code; manual-verification steps are explicitly marked as such (browser/canvas can't run headlessly).

**Note on TDD coverage:** Tasks 1–4 are test-first against `node --test`. Tasks 5–9 are browser/canvas DOM work that cannot run headlessly in this environment (and the server socket is sandbox-blocked), so they pair an implementation step with `node --check` + a precise manual-verification step. This is the honest maximum of automated coverage for those layers.
