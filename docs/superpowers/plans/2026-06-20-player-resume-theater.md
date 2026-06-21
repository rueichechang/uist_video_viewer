# Player Resume + Theater Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-resume playback to the exact spot across reloads, and add a second "Play with sidebar" theater view whose visible Library can be clicked to jump playback.

**Architecture:** Resume position is serialized to `localStorage` (`showreel.resume.v1`) by the store; a pure `store.resolveResume(snapshot, playlist)` maps it to a play plan that `player.start()` accepts. The player gains `getResumeSnapshot()`, save/clear callbacks, a `theater` option (skips OS fullscreen and offsets the overlay via `.player--theater`), and `jumpTo(name)`. The existing double-buffered video/PDF engine is reused, not rewritten.

**Tech Stack:** Vanilla ES-module JS, zero-dependency Node server, `node --test`.

## Global Constraints

- No npm runtime dependencies / no build step; `js/` stays ESM, `server.js` stays CommonJS; run via `node server.js` / `npm start`; tests via `node --test`.
- Resume identity is by clip **name** (stable), not index; if the active clip is no longer playable, `resolveResume` returns `null` and the caller starts fresh.
- Resume granularity: **video = exact `currentTime`**, **PDF = current page** (per-page timer restarts).
- localStorage key: `showreel.resume.v1` (mirrors the `durations`/`pageCounts` cache pattern).
- Theater offset is `left: 300px` (the Library grid column width), `left: 0` at `max-width: 900px`.
- The double-buffered video engine and all watchers must remain functionally unchanged; resume/theater are additive branches.
- Both Play buttons resume; a **↺ Start over** control (shown only when a resume snapshot exists) clears it.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Sandbox note: the server socket can't bind here and there's no browser, so player/CSS/fullscreen/click behavior is verified by `node --check` + a manual click-through; only the store layer is unit-tested.

---

## File Structure

| File | Change |
| --- | --- |
| `js/store.js` | `RESUME_KEY`; `getResume`/`setResume`/`clearResume`; pure `resolveResume(snapshot, playlist)` |
| `js/player.js` | `start()` accepts a resume `plan` + `theater`; `getResumeSnapshot()`; `jumpTo(name)`; save/clear callbacks; apply resume spot on first activation; `.player--theater` toggle |
| `index.html` | `#playSidebarBtn` + `#startOverBtn` in the appbar |
| `styles.css` | `.player--theater` positioning + narrow fallback |
| `js/main.js` | wire theater/jump/start-over; resolve + pass resume plan; flush resume on pagehide/visibility-hidden |
| `js/ui.js` | second Play button + Start-over wiring; route card clicks to jump in theater; `refreshPlayControls()` |
| `test/resume.test.mjs` | store resume roundtrip + `resolveResume` |
| `README.md` | document resume + theater + start over |

**Task order:** T1 store (tested) → T2 player resume → T3 player theater+jump → T4 html/css → T5 main+ui wiring → T6 docs+verify.

---

### Task 1: Store resume API

**Files:**
- Modify: `js/store.js`
- Test: `test/resume.test.mjs` (create)

**Interfaces:**
- Produces: `store.getResume() -> object|null`, `store.setResume(snapshot)`, `store.clearResume()`, and the pure planner `store.resolveResume(snapshot, playlist) -> {order:number[], pos:number, name, kind, segIdx, time, pageIdx, mode} | null`. `RESUME_KEY = 'showreel.resume.v1'`.

- [ ] **Step 1: Write the failing test**

Create `test/resume.test.mjs`:

