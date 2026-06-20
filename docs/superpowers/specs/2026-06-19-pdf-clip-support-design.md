# PDF-only submissions as showreel clips — design

- **Date:** 2026-06-19
- **Status:** Approved (design), pending implementation plan
- **App:** Showreel (UIST 2026 PC meeting tool) — vanilla HTML/CSS/JS + zero-dependency Node static/range server

## Problem

Some accepted submissions ship a PDF but no video. Today the server lists only
video extensions as playable, and `.pdf` is not even a recognized caption
sidecar, so those papers never appear in the Library and can't be shown in the
showreel. In the current `videos/auto-accept/` set this is exactly two
submissions:

| Submission | File | Pages |
| --- | --- | --- |
| `sub1771` | `uist26a-sub1771-i7.pdf` | 18 |
| `sub5059` | `uist26a-sub5059-i7.pdf` | 11 |

## Goal

Show video-less submissions in the Library and let them play in the showreel as
a **timed PDF slideshow**: render a page, hold it N seconds, advance to the next
page, then move on to the next clip. Default = **first 10 pages (clamped to the
PDF's length), 6 seconds each**. The user can choose **which pages** (add/remove)
and set **each page's own duration**.

## Non-goals (v1)

Page transition animations, PDF audio, PDF captions, manual page reordering
(pages stay ascending), and offering a PDF as an alternative for papers that
already have a video. All are easy to add later.

## Key decisions

1. **Rendering: vendored Mozilla PDF.js → `<canvas>`.** Pixel-perfect, full
   programmatic control of page + timing, clean fullscreen, works offline, and
   keeps the "no npm install / no build step" promise (the dist files are
   committed static assets). The browser-native `<iframe>#page=N` and
   server-side image pre-render approaches were rejected (poor/unreliable
   fullscreen control and an external-binary prep dependency, respectively).
2. **Page model: per-page selection + per-page duration.** A PDF clip stores an
   ordered (ascending) list of `{ page, seconds }`. Default builds pages `1..10`
   @ 6 s, clamped to the real page count once known.
3. **Only video-less submissions become PDF clips.** Grouping is decided on the
   server by submission stem; a stem with a video stays a video clip and its PDF
   remains an ignored sidecar.
4. **The video playback engine is left intact.** PDF playback is a cleanly
   branched parallel path (PDFs render instantly and need no gap-free
   double-buffer), not a rewrite of the video state machine.

## Architecture & components

### New: vendored library — `js/vendor/pdfjs/`
Mozilla PDF.js distribution: `pdf.mjs` + `pdf.worker.mjs`, committed to the repo
so the app runs fully offline. Fetched once at implementation time (needs
network then only). `GlobalWorkerOptions.workerSrc` points at the vendored
worker, served by the existing static server (`.mjs` is already in
`STATIC_TYPES`).

### New: `js/pdf.js` — PDF.js wrapper (shared)
One clear job: hide PDF.js behind a small interface used by both the player and
the UI.
- `loadDoc(url) -> Promise<{ doc, numPages }>` — caches the parsed document per
  URL (one fetch/parse per PDF per session).
- `renderPage(doc, pageNum, canvas) -> Promise<void>` — renders a 1-based page,
  scaled to fit `canvas`'s box (preserve aspect, white background).
- Depends on: the vendored PDF.js. Used by: `player.js` (fullscreen),
  `ui.js` (card thumbnails + authoring preview).

### Clip "kind"
Every clip carries `kind: 'video' | 'pdf'` (default `'video'`). The player and UI
branch on it. Server entries carry the same `kind` so the client can classify
present files; persisted clips carry it so missing PDFs are still classified.

## Server (`server.js`)

- Add `'.pdf': 'application/pdf'` to `STATIC_TYPES` (proper MIME on the stream).
- `listVideos()` (endpoint `/api/videos`, name kept) is extended to group files
  by `(dir, captionStem(name))` — the same stem rule that already pairs
  captions:
  - a stem that has a **video** file → emit the video entry as today, with
    `kind: 'video'`;
  - a stem with **no video but a PDF** → emit one entry for that PDF with
    `kind: 'pdf'`, `type: 'application/pdf'`, `url`, `size`, `mtimeMs`,
    `category`, `captionUrl` (per existing rules; none for these two). Page
    count is **not** computed server-side (no PDF parsing in Node); the client
    resolves it via PDF.js.
  - If a stem has multiple PDFs (not the case here), the first by sort wins,
    mirroring the existing caption-indexing tie-break.
- Output stays sorted by `name` with the existing numeric collation.

## Data model (`store.js`)

- **Constants:** `DEFAULT_PDF_PAGES = 10`, `DEFAULT_PAGE_SECONDS = 6`,
  `MIN_PAGE_SECONDS = 0.5`.
- **Clip shape (PDF):** `{ kind: 'pdf', title, pages: [{ page, seconds }],
  pageCount: number|null, enabled, order, missing, changed, fileSig, modifiedAt }`.
  `pages` is ordered ascending and de-duplicated by page number.
- `defaultClip(entry)` — when `entry.kind === 'pdf'`, build pages `1..10` @ 6 s
  (`pageCount` null until resolved). Video clips unchanged (`segments`).
- `normalizeDoc` / coercion — branch on `kind`: validate `pages`
  (`page` an integer ≥ 1; `seconds` finite and ≥ `MIN_PAGE_SECONDS`), sort
  ascending, drop dupes, ensure ≥ 1 page; fall back to defaults when absent.
- **Page-count resolution** mirrors video duration: a `pageCounts` cache keyed
  `name|size|mtimeMs` (parallel to `durations`), plus
  `setPageCount(entry, n)` which caches `n`, sets `clip.pageCount`, and clamps
  `pages` to `[1, n]` (dropping out-of-range pages; if all dropped, reset to
  `1..min(DEFAULT_PDF_PAGES, n)`). So an 18- or 11-page PDF both default to
  pages 1–10; a 5-page PDF → 1–5.
- `trimmedLength(pdf clip)` = Σ `seconds` over its pages.
- `clipValidity(pdf clip)`: invalid if `missing`, no title, or zero in-range
  pages; otherwise valid. (PDFs are always renderable, so no "unsupported
  format" reason.)
- `playablePlaylist` is unchanged in shape (it already filters on `enabled` +
  validity and sorts by `order`); PDF clips flow through it like video clips.

## Playback (`player.js`) — branch, don't rewrite

A new `#pdfCanvas` layer lives in the player container alongside `videoA/videoB`.
The sequence machinery (`start`, `_buildBlock`, `_ensureSeq`, `advance`,
`_goNext`, `_preloadNext`, failure handling, fullscreen) is unchanged. Three
existing seams get a `kind` branch, plus a few small PDF-only methods:

- `_prepare(v, baseIdx)`: if the entry is a PDF, `await pdf.loadDoc(url)` and
  resolve — no `<video>` work. (Acts as the "preload" for a PDF too.)
- `_activate(baseIdx)`: if PDF → `_activatePdf(entry)`: show the canvas layer
  (hide videos), set the title overlay, render the first listed page
  (`pages[0].page`), start the page timer.
- `_clearWatchers()`: also clears the PDF page timer.
- `_activatePdf` / `_armPdfTimer`: render the current page, `setTimeout` for that
  page's `seconds`; on fire, render the next page or hand off to `advance()`
  after the last page. Guarded by the same `activeToken` idempotency the video
  watchers use, so a stale timer can't double-advance.
- Page-count side effect: on first load the player reports `numPages` back via
  the existing `onDuration`-style callback (a parallel `onPageCount`) so the
  store/library learn the count.
- Keys (in `_onKey`, branched by active kind): **Space** pauses/resumes the page
  timer (store remaining ms, re-arm on resume); **←** restarts the clip at its
  first page; **→** advances to the next clip; **↑/↓/M** are no-ops for PDF (no
  audio). The title headline overlay behaves exactly as for video.
- A PDF that fails to load routes through the existing `_recordFailure` /
  skip-and-continue path.

## Library + authoring UI (`ui.js`, `index.html`, `styles.css`)

### Library grouping
`renderLibrary()` partitions `store.library` by entry `kind` and renders labeled
sections, each preceded by a presentational header
(`<li class="lib-section" role="presentation">` with a count), reusing `_card()`
for cards:

```
Videos (33)   → existing video cards
PDFs (2)      → PDF-only papers (PDF badge, first-page thumbnail)
⚠ Missing (N) → authored-but-absent clips (only when any; pairs with Forget-missing)
```

Headers are presentational so the `role="listbox"` options remain the cards and
the existing ↑/↓ nav (which collects `.lib-card`) is unaffected. Empty groups are
omitted. Order: Videos → PDFs → Missing.

### Card (PDF clip)
- Thumbnail: first page rendered to a small `<canvas>`, lazily via the existing
  `IntersectionObserver` pattern (parallels lazy video posters).
- Meta text: `"<selected-page-count> pages · plays <Xs>"` (the count of pages in
  the clip's list, not the PDF's total).
- Badge: `PDF` (plus the shared Missing/Needs-title/Excluded badges as
  applicable).

### Authoring pane
The pane toggles between the existing **video editor** and a new **PDF editor**
block (`#pdfEditor`) by clip kind:
- **Preview:** a `<canvas>` showing the focused page, with ‹ Prev / Next › buttons
  to page through the document while choosing.
- **Page list** (reusing the segment-row pattern): each row
  `Page P  [seconds input]  [remove]`; a **`+ Add page`** button (appends the
  next unused page, default 6 s); a readout `… of <pageCount> pages`.
- **Title** (required) and **Include in showreel** behave as for video.
- Page edits write back through `store.updateClip(name, { pages })`; the list is
  kept ascending and de-duplicated.

## Error handling

- PDF.js fails to load a document → the clip is skipped during playback via the
  existing failure path; in authoring the preview shows a small error and the
  clip is flagged invalid.
- PDF file vanishes from the folder → marked `missing` by the existing reconcile
  logic (kind preserved), shown in the Missing section.
- Page numbers out of range (PDF replaced by a shorter one) → clamped on the next
  `setPageCount`.

## Testing

- **Unit (Node `node --test`, no browser)** — extend `test/`:
  - PDF `defaultClip` builds `1..10` @ 6 s.
  - `normalizeDoc` coerces/sorts/dedupes/validates `pages` and enforces
    `MIN_PAGE_SECONDS`.
  - `setPageCount` clamps pages to the real count (18→1–10, 11→1–10, 5→1–5,
    all-out-of-range→reset).
  - `trimmedLength` and `clipValidity` for PDF clips.
- **Server test** — `listVideos()` emits `kind:'pdf'` entries for `sub1771` and
  `sub5059`, excludes PDFs that have a sibling video, and still returns the 33
  video entries.
- **Manual (user)** — PDF.js canvas rendering, fullscreen page-timing, and the
  authoring preview can't be tested headlessly (and the sandbox blocks binding
  the server socket). The data and server layers are covered by the tests above;
  the rest is a quick click-through after implementation.

## Affected files

| File | Change |
| --- | --- |
| `js/vendor/pdfjs/` | New — vendored `pdf.mjs` + `pdf.worker.mjs` |
| `js/pdf.js` | New — PDF.js wrapper (`loadDoc`, `renderPage`) |
| `server.js` | List PDF-only stems as `kind:'pdf'`; add `.pdf` MIME |
| `js/store.js` | `kind`, `pages`, `pageCount`, defaults, normalize, `setPageCount`, length/validity |
| `js/player.js` | `#pdfCanvas` layer; PDF branches in `_prepare`/`_activate`/`_clearWatchers`/keys; page timer |
| `js/ui.js` | Library grouping; PDF card; PDF authoring editor |
| `js/main.js` | New refs (`pdfCanvas`, PDF editor controls); wire `onPageCount` |
| `index.html` | `#pdfCanvas`, `#pdfEditor` block, vendored PDF.js script |
| `styles.css` | PDF canvas (player), PDF thumb, PDF editor, `.lib-section` headers |
| `test/` | PDF store tests + server listing test |
| `README.md` | Document PDF clips + the Library sections |
