# Showreel (for UIST 2026 PC Meeting)

A small, **purely-web** showreel / digital-signage tool. Browse the clips in
a folder, trim each one and give it a title, choose how the playlist should run,
and play it back full-screen with the title pinned as a headline at the top.

No build step and no dependencies — vanilla HTML/CSS/JS plus a tiny zero-dependency
Node server whose only job is to list the `videos/` folder and stream files with
HTTP range support (which the browser needs to seek and to play trimmed clips —
Safari in particular refuses to play a video that isn't served with `206 Partial
Content`).

## Run it

You only need [Node.js](https://nodejs.org) (any recent version). There are **no
packages to install** — the server has zero dependencies, so skip `npm install`
and just run:

```bash
node server.js            # then open http://127.0.0.1:5173
# or
npm start
```

Put your video files in the [`videos/`](videos/) folder (`.mp4`, `.m4v`, `.mov`,
`.webm`, `.ogv`), then click **⟳ Rescan** (or reload). Files are matched by name,
so you can drop new clips in at any time.

> Want it reachable from another machine? `HOST=0.0.0.0 PORT=8080 node server.js`.

## The four pieces

1. **Library** (left) — every video in `videos/`, with its configured start → end
   and the length it will actually play. Badges flag clips that need a title, are
   excluded, are missing, or use an unsupported format.
2. **Authoring** (centre) — for the selected clip: a **Title** (required), and an
   **in / out trim** you set with the dual-handle slider, by typing seconds
   (`12.5` or `1:23.4`), or with **Set** to grab the preview's current frame. Use
   **+ Add segment** to give one clip several start/end ranges — they play in
   order, back-to-back, before the showreel advances to the next clip.
3. **Options** (right) — playback mode, a toggle for the title headline,
   start-muted, and JSON **Export / Import** of your whole configuration.
4. **▶ Play fullscreen** (top right) — runs the showreel.

### Playback modes

| Mode | Behaviour |
| --- | --- |
| **Sequential, loop** | In `order`, repeats forever. |
| **Sequential, once** | In order, stops at the end. |
| **Shuffle, once** | Random order, **each clip exactly once** this session, then stops. |
| **Shuffle, loop** | Reshuffles every cycle; guarantees no clip repeats across the seam. |

Each press of **Play** is a fresh session (a new shuffle). The title stays pinned
as a headline at the top for the whole of *every* clip, including loop repeats.

### Keyboard (during playback)

`Esc` exit · `Space` pause/resume · `→` next clip · `←` restart clip ·
`↑`/`↓` volume · `M` mute · `F` re-enter fullscreen.

## Notes & limits

- **Where data lives:** titles, trims (one or more start/end segments per clip)
  and options are saved in your browser's `localStorage` (with a `.bak` copy),
  written after every edit and flushed when the tab closes. Use **Export** to
  move a setup between machines or back it up. Authoring data for a file that
  disappears is *kept* and flagged "Missing", not deleted.
- **Durations & thumbnails** come from the browser (there's no `ffmpeg`), so the
  library shows "Loading metadata…" briefly on first scan, then caches the result.
- **Trimming is to the nearest decodable frame** (no re-encoding), so the start
  point may land a few frames off on long-GOP video.
- Audio starts **muted** (so autoplay always works); press `M` or use the
  "tap for sound" prompt to enable it.

## Files

| File | Role |
| --- | --- |
| [server.js](server.js) | Static + `/api/videos` server with Range/304/traversal handling |
| [index.html](index.html) | App shell, player overlay, modals |
| [styles.css](styles.css) | All styling |
| [js/util.js](js/util.js) | Pure helpers (time formatting, shuffle, …) |
| [js/store.js](js/store.js) | Config document, persistence, reconciliation, export/import |
| [js/ui.js](js/ui.js) | Library / authoring / options rendering + input |
| [js/player.js](js/player.js) | Double-buffered fullscreen playback engine |
| [js/main.js](js/main.js) | Wiring + bootstrap |