```js
// resume.test.mjs — resume snapshot persistence + resolution against a playlist.
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage stub (Node has none without --localstorage-file).
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => { _ls.set(k, String(v)); },
  removeItem: (k) => { _ls.delete(k); },
};

const { store } = await import('../js/store.js');

const SNAP = {
  order: ['a.mp4', 'b.pdf', 'c.mp4'],
  name: 'b.pdf', kind: 'pdf', segIdx: 0, time: 0, pageIdx: 3,
  mode: 'sequential-once', savedAt: '2026-06-20T00:00:00.000Z',
};

test('setResume / getResume / clearResume roundtrip', () => {
  _ls.clear();
  assert.equal(store.getResume(), null);
  store.setResume(SNAP);
  assert.deepEqual(store.getResume(), SNAP);
  store.clearResume();
  assert.equal(store.getResume(), null);
});

test('getResume tolerates garbage and missing name', () => {
  _ls.clear();
  _ls.set('showreel.resume.v1', '{not json');
  assert.equal(store.getResume(), null);
  _ls.set('showreel.resume.v1', JSON.stringify({ order: [], time: 5 })); // no name
  assert.equal(store.getResume(), null);
});

test('resolveResume maps names to indices and locates the active clip', () => {
  const playlist = [
    { name: 'a.mp4' }, { name: 'b.pdf' }, { name: 'c.mp4' },
  ];
  const plan = store.resolveResume(SNAP, playlist);
  assert.deepEqual(plan.order, [0, 1, 2]);
  assert.equal(plan.pos, 1);
  assert.equal(plan.name, 'b.pdf');
  assert.equal(plan.kind, 'pdf');
  assert.equal(plan.pageIdx, 3);
  assert.equal(plan.mode, 'sequential-once');
});

test('resolveResume drops missing names from order and recomputes pos', () => {
  const playlist = [{ name: 'c.mp4' }, { name: 'b.pdf' }]; // a.mp4 gone, reordered
  const plan = store.resolveResume(SNAP, playlist);
  // order maps surviving names in snapshot order: b.pdf->1, c.mp4->0
  assert.deepEqual(plan.order, [1, 0]);
  assert.equal(plan.pos, 0); // b.pdf is first surviving
});

test('resolveResume returns null when the active clip is gone', () => {
  const playlist = [{ name: 'a.mp4' }, { name: 'c.mp4' }]; // b.pdf gone
  assert.equal(store.resolveResume(SNAP, playlist), null);
  assert.equal(store.resolveResume(SNAP, []), null);
  assert.equal(store.resolveResume(null, playlist), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/resume.test.mjs`
Expected: FAIL — `store.getResume is not a function`.

- [ ] **Step 3: Add `RESUME_KEY` constant**

In `js/store.js`, after the line `const PAGES_KEY = 'showreel.pagecounts.v1';` add:

```js
const RESUME_KEY = 'showreel.resume.v1';
```

- [ ] **Step 4: Add the resume methods**

In `js/store.js`, immediately after the `setPageCount(...)` method (end of the page-count cache section), add:

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/resume.test.mjs`
Expected: PASS (5 tests).
Run: `node --test` (full suite) — Expected: all prior tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add js/store.js test/resume.test.mjs
git commit -m "feat(store): resume snapshot persistence + resolveResume planner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Player — accept resume plan, snapshot, save/clear

**Files:**
- Modify: `js/player.js`

**Interfaces:**
- Consumes: a plan from `store.resolveResume` (Task 1) and `onSaveResume`/`onClearResume` callbacks from `init`.
- Produces: `player.start(playlist, options, plan)` (3rd arg optional); `player.getResumeSnapshot() -> snapshot|null`; the player calls `this.onSaveResume(snap)` on clip activation, pause, and manual exit, and `this.onClearResume()` on natural end.

- [ ] **Step 1: Add the save/clear callbacks in `init`**

In `js/player.js` `init(refs)`, after the line `this.onPageCount = refs.onPageCount || (() => {});` add:

```js
    this.onSaveResume = refs.onSaveResume || (() => {});
    this.onClearResume = refs.onClearResume || (() => {});
```

- [ ] **Step 2: Initialize `_resumeSpot` in `reset`**

In `js/player.js` `reset()`, after the line `this._pdfRemaining = null;` add:

```js
    this._resumeSpot = null;
```

- [ ] **Step 3: Accept a plan in `start()`**

In `js/player.js` `start(playlist, options)`, change the signature to `start(playlist, options, plan)`. Replace these lines:

```js
    this.mode = options.mode;
```
with:
```js
    this.mode = (plan && plan.mode) || options.mode;
```

Then replace:
```js
    this.sequence = this._buildBlock();
    this.pos = 0;
