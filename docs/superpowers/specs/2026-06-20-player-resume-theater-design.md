# Player resume + theater (sidebar) mode — design

- **Date:** 2026-06-20
- **Status:** Approved (design), pending implementation plan
- **App:** Showreel (UIST 2026 PC meeting tool) — vanilla HTML/CSS/JS + zero-dependency Node server
- **Branch:** `player-resume-theater`

## Problem

Two playback-UX gaps:

1. **No resume.** Each press of Play calls `player.reset()` and starts a fresh
   session from the first clip (a new shuffle). If you exit the fullscreen player
   to tweak something and play again — or reload the page — you lose your place.
2. **Fullscreen hides everything.** The player is a fixed overlay (`inset:0;
   z-index:100`) that uses the OS Fullscreen API, so the Library sidebar is
   covered. There's no way to keep the Library visible while the reel plays.

## Goals

1. **Auto-resume to the exact spot, across reloads.** Pressing Play (either
   button) continues from the exact clip and position you left off — the same
   timestamp in a video, the same page in a PDF — preserving the session's play
   order. The position persists in `localStorage` so it survives a full page
   reload. A **↺ Start over** control lets you deliberately restart.
2. **Theater mode with a visible, interactive sidebar.** A second play button
   plays the reel in an in-app "theater" view that fills everything except the
   Library column, which stays visible. Clicking a Library card during theater
   playback jumps playback to that clip.

## Non-goals (v1)

Mid-PDF-page resume (page-level only); resuming at the nearest surviving clip
when the exact clip is gone (fall back to a fresh start instead); remembering
theater-vs-fullscreen choice across sessions; relabeling Play→Resume; drag
reordering.

## Key decisions

1. **Resume granularity:** video resumes at the exact `currentTime`; PDF resumes
   at the current **page** (the per-page timer restarts). Page-level is "exact
   spot" for a slideshow.
2. **Persistence:** a new `localStorage` key `showreel.resume.v1`, mirroring the
   existing `durations`/`pageCounts` cache pattern. Resume survives reload.
3. **Identity by name, not index.** The persisted order and active clip are
   stored as clip **names** (the stable identity), so a snapshot still resolves
   after a reload or a playlist change. If the active clip is no longer playable,
   resume falls back to a fresh start.
4. **Theater reuses the existing `#player` overlay** with a `.player--theater`
   class (offset `left: 300px`, no OS fullscreen) — not a second player. The
   careful double-buffered engine and all watchers are unchanged.
5. **Resume serialization + validation lives in `store.js`** (unit-testable);
   the player only produces and consumes a snapshot.

## Part 1 — Auto-resume

### Persisted snapshot (`showreel.resume.v1`)

```
{
  order:     string[],   // the current cycle's play order, as clip NAMES
  name:      string,     // the active clip's name
  kind:      'video'|'pdf',
  segIdx:    number,     // video: active segment index (0 if single-segment)
  time:      number,     // video: currentTime (seconds) within the clip
  pageIdx:   number,     // pdf: active page index within clip.pages
  mode:      string,     // session playback mode (for loop/shuffle continuation)
  savedAt:   string      // ISO timestamp (debug/staleness only)
}
```

`order` holds the names of the current cycle's sequence block (length = playlist
size for that cycle); `time`/`segIdx` apply to a video, `pageIdx` to a PDF.

### Store API (testable)

- `store.getResume()` → parsed snapshot or `null` (tolerant of bad JSON).
- `store.setResume(snapshot)` → JSON-write to `showreel.resume.v1`.
- `store.clearResume()` → remove the key.
- `store.resolveResume(snapshot, playlist)` → **pure** planner. Given a snapshot
  and the current playlist (`[{name, clip, server}, …]`), returns a restorable
  plan or `null`:
  - map `snapshot.order` names → indices in `playlist`, dropping names not
    present/playable (preserving order);
  - locate the active clip (`snapshot.name`) in the filtered order; if absent →
    return `null` (caller starts fresh);
  - return `{ order: number[], pos: number, name, kind, segIdx, time, pageIdx, mode }`
    where `pos` is the active clip's index in the filtered `order`.

### Restore flow

`main.js` builds the playlist (`ui.buildPlaylist()`), then:
`const plan = snapshot ? store.resolveResume(snapshot, playlist) : null;`
and calls `player.start(playlist, options, plan)`.

`player.start(playlist, options, plan)`:
- `reset()`, `this.base = playlist`.
- `this.mode = (plan && plan.mode) || options.mode`.
- If `plan`: `this.sequence = plan.order; this.pos = plan.pos;` and stash
  `this._resumeSpot = { kind, segIdx, time, pageIdx }`. Else: `this.sequence =
  this._buildBlock(); this.pos = 0;`.
- Prepare and activate `this.sequence[this.pos]` (today it hardcodes
  `sequence[0]` — generalize to `[this.pos]`).
- On the **first** activation, apply `_resumeSpot`, then clear it:
  - video: set `_segIdx` to `segIdx` (clamped to the clip's segments), and seek
    the active video to `clamp(time, inP, outP)` instead of the segment IN;
  - pdf: set `_pdfIdx` to `pageIdx` (clamped to `_pdfPages.length`).
- All subsequent advancement is unchanged.

### Save / clear hooks

The player gets two callbacks from `init` (wired in `main.js`): `onSaveResume(snap)`
and `onClearResume()`.
- **Save** (`onSaveResume(this.getResumeSnapshot())`): on each clip activation
  (clip boundary, `time` = clip start), on pause, and on manual exit
  (`requestStop`/`finish('exit')`/`finish('fullscreen-exit')`).
- **Clear** (`onClearResume()`): on natural end (`finish('end')`/`finish('all-failed')`)
  so the next Play is fresh.
- `main.js` also flushes `store.setResume(player.getResumeSnapshot())` on
  `pagehide` and `visibilitychange→hidden` **when `player.running`**, reusing the
  existing flush hooks, so the exact mid-clip spot survives a reload.

`player.getResumeSnapshot()` returns the snapshot above: `order` = the current
cycle's block (`sequence` indices `[cycleStart … cycleStart+n)` mapped to names,
where `cycleStart = pos − (pos % n)`), `name` = active clip, `kind`, `segIdx` =
`_segIdx`, `time` = active video `currentTime` (0 for pdf), `pageIdx` = `_pdfIdx`
(0 for video), `mode`.

