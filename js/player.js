// player.js — the fullscreen showreel playback engine.
//
// Key correctness points (see design notes):
//   * Double-buffer (videoA/videoB): the next clip is fully prepared (loaded,
//     duration-resolved, seeked to IN, first frame decoded) on the standby
//     element while the current clip plays, so transitions have no black gap.
//   * OUT is cut frame-accurately via requestVideoFrameCallback(mediaTime),
//     with a setTimeout fallback (for backgrounded tabs) and the native `ended`
//     event as a backstop — all funnelled through one idempotent advance().
//   * Title overlay timing is driven off media time (currentTime - IN), never
//     a wall-clock timer, so buffering/pausing can't desync it.
//   * Plays with the user's chosen sound setting; if the browser blocks
//     autoplay-with-sound it degrades to muted playback so the video never
//     freezes on a paused frame.
//   * fullscreenchange is the SOLE authority for "stopped" on Esc, so the app's
//     own key handler never races the browser's auto-exit.

import { MIN_CLIP, clamp, shuffle } from './util.js';

const EPS = 0.02;          // ~half a frame at 30fps
const PREP_TIMEOUT = 15000;
const HINT_HIDE_MS = 2600;

const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

function mediaErrReason(v) {
  const e = v.error;
  if (!e) return 'load error';
  switch (e.code) {
    case 1: return 'aborted';
    case 2: return 'network error';
    case 3: return 'decode error';
    case 4: return 'unsupported / missing file';
    default: return 'load error';
  }
}

class Player {
  init(refs) {
    this.container = refs.container;
    this.videos = [refs.videoA, refs.videoB];
    this.titleEl = refs.titleOverlay;
    this.noticeEl = this.container.querySelector('#playerNotice');
    this.progressEl = refs.clipProgress;
    this.hintEl = refs.controlHint;
    this.exitBtn = refs.exitBtn;
    this.shell = refs.shell;
    this.onStop = refs.onStop || (() => {});
    this.onToast = refs.onToast || (() => {});
    this.onAnnounce = refs.onAnnounce || (() => {});
    this.onDuration = refs.onDuration || (() => {});

    this._finished = true;
    this.running = false;
    this.activeIdx = 0;

    this.exitBtn.addEventListener('click', () => this.requestStop());
    this.container.addEventListener('mousemove', () => this._showHint());
  }

  reset() {
    this._finished = false;
    this.running = false;
    this.base = [];
    this.sequence = [];
    this.pos = 0;
    this.transitionInProgress = false;
    this.failed = [];
    this.failedBase = new Set();
    this.playedOk = 0;
    this.activeToken = 0;
    this._rvfcHandle = null;
    this._rvfcVideo = null;
    this._outTimer = null;
    this._onEnded = null;
    this._onTU = null;
    this._preload = null;
    this._inP = 0;
    this._outP = null;
    this.activeIdx = 0;
    this.videos[0].classList.add('is-active');
    this.videos[1].classList.remove('is-active');
  }

  // ===================== lifecycle =====================
  /** Called synchronously from the Play click. `playlist` is pre-validated. */
  start(playlist, options) {
    this.reset();
    this.base = playlist;
    this.mode = options.mode;
    this.isLoop = this.mode.endsWith('loop');
    this.overlayEnabled = !!options.titleOverlayEnabled;
    this.muted = !!options.startMuted;
    this.volume = 1;
    this.running = true;
    this.sequence = this._buildBlock();
    this.pos = 0;

    this.container.hidden = false;
    this.container.focus();
    this._setShellInert(true);
    this._bindFullscreenWatch();
    this._bindKeys();
    this._showHint();
    this._requestFs(); // must be synchronous within the gesture

    // Async from here (muted autoplay needs no transient activation).
    const first = this.sequence[0];
    this._prepare(this.videos[this.activeIdx], first)
      .then(() => {
        if (!this.running) return;
        this._activate(first);
        this.playedOk++;
        this._preloadNext();
      })
      .catch((e) => {
        if (!this.running) return;
        this.failedBase.add(first);
        this._recordFailure(first, e);
        this.transitionInProgress = true;
        this._goNext().catch((err) => { console.error(err); this.finish('all-failed'); });
      });
  }