```
with:
```js
    if (plan && Array.isArray(plan.order) && plan.order.length) {
      this.sequence = plan.order.slice();
      this.pos = clamp(plan.pos || 0, 0, this.sequence.length - 1);
      this._resumeSpot = { kind: plan.kind, segIdx: plan.segIdx, time: plan.time, pageIdx: plan.pageIdx };
    } else {
      this.sequence = this._buildBlock();
      this.pos = 0;
      this._resumeSpot = null;
    }
```

Then replace:
```js
    const first = this.sequence[0];
```
with:
```js
    const first = this.sequence[this.pos];
```

- [ ] **Step 4: Apply the resume spot + save on video activation**

In `js/player.js` `_activate(baseIdx)`, replace this block:

```js
    this._segs = this._segments(clip, dur);
    this._segIdx = 0;
    const seg0 = this._segs[0];
    const inP = seg0.inP;
    const outP = seg0.outP;
```
with:
```js
    this._segs = this._segments(clip, dur);
    this._segIdx = 0;
    // Resume: jump to the saved segment + timestamp on the FIRST activation only.
    let startAt = null;
    if (this._resumeSpot && this._resumeSpot.kind === 'video') {
      this._segIdx = clamp(this._resumeSpot.segIdx || 0, 0, this._segs.length - 1);
      const rs = this._segs[this._segIdx];
      const hi = rs.outP != null ? rs.outP - EPS : (dur != null ? dur : (this._resumeSpot.time || 0));
      startAt = clamp(this._resumeSpot.time || 0, rs.inP, Math.max(rs.inP, hi));
    }
    this._resumeSpot = null;
    const seg0 = this._segs[this._segIdx];
    const inP = seg0.inP;
    const outP = seg0.outP;
```

Then in the same method, replace:
```js
    this._updateProgress();
    this._playActive(v);
    this._armWatchers(v, clip, inP, outP);
  }
```
with:
```js
    this._updateProgress();
    if (startAt != null) { try { v.currentTime = startAt; } catch (_) { /* */ } }
    this._playActive(v);
    this._armWatchers(v, clip, inP, outP);
    this.onSaveResume(this.getResumeSnapshot());
  }
```

- [ ] **Step 5: Apply the resume spot + save on PDF activation**

In `js/player.js` `_activatePdf(baseIdx)`, replace:

```js
    this._pdfIdx = 0;
    this._pdfPaused = false;
    this._pdfRemaining = null;
    this._updateProgress();
```
with:
```js
    this._pdfIdx = 0;
    if (this._resumeSpot && this._resumeSpot.kind === 'pdf') {
      this._pdfIdx = clamp(this._resumeSpot.pageIdx || 0, 0, this._pdfPages.length - 1);
    }
    this._resumeSpot = null;
    this._pdfPaused = false;
    this._pdfRemaining = null;
    this._updateProgress();
    this.onSaveResume(this.getResumeSnapshot());
```

- [ ] **Step 6: Save on pause**

In `js/player.js` `_onKey`, in the `case ' ': case 'Spacebar':` body, the PDF branch and the video branch. Replace the PDF pause/resume block:

```js
        if (this._activeClip && this._activeClip.kind === 'pdf') {
          if (this._pdfPaused) {
            this._pdfPaused = false;
            this._armPdfTimer(this._pdfRemaining != null ? this._pdfRemaining : this._pdfPages[this._pdfIdx].seconds * 1000, this.activeToken);
          } else {
            this._pdfPaused = true;
            clearTimeout(this._pdfTimer); this._pdfTimer = null;
            this._pdfRemaining = Math.max(0, this._pdfArmedMs - (performance.now() - this._pdfArmedAt));
            this.onSaveResume(this.getResumeSnapshot());
          }
          break;
        }
        if (v.paused) { v.play().catch(() => {}); this._armOutTimer(v, this._outP); }
        else { v.pause(); clearTimeout(this._outTimer); this._outTimer = null; this.onSaveResume(this.getResumeSnapshot()); }
        break;
```

(That adds one `this.onSaveResume(...)` call inside the PDF-pause branch and one inside the video-pause branch — the resume branches are unchanged. Replace the whole Space case body to match exactly.)

- [ ] **Step 7: Save on manual exit / clear on natural end**

In `js/player.js` `finish(reason)`, immediately after the guard line `if (this._finished) return;` add:

```js
    if (reason === 'end' || reason === 'all-failed') this.onClearResume();
    else this.onSaveResume(this.getResumeSnapshot()); // capture exact spot before teardown