### Start-over affordance

A **↺ Start over** button in the appbar, shown only when `store.getResume()`
returns non-null. Clicking it calls `store.clearResume()` and refreshes the
control's visibility; the next Play then starts fresh. Visibility is refreshed in
`ui.updatePlayState()` (already called on every relevant change) and after
playback ends.

## Part 2 — Theater mode

### Buttons

Keep **▶ Play fullscreen** (`#playBtn`, true OS fullscreen — unchanged). Add
**▶ Play with sidebar** (`#playSidebarBtn`) in the appbar actions. Both are
disabled together when the playlist is empty (same `updatePlayState` gate).

### Playback view

`player.start(playlist, options, plan)` reads `options.theater`:
- `this.theater = !!options.theater`.
- In the fullscreen step: if `theater`, **skip** `_requestFs()` and instead
  `this.container.classList.add('player--theater')`; otherwise behave as today.
- `reset()` and `finish()` remove `player--theater`.

CSS:
```css
.player--theater { left: 300px; }                 /* Library column stays visible */
@media (max-width: 900px) { .player--theater { left: 0; } }  /* grid collapsed → full */
```
(The Library column is the 300px first grid track; offsetting the overlay's left
edge by 300px leaves it visible.)

### Interactive jump

While theater playback is running, clicking a Library card jumps playback to that
clip. `ui` receives an `onJump(name)` handler (wired in `main.js`):
`(name) => { if (player.running && player.theater) { player.jumpTo(name); return true; } return false; }`.
In `_card`'s click handler: `if (this.onJump && this.onJump(name)) return;` before
the normal `this.select(name)` — so outside theater playback, clicks still select
for authoring.

`player.jumpTo(name)`:
- find `baseIdx = this.base.findIndex(e => e.name === name)`; ignore if `< 0` or
  in `failedBase`;
- locate it in `this.sequence` at/after `pos` (`indexOf(baseIdx, pos)`), else
  anywhere (`indexOf(baseIdx)`), else append it after `pos`;
- `_clearWatchers()`, `transitionInProgress = true`, prepare it on the standby
  element, then activate it and set `pos` to its sequence index (a focused
  variant of `_goNext` targeting a chosen index). Continue normally afterward.

### Exit / keys in theater

Theater never enters OS fullscreen (`usedFullscreen` stays false), so the
`fullscreenchange` watcher won't fire `finish`. `Esc`/`✕` → `requestStop()` →
(no `fullscreenElement`) → `finish('exit')`. `F` (re-enter fullscreen) is a
no-op in theater. `Space`/`←`/`→`, volume/mute, and PDF page controls are
unchanged.

## Error handling

- Resume snapshot unreadable/invalid JSON → `getResume()` returns `null` → fresh
  start.
- Active clip missing/disabled in the current playlist → `resolveResume` returns
  `null` → fresh start (with a brief "Couldn't resume — starting over" toast).
- `jumpTo` for a clip not in the playlist → ignored (no crash).
- A clip that fails to load during resume/jump routes through the existing
  `_recordFailure`/skip path.

## Affected files

| File | Change |
| --- | --- |
| `js/store.js` | `RESUME_KEY`; `getResume`/`setResume`/`clearResume`; pure `resolveResume(snapshot, playlist)` |
| `js/player.js` | `start()` accepts a resume plan + `theater` option; `getResumeSnapshot()`; `jumpTo(name)`; save/clear callbacks; apply resume spot on first activation; remove/add `player--theater` |
| `js/ui.js` | second Play button + Start-over wiring; `onJump` routing in card click; refresh Start-over visibility in `updatePlayState` |
| `index.html` | `#playSidebarBtn` + `#startOverBtn` in the appbar |
| `styles.css` | `.player--theater` positioning + narrow-screen fallback; Start-over button styling if needed |
| `js/main.js` | wire `onPlayTheater`, `onJump`, `onSaveResume`/`onClearResume`; resolve + pass resume plan into `start()`; flush resume on pagehide/visibility-hidden |
| `test/` | store resume tests (roundtrip + `resolveResume` mapping/fallback) |
| `README.md` | document resume + theater mode + Start over |

## Testing

- **Unit (Node `node --test`):** `getResume`/`setResume`/`clearResume` roundtrip
  (with a `localStorage` stub) and `resolveResume` — active present → correct
  plan (order mapped, pos located); active missing → `null`; missing names
  filtered out of `order`; empty/garbage snapshot → `null`.
- **Manual (user):** resume after Esc-and-replay and after a full reload (video
  timestamp + PDF page); ↺ Start over; theater layout keeps the Library visible
  and fills the rest; clicking a Library card jumps playback in theater; Esc
  exits theater; true-fullscreen Play still works. Player/CSS/fullscreen/click
  behavior isn't headlessly testable here (sandbox blocks the server socket; no
  browser), so this is a click-through, with `node --check` + the store tests
  covering the rest.