  finish(reason) {
    if (this._finished) return;
    this._finished = true;
    this.running = false;
    this._clearWatchers();
    this.transitionInProgress = false;
    this._preload = null;

    for (const v of this.videos) { try { v.pause(); } catch (_) { /* */ } }

    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl && reason !== 'fullscreen-exit') {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { const p = exit.call(document); if (p && p.catch) p.catch(() => {}); } catch (_) { /* */ }
    }
    document.removeEventListener('fullscreenchange', this._fsHandler);
    document.removeEventListener('webkitfullscreenchange', this._fsHandler);
    this._unbindKeys();
    this._setShellInert(false);
    this.titleEl.classList.remove('is-visible');
    if (this.noticeEl) this.noticeEl.classList.remove('is-visible');
    clearTimeout(this._noticeTimer);
    this.container.hidden = true;

    // Release decoders / file descriptors.
    for (const v of this.videos) {
      try { v.removeAttribute('src'); v.load(); v.classList.remove('is-active'); } catch (_) { /* */ }
    }
    this.videos[0].classList.add('is-active');
    this.activeIdx = 0;

    this.onStop({
      reason,
      played: this.playedOk,
      failed: this.failed.slice(),
      total: this.base.length,
    });
  }

  requestStop() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { exit.call(document); } catch (_) { this.finish('exit'); }
      // fullscreenchange -> finish('fullscreen-exit')
    } else {
      this.finish('exit');
    }
  }

  // ===================== sequence =====================
  _buildBlock() {
    const idx = this.base.map((_, i) => i);
    return this.mode.startsWith('shuffle') ? shuffle(idx) : idx;
  }

  _ensureSeq(i) {
    if (i < this.sequence.length) return true;
    if (!this.isLoop) return false;
    while (this.sequence.length <= i) {
      const block = this._buildBlock();
      if (this.sequence.length > 0 && this.base.length > 1) {
        const last = this.sequence[this.sequence.length - 1];
        if (block[0] === last) {
          const k = 1 + Math.floor(Math.random() * (block.length - 1));
          [block[0], block[k]] = [block[k], block[0]];
        }
      }
      this.sequence.push(...block);
    }
    return true;
  }

  // ===================== preparing media =====================
  _trimIn(clip, dur) {
    return clamp(clip.in || 0, 0, dur != null ? Math.max(0, dur - MIN_CLIP) : (clip.in || 0));
  }

  _trimOut(clip, dur) {
    if (clip.outIsEnd) return dur != null ? dur : null;
    let o = clip.out;
    if (!Number.isFinite(o)) return dur != null ? dur : null;
    if (dur != null) o = clamp(o, 0, dur);
    const inP = this._trimIn(clip, dur);
    if (o <= inP) return dur != null ? dur : null;
    return o;
  }

  _seekTo(v, t) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; v.removeEventListener('seeked', finish); clearTimeout(to); resolve(); };
      const to = setTimeout(finish, 4000);
      v.addEventListener('seeked', finish);
      try { v.currentTime = t; } catch (_) { finish(); }
    });
  }

  async _resolveDuration(v, entry) {
    if (Number.isFinite(v.duration) && v.duration > 0) {
      this.onDuration(entry.server, v.duration);
      return;
    }
    // Infinity / NaN (some WebM / fragmented MP4): probe by seeking far ahead.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        v.removeEventListener('durationchange', h);
        v.removeEventListener('seeked', h);
        clearTimeout(to);
        resolve();
      };
      const h = () => { if (Number.isFinite(v.duration) && v.duration > 0) finish(); };
      const to = setTimeout(finish, 3000);
      v.addEventListener('durationchange', h);
      v.addEventListener('seeked', h);
      try { v.currentTime = 1e7; } catch (_) { finish(); }
    });
    if (Number.isFinite(v.duration) && v.duration > 0) this.onDuration(entry.server, v.duration);
  }

  /** Load + duration-resolve + seek to IN + decode a frame; leaves paused at IN. */
  _prepare(v, baseIdx) {
    const entry = this.base[baseIdx];
    const url = entry.server ? entry.server.url : '/videos/' + encodeURIComponent(entry.name);
    // Token so a superseded prepare on the SAME element (e.g. when skipping a
    // failed clip while a preload is still in flight) can't race the new one.
    const tok = (this._prepSeq = (this._prepSeq || 0) + 1);
    v._prepTok = tok;
    return new Promise((resolve, reject) => {
      let settled = false;
      const stale = () => v._prepTok !== tok;
      const cleanup = () => {
        v.removeEventListener('loadedmetadata', onMeta);
        v.removeEventListener('error', onErr);
        clearTimeout(to);
      };
      const fail = (reason) => { if (settled) return; settled = true; cleanup(); reject(new Error(reason)); };
      const ok = () => { if (settled) return; settled = true; cleanup(); resolve(); };
      const to = setTimeout(() => fail('timeout'), PREP_TIMEOUT);
      const onErr = () => { if (stale()) return; fail(mediaErrReason(v)); };
      const onMeta = async () => {
        if (stale()) return;
        try {
          await this._resolveDuration(v, entry);
          if (stale()) return;
          if (!this.running) return fail('stopped');
          const dur = Number.isFinite(v.duration) ? v.duration : null;
          const inP = this._trimIn(entry.clip, dur);
          await this._seekTo(v, inP);
          if (stale()) return;
          // Force-decode the first frame so the swap shows a real frame.
          v.muted = true;
          try { await v.play(); v.pause(); } catch (_) { /* AbortError is benign */ }
          if (stale()) return;
          if (!this.running) return fail('stopped');
          await this._seekTo(v, inP); // restore exact IN after the micro-play
          if (stale()) return;
          ok();
        } catch (e) {
          fail((e && e.message) || 'prepare failed');
        }
      };
      v.addEventListener('error', onErr);
      v.addEventListener('loadedmetadata', onMeta, { once: true });
      v.preload = 'auto';
      v.src = url;
      v.load();
    });
  }

  _preloadNext() {
    const p = this.pos + 1;
    if (!this._ensureSeq(p)) { this._preload = null; return; }
    const baseIdx = this.sequence[p];
    if (this.failedBase.has(baseIdx)) { this._preload = null; return; }
    const standby = this.videos[1 - this.activeIdx];
    const promise = this._prepare(standby, baseIdx);
    this._preload = { baseIdx, promise };
    // _goNext awaits this and handles rejection; swallow to avoid unhandledrejection
    promise.catch(() => {});
  }

  // ===================== advancing =====================
  advance(reason) {
    if (!this.running || this.transitionInProgress) return;
    this.transitionInProgress = true;
    this._clearWatchers();
    this._goNext().catch((err) => { console.error(err); this.finish('error'); });
  }

  async _goNext() {
    let p = this.pos + 1;
    let attempts = 0;
    const maxAttempts = this.base.length * 2 + 2;
    while (true) {
      if (!this._ensureSeq(p)) { this.finish('end'); return; }
      if (this.failedBase.size >= this.base.length) { this.finish('all-failed'); return; }
      const baseIdx = this.sequence[p];
      if (this.failedBase.has(baseIdx)) {
        p++; attempts++;
        if (attempts > maxAttempts) { this.finish('all-failed'); return; }
        continue;
      }
      const standby = this.videos[1 - this.activeIdx];
      try {
        if (this._preload && this._preload.baseIdx === baseIdx) {
          await this._preload.promise;
        } else {
          await this._prepare(standby, baseIdx);
        }
        if (!this.running) return;
        this.pos = p;
        this.activeIdx = 1 - this.activeIdx;
        this._activate(baseIdx);
        this.playedOk++;
        this.transitionInProgress = false;
        this._preloadNext();
        return;
      } catch (e) {
        this.failedBase.add(baseIdx);
        this._recordFailure(baseIdx, e);
        p++; attempts++;
        if (attempts > maxAttempts) { this.finish('all-failed'); return; }
      }
    }
  }

  _activate(baseIdx) {
    const v = this.videos[this.activeIdx];
    const old = this.videos[1 - this.activeIdx];
    const entry = this.base[baseIdx];
    const clip = entry.clip;
    const dur = Number.isFinite(v.duration) ? v.duration : null;
    const inP = this._trimIn(clip, dur);
    const outP = this._trimOut(clip, dur);
    this._inP = inP;
    this._outP = outP;
    this._activeClip = clip;

    v.classList.add('is-active');
    old.classList.remove('is-active');
    try { old.pause(); } catch (_) { /* */ }

    v.muted = this.muted;
    v.volume = this.volume;

    // Overlay text + initial visibility (re-shown on every clip entry).
    this.titleEl.textContent = clip.title || entry.name;
    this.titleEl.classList.toggle('is-visible', this.overlayEnabled);

    this._updateProgress();
    this._playActive(v);
    this._armWatchers(v, clip, inP, outP);
  }

  _playActive(v) {
    const pr = v.play();
    if (pr && pr.catch) {
      pr.catch((err) => {
        if (err && err.name === 'AbortError') return; // interrupted by a newer load/pause
        if (err && err.name === 'NotAllowedError') {
          // Browser blocked autoplay with sound — keep the video playing muted
          // rather than freezing on a paused frame.
          this.muted = true;
          v.muted = true;
          v.play().catch(() => {});
        }
      });
    }
  }

  // ===================== watchers =====================
  _armWatchers(v, clip, inP, outP) {
    this.activeToken++;
    const tok = this.activeToken;

    const onEnded = () => { if (tok !== this.activeToken || !this.running) return; this.advance('ended'); };
    v.addEventListener('ended', onEnded, { once: true });
    this._onEnded = { v, fn: onEnded };

    this._armOutTimer(v, outP);

    if (HAS_RVFC) {
      const tick = (now, meta) => {
        if (tok !== this.activeToken || !this.running) return;
        const t = meta ? meta.mediaTime : v.currentTime;
        if (outP != null && t >= outP - EPS) { this.advance('out'); return; }
        this._rvfcHandle = v.requestVideoFrameCallback(tick);
        this._rvfcVideo = v;
      };
      this._rvfcHandle = v.requestVideoFrameCallback(tick);
      this._rvfcVideo = v;
    } else {
      const onTU = () => {
        if (tok !== this.activeToken || !this.running) return;
        const t = v.currentTime;
        if (outP != null && t >= outP - EPS) this.advance('out');
      };
      v.addEventListener('timeupdate', onTU);
      this._onTU = { v, fn: onTU };
    }
  }

  _armOutTimer(v, outP) {
    clearTimeout(this._outTimer);
    this._outTimer = null;
    if (outP == null) return;
    const remaining = (outP - v.currentTime) / (v.playbackRate || 1);
    if (remaining <= 0) return; // rVFC will catch it
    this._outTimer = setTimeout(() => { if (this.running) this.advance('timeout'); }, remaining * 1000 + 120);
  }

  _clearWatchers() {
    this.activeToken++; // invalidate any in-flight callbacks
    if (this._rvfcVideo && this._rvfcHandle && this._rvfcVideo.cancelVideoFrameCallback) {
      try { this._rvfcVideo.cancelVideoFrameCallback(this._rvfcHandle); } catch (_) { /* */ }
    }
    this._rvfcHandle = null;
    this._rvfcVideo = null;
    clearTimeout(this._outTimer);
    this._outTimer = null;
    if (this._onEnded) { this._onEnded.v.removeEventListener('ended', this._onEnded.fn); this._onEnded = null; }
    if (this._onTU) { this._onTU.v.removeEventListener('timeupdate', this._onTU.fn); this._onTU = null; }
  }

  _updateProgress() {
    const n = this.base.length;
    const inCycle = (this.pos % n) + 1;
    const cycle = Math.floor(this.pos / n) + 1;
    const cycleLabel = this.isLoop ? ` · cycle ${cycle}` : '';
    this.progressEl.textContent = `${inCycle} / ${n}${cycleLabel}`;
  }

  _recordFailure(baseIdx, e) {
    const entry = this.base[baseIdx];
    const reason = (e && e.message) || 'load error';
    this.failed.push({ name: entry.name, reason });
    this.onToast(`Skipped “${entry.name}” — ${reason}`, 'warn');
    this.onAnnounce(`Skipped ${entry.name}: ${reason}`);
    this._notice(`Skipped “${entry.name}” — ${reason}`);
  }

  _notice(msg) {
    if (!this.noticeEl) return;
    this.noticeEl.textContent = msg;
    this.noticeEl.classList.add('is-visible');
    clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => this.noticeEl.classList.remove('is-visible'), 2500);
  }

  // ===================== fullscreen + input =====================
  _requestFs() {
    const el = this.container;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    this.usedFullscreen = false;
    if (!req) return; // CSS fixed-overlay fallback (the .player styles already cover the viewport)
    try {
      const p = req.call(el);
      if (p && p.then) {
        p.then(() => { this.usedFullscreen = true; }).catch(() => { this.usedFullscreen = false; });
      } else {
        this.usedFullscreen = true;
      }
    } catch (_) {
      this.usedFullscreen = false;
    }
  }

  _bindFullscreenWatch() {
    this._fsHandler = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (this.usedFullscreen && !fsEl && this.running) this.finish('fullscreen-exit');
    };
    document.addEventListener('fullscreenchange', this._fsHandler);
    document.addEventListener('webkitfullscreenchange', this._fsHandler);
  }

  _bindKeys() {
    this._keyHandler = (e) => this._onKey(e);
    this.container.addEventListener('keydown', this._keyHandler);
  }

  _unbindKeys() {
    if (this._keyHandler) this.container.removeEventListener('keydown', this._keyHandler);
    this._keyHandler = null;
  }

  _onKey(e) {
    this._showHint();
    const v = this.videos[this.activeIdx];
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.requestStop();
        break;
      case ' ': case 'Spacebar':
        e.preventDefault();
        if (v.paused) { v.play().catch(() => {}); this._armOutTimer(v, this._outP); }
        else { v.pause(); clearTimeout(this._outTimer); this._outTimer = null; }
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.advance('skip');
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this._restartCurrent();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this._setVolume(0.1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        this._setVolume(-0.1);
        break;
      case 'm': case 'M':
        e.preventDefault();
        this.muted = !this.muted;
        v.muted = this.muted;
        break;
      case 'f': case 'F':
        e.preventDefault();
        if (!(document.fullscreenElement || document.webkitFullscreenElement)) this._requestFs();
        break;
      default:
        break;
    }
  }

  _restartCurrent() {
    const v = this.videos[this.activeIdx];
    this._clearWatchers();            // cancel the stale rVFC/out/ended for this clip
    this._seekTo(v, this._inP);
    if (this.overlayEnabled) { this.titleEl.textContent = this._activeClip ? (this._activeClip.title || '') : ''; this.titleEl.classList.add('is-visible'); }
    if (v.paused) v.play().catch(() => {});
    this._armWatchers(v, this._activeClip, this._inP, this._outP); // fresh timing
  }

  _setVolume(delta) {
    this.volume = clamp(this.volume + delta, 0, 1);
    const v = this.videos[this.activeIdx];
    v.volume = this.volume;
    if (delta > 0 && this.volume > 0) { this.muted = false; v.muted = false; }
    this.onAnnounce(`Volume ${Math.round(this.volume * 100)}%`);
  }

  _showHint() {
    this.hintEl.classList.remove('is-hidden');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.hintEl.classList.add('is-hidden'), HINT_HIDE_MS);
  }

  _setShellInert(on) {
    if (!this.shell) return;
    try { this.shell.inert = on; } catch (_) { /* */ }
    if (on) this.shell.setAttribute('aria-hidden', 'true');
    else this.shell.removeAttribute('aria-hidden');
  }
}

export const player = new Player();