```

- [ ] **Step 8: Add `getResumeSnapshot()`**

In `js/player.js`, add this method right after `finish(reason) { … }` (before `requestStop`):

```js
  /** Snapshot of the current position for resume (or null when not playable). */
  getResumeSnapshot() {
    if (!this.base || !this.base.length) return null;
    const n = this.base.length;
    const cycleStart = this.pos - (this.pos % n);
    const order = [];
    for (let i = cycleStart; i < cycleStart + n && i < this.sequence.length; i++) {
      const e = this.base[this.sequence[i]];
      if (e) order.push(e.name);
    }
    const active = this.base[this.sequence[this.pos]];
    if (!active) return null;
    const isPdf = active.clip.kind === 'pdf';
    const v = this.videos[this.activeIdx];
    return {
      order,
      name: active.name,
      kind: isPdf ? 'pdf' : 'video',
      segIdx: isPdf ? 0 : (this._segIdx || 0),
      time: isPdf ? 0 : (Number.isFinite(v.currentTime) ? v.currentTime : 0),
      pageIdx: isPdf ? (this._pdfIdx || 0) : 0,
      mode: this.mode,
      savedAt: new Date().toISOString(),
    };
  }
```

- [ ] **Step 9: Verify**

Run: `node --check js/player.js` → no output.
Run: `node --test` → still all green (this task adds no tests; it must not break existing ones).

- [ ] **Step 10: Manual verification (user)**

`npm start`; play, advance a couple of clips, scrub into a clip, `Esc`; press Play → resumes the same clip near the same spot. Reload the page, press Play → still resumes (localStorage). Let a `sequential-once` reel finish → next Play starts fresh.

- [ ] **Step 11: Commit**

```bash
git add js/player.js
git commit -m "feat(player): auto-resume to the saved clip + spot via a resume plan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Player — theater mode + jumpTo

**Files:**
- Modify: `js/player.js`

**Interfaces:**
- Produces: `start()` honors `options.theater` (skips OS fullscreen, adds `.player--theater`); `player.theater` boolean; `player.jumpTo(name)` switches playback to a named clip.

- [ ] **Step 1: Theater state in `reset`**

In `js/player.js` `reset()`, after the line `if (this.pdfCanvas) this.pdfCanvas.classList.remove('is-active');` add:

```js
    this.theater = false;
    this.container.classList.remove('player--theater');
```

- [ ] **Step 2: Honor `options.theater` in `start()`**

In `js/player.js` `start()`, after the line `this.volume = 1;` add:

```js
    this.theater = !!options.theater;
```

Then replace:
```js
    this._requestFs(); // must be synchronous within the gesture
```
with:
```js
    if (this.theater) this.container.classList.add('player--theater');
    else this._requestFs(); // must be synchronous within the gesture
```

- [ ] **Step 3: Remove the class in `finish`**

In `js/player.js` `finish(reason)`, after the line `if (this.pdfCanvas) this.pdfCanvas.classList.remove('is-active');` add:

```js
    this.container.classList.remove('player--theater');
```

- [ ] **Step 4: Don't request OS fullscreen from `F` in theater**

In `js/player.js` `_onKey`, replace the `f`/`F` case:

```js
      case 'f': case 'F':
        e.preventDefault();
        if (!(document.fullscreenElement || document.webkitFullscreenElement)) this._requestFs();
        break;
```
with:
```js
      case 'f': case 'F':
        e.preventDefault();
        if (!this.theater && !(document.fullscreenElement || document.webkitFullscreenElement)) this._requestFs();
        break;
```

- [ ] **Step 5: Add `jumpTo(name)`**

In `js/player.js`, add this method right after `requestStop() { … }`:

```js
  /** Theater: jump playback to a specific clip (clicked in the visible sidebar). */
  jumpTo(name) {
    if (!this.running || this.transitionInProgress) return;
    const baseIdx = this.base.findIndex((e) => e.name === name);
    if (baseIdx < 0 || this.failedBase.has(baseIdx)) return;
    // Find it in the sequence at/after pos, else anywhere, else insert after pos.
    let p = this.sequence.indexOf(baseIdx, this.pos);
    if (p < 0) p = this.sequence.indexOf(baseIdx);
    if (p < 0) { this.sequence.splice(this.pos + 1, 0, baseIdx); p = this.pos + 1; }
    this.transitionInProgress = true;
    this._clearWatchers();
    const standby = this.videos[1 - this.activeIdx];
    this._prepare(standby, baseIdx)
      .then(() => {
        if (!this.running) return;
        this.pos = p;
        this.activeIdx = 1 - this.activeIdx;
        this._activate(baseIdx);
        this.transitionInProgress = false;
        this._preloadNext();
      })
      .catch((e) => {
        this.failedBase.add(baseIdx);
        this._recordFailure(baseIdx, e);
        this.transitionInProgress = false;
      });
  }
```

- [ ] **Step 6: Verify**

Run: `node --check js/player.js` → no output.
Run: `node --test` → still all green.

- [ ] **Step 7: Manual verification (user)** *(full check after Task 5 wires the buttons)*

After Task 5: "▶ Play with sidebar" plays with the Library visible on the left; `Esc` exits; clicking a Library card jumps playback to it.

- [ ] **Step 8: Commit**

```bash
git add js/player.js
git commit -m "feat(player): theater mode (sidebar visible) + jumpTo(name)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: HTML + CSS for the new controls and theater layout

**Files:**
- Modify: `index.html` (appbar actions)
- Modify: `styles.css`

**Interfaces:**
- Produces: `#playSidebarBtn`, `#startOverBtn` (in the appbar), and the `.player--theater` rule consumed by `player.start()` (Task 3) and the refs in `main.js`/`ui.js` (Task 5).

- [ ] **Step 1: Add the buttons**

In `index.html`, inside `<div class="appbar__actions">`, replace:

```html
        <span id="sessionSummary" class="appbar__summary" aria-live="polite"></span>
        <button id="playBtn" class="btn btn--primary" type="button" disabled
                aria-describedby="playBlockers">
          ▶ Play fullscreen
        </button>
```
with:
```html
        <span id="sessionSummary" class="appbar__summary" aria-live="polite"></span>
        <button id="startOverBtn" class="btn btn--ghost btn--sm" type="button" hidden
                aria-label="Forget the resume point and start the showreel over">↺ Start over</button>
        <button id="playSidebarBtn" class="btn" type="button" disabled
                aria-describedby="playBlockers">▶ Play with sidebar</button>
        <button id="playBtn" class="btn btn--primary" type="button" disabled
                aria-describedby="playBlockers">
          ▶ Play fullscreen
        </button>
```

- [ ] **Step 2: Add the theater CSS**

In `styles.css`, immediately after the `.player { … }` rule (the `position: fixed; inset: 0; z-index: 100` block), add:

```css
/* Theater mode: keep the 300px Library column visible on the left. */
.player--theater { left: 300px; }
@media (max-width: 900px) { .player--theater { left: 0; } }
```

- [ ] **Step 3: Verify**

Run:
```bash
grep -c "playSidebarBtn\|startOverBtn" index.html   # expect 2
grep -c "player--theater" styles.css                # expect 2
```
Expected: `2` and `2`.

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "feat(ui): add Play-with-sidebar + Start-over buttons and theater CSS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire main.js + ui.js (resume, theater, jump, start-over)

**Files:**
- Modify: `js/main.js`
- Modify: `js/ui.js`

**Interfaces:**
- Consumes: `store.getResume/setResume/clearResume/resolveResume` (T1); `player.start(playlist, options, plan)`, `player.getResumeSnapshot()`, `player.jumpTo(name)`, `player.running`, `player.theater` (T2/T3); refs `#playSidebarBtn`/`#startOverBtn` (T4).
- Produces: both Play buttons resume; theater Play; card-click jump in theater; Start-over clears resume; resume flushes on reload.

- [ ] **Step 1: Add refs in `main.js`**

In `js/main.js`, in the `refs` object under `// shell / appbar` (after `reloadBtn: byId('reloadBtn'),`) add:

```js
  playSidebarBtn: byId('playSidebarBtn'),
  startOverBtn: byId('startOverBtn'),
```

- [ ] **Step 2: Resume-aware `startPlayback` in `main.js`**

In `js/main.js`, replace the `startPlayback` function:

```js
function startPlayback() {
  const playlist = ui.buildPlaylist();
  if (!playlist.length) return;
  // Synchronous within the click gesture so fullscreen is granted.
  player.start(playlist, { ...store.options });
}
```
with:
```js
function startPlayback(theater) {
  const playlist = ui.buildPlaylist();
  if (!playlist.length) return;
  const snap = store.getResume();
  const plan = snap ? store.resolveResume(snap, playlist) : null;
  if (snap && !plan) ui.toast('Couldn’t resume — starting over.', 'warn');
  // Synchronous within the click gesture so fullscreen is granted.
  player.start(playlist, { ...store.options, theater: !!theater }, plan);
}
```

- [ ] **Step 3: Wire player save/clear + onStop refresh in `main.js`**

In `js/main.js` `player.init({ … })`, after the `onPageCount` handler add:

```js
    onSaveResume: (snap) => store.setResume(snap),
    onClearResume: () => store.clearResume(),
```

In the same `player.init`, replace the `onStop` handler:
```js
    onStop: (summary) => { ui.showSummary(summary); refs.playBtn.focus(); },
```
with:
```js
    onStop: (summary) => { ui.showSummary(summary); ui.refreshPlayControls(); refs.playBtn.focus(); },
```

- [ ] **Step 4: Pass handlers into `ui.init` in `main.js`**

In `js/main.js`, replace:
```js
  ui.init(refs, { onPlay: startPlayback, onReload: loadLibrary });
```
with:
```js
  ui.init(refs, {
    onPlay: () => startPlayback(false),
    onPlayTheater: () => startPlayback(true),
    onReload: loadLibrary,
    onJump: (name) => {
      if (player.running && player.theater) { player.jumpTo(name); return true; }
      return false;
    },
    onStartOver: () => { store.clearResume(); ui.refreshPlayControls(); },
  });
  ui.refreshPlayControls();
```

- [ ] **Step 5: Flush resume on reload in `main.js`**

In `js/main.js`, replace:
```js
  const flushNow = () => store.flush();
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flush();
  });
```
with:
```js
  const flushNow = () => {
    store.flush();
    if (player.running) store.setResume(player.getResumeSnapshot());
  };
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
```

- [ ] **Step 6: Capture the new handlers in `ui.init`**

In `js/ui.js` `init(refs, handlers)`, replace:
```js
    this.onPlay = handlers.onPlay;
    this.onReload = handlers.onReload;
```
with:
```js
    this.onPlay = handlers.onPlay;
    this.onPlayTheater = handlers.onPlayTheater;
    this.onReload = handlers.onReload;
    this.onJump = handlers.onJump;
    this.onStartOver = handlers.onStartOver;
```

Then, in the same method, after the line `this.r.playBtn.addEventListener('click', () => this.onPlay());` add:

```js
    this.r.playSidebarBtn?.addEventListener('click', () => this.onPlayTheater && this.onPlayTheater());
    this.r.startOverBtn?.addEventListener('click', () => this.onStartOver && this.onStartOver());
```

- [ ] **Step 7: Route card clicks to jump in theater (`ui.js`)**

In `js/ui.js` `_card(name, sv)`, replace:
```js
    card.addEventListener('click', () => this.select(name));
```
with:
```js
    card.addEventListener('click', () => {
      if (this.onJump && this.onJump(name)) return; // theater: jump playback
      this.select(name);
    });
```

- [ ] **Step 8: Add `refreshPlayControls` + disable both buttons (`ui.js`)**

In `js/ui.js`, replace the `updatePlayState()` method's opening:
```js
  updatePlayState() {
    const playlist = this.buildPlaylist();
    const ready = playlist.length > 0;
    this.r.playBtn.disabled = !ready;
```
with:
```js
  updatePlayState() {
    const playlist = this.buildPlaylist();
    const ready = playlist.length > 0;
    this.r.playBtn.disabled = !ready;
    if (this.r.playSidebarBtn) this.r.playSidebarBtn.disabled = !ready;
    this.refreshPlayControls();
```

Then add this method right after `updatePlayState()`:
```js
  /** Show the Start-over control only when a resume snapshot exists. */
  refreshPlayControls() {
    if (this.r.startOverBtn) this.r.startOverBtn.hidden = !store.getResume();
  }
```

- [ ] **Step 9: Verify**

Run: `node --check js/main.js && node --check js/ui.js` → no output.
Run: `node --test` → still all green.

- [ ] **Step 10: Manual verification (user)**

`npm start`: both Play buttons enabled when there's a playlist. "▶ Play with sidebar" keeps the Library visible; clicking a Library card jumps playback. After exiting mid-reel, **↺ Start over** appears; clicking it makes the next Play start fresh and hides itself.

- [ ] **Step 11: Commit**

```bash
git add js/main.js js/ui.js
git commit -m "feat(ui): wire theater Play, sidebar jump, resume flush, Start over

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Documentation + full verification pass

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the features**

In `README.md`, in the "## The four pieces" / "▶ Play fullscreen" area, replace the line:
```markdown
4. **▶ Play fullscreen** (top right) — runs the showreel.
```
with:
```markdown
4. **▶ Play fullscreen** (top right) — runs the showreel in true fullscreen.
   **▶ Play with sidebar** runs it in an in-app theater view that keeps the
   Library visible on the left; click any Library card to jump playback to it.
   Both buttons **resume** from where you last left off (the exact video time /
   PDF page, saved across reloads); **↺ Start over** clears that resume point.
```

- [ ] **Step 2: Run the full automated suite**

Run: `npm test`
Expected: all tests PASS (resume + the existing suites).

- [ ] **Step 3: Syntax-check every module**

Run:
```bash
for f in js/store.js js/ui.js js/main.js js/util.js js/player.js js/pdf.js server.js; do node --check "$f" && echo "ok: $f"; done
```
Expected: `ok:` for every file.

- [ ] **Step 4: Manual end-to-end (user)**

`npm start`: resume after Esc-and-replay and after a full reload (video timestamp + PDF page); ↺ Start over; theater layout keeps the Library visible and fills the rest; clicking a Library card jumps playback in theater; Esc exits theater; true-fullscreen Play still works; a `sequential-once` reel that finishes naturally starts fresh next time.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document resume + Play-with-sidebar (theater) + Start over

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Resume snapshot shape + persistence → Task 1 (`getResume/setResume/clearResume`). ✓
- Name-based resolution + fall-back-to-fresh → Task 1 (`resolveResume`). ✓
- Restore on Play (order/pos/spot, mode) → Task 2 (`start(plan)`, `_activate`/`_activatePdf` spot). ✓
- Save points (activate, pause, exit) + clear on natural end → Task 2; reload flush → Task 5. ✓
- Exact video time / PDF page granularity → Task 2 (`startAt` seek; `_pdfIdx`). ✓
- Second Play button + theater overlay (no OS FS, `.player--theater`, narrow fallback) → Tasks 3, 4. ✓
- Interactive jump → Task 3 (`jumpTo`) + Task 5 (card-click routing). ✓
- Start-over control (visible only when resumable) → Tasks 4, 5 (`refreshPlayControls`). ✓
- Both Play buttons disabled together → Task 5. ✓
- Theater exit via Esc; `F` disabled in theater → Task 3. ✓
- Docs → Task 6.

**Placeholder scan:** none — every code step is complete; manual steps are explicitly labeled (browser/canvas/fullscreen aren't headlessly testable here).

**Type/name consistency (checked):** snapshot fields `order/name/kind/segIdx/time/pageIdx/mode` match across `setResume`, `resolveResume`, `getResumeSnapshot`, and `start`'s `_resumeSpot`. `player.start(playlist, options, plan)`, `player.theater`, `player.running`, `player.jumpTo`, `player.getResumeSnapshot`, `onSaveResume`/`onClearResume`, `refreshPlayControls`, `onPlayTheater`/`onJump`/`onStartOver`, `#playSidebarBtn`/`#startOverBtn`, and `.player--theater` are used identically across store, player, ui, main, html, and css.

**TDD note:** Task 1 (store) is test-first against `node --test`. Tasks 2–5 are browser/DOM/fullscreen/canvas behavior that can't run headlessly here (and the server socket is sandbox-blocked), so each pairs `node --check` + `node --test` (no regressions) with an explicit manual click-through — the honest maximum of automated coverage for those layers.
