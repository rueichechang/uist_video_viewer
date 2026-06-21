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

import { MIN_CLIP, clamp, shuffle, parseCaptions, encodePath } from './util.js';
import { loadDoc, renderPage } from './pdf.js';

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
    this.captionEl = refs.captionOverlay;
    this.noticeEl = this.container.querySelector('#playerNotice');
    this.progressEl = refs.clipProgress;
    this.hintEl = refs.controlHint;
    this.exitBtn = refs.exitBtn;
    this.shell = refs.shell;
    this.onStop = refs.onStop || (() => {});
    this.onToast = refs.onToast || (() => {});
    this.onAnnounce = refs.onAnnounce || (() => {});
    this.onDuration = refs.onDuration || (() => {});
    this.pdfCanvas = refs.pdfCanvas;
    this.onPageCount = refs.onPageCount || (() => {});
    this.onSaveResume = refs.onSaveResume || (() => {});
    this.onClearResume = refs.onClearResume || (() => {});

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
    this._segs = [];   // resolved [{inP, outP}] for the active clip
    this._segIdx = 0;  // which segment of the active clip is playing
    this.activeIdx = 0;
    this._captionCache = new Map(); // url -> Promise<cues[]>
    this._captionCues = [];         // cues for the active clip (in file time)
    this._captionUrl = null;        // url currently owning the overlay
    this._captionText = null;       // last rendered cue text (dedupe)
    this._renderCaption('');
    this._pdfTimer = null;
    this._pdfDoc = null;
    this._pdfPages = [];
    this._pdfIdx = 0;
    this._pdfPaused = false;
    this._pdfArmedAt = 0;
    this._pdfArmedMs = 0;
    this._pdfRemaining = null;
    this._resumeSpot = null;
    if (this.pdfCanvas) this.pdfCanvas.classList.remove('is-active');
    this.theater = false;
    this.container.classList.remove('player--theater');
    this.videos[0].classList.add('is-active');
    this.videos[1].classList.remove('is-active');
  }

  // ===================== lifecycle =====================
  /** Called synchronously from the Play click. `playlist` is pre-validated. */
  start(playlist, options, plan) {
    this.reset();
    this.base = playlist;
    this.mode = (plan && plan.mode) || options.mode;
    this.isLoop = this.mode.endsWith('loop');
    this.overlayEnabled = !!options.titleOverlayEnabled;
    this.muted = !!options.startMuted;
    this.volume = 1;
    this.theater = !!options.theater;
    this.running = true;
    if (plan && Array.isArray(plan.order) && plan.order.length) {
      this.sequence = plan.order.slice();
      this.pos = clamp(plan.pos || 0, 0, this.sequence.length - 1);
      this._resumeSpot = { kind: plan.kind, segIdx: plan.segIdx, time: plan.time, pageIdx: plan.pageIdx };
    } else {
      this.sequence = this._buildBlock();
      this.pos = 0;
      this._resumeSpot = null;
    }

    this.container.hidden = false;
    this.container.focus();
    this._setShellInert(true);
    this._bindFullscreenWatch();
    this._bindKeys();
    this._showHint();
    if (this.theater) this.container.classList.add('player--theater');
    else this._requestFs(); // must be synchronous within the gesture

    // Async from here (muted autoplay needs no transient activation).
    const first = this.sequence[this.pos];
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
    if (reason === 'end' || reason === 'all-failed') this.onClearResume();
    else this.onSaveResume(this.getResumeSnapshot()); // capture exact spot before teardown
    this._finished = true;
    this.running = false;
    this._clearWatchers();
    this.transitionInProgress = false;
    this._preload = null;

    for (const v of this.videos) { try { v.pause(); } catch (_) { /* */ } }

    clearTimeout(this._pdfTimer); this._pdfTimer = null;
    if (this.pdfCanvas) this.pdfCanvas.classList.remove('is-active');
    this.container.classList.remove('player--theater');
    this._pdfDoc = null;
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
    this._captionUrl = null;
    this._renderCaption('');
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
  // _trimIn/_trimOut resolve ONE segment ({ in, out, outIsEnd }) against the
  // file duration, exactly as the single-trim case did before.
  _trimIn(seg, dur) {
    return clamp(seg.in || 0, 0, dur != null ? Math.max(0, dur - MIN_CLIP) : (seg.in || 0));
  }

  _trimOut(seg, dur) {
    if (seg.outIsEnd) return dur != null ? dur : null;
    let o = seg.out;
    if (!Number.isFinite(o)) return dur != null ? dur : null;
    if (dur != null) o = clamp(o, 0, dur);
    const inP = this._trimIn(seg, dur);
    if (o <= inP) return dur != null ? dur : null;
    return o;
  }

  /**
   * Resolve a clip's ordered segment list to playable [{inP, outP}] pairs.
   * Drops zero-length segments and any non-final segment that can't be cut
   * (no resolvable OUT); a single-segment clip collapses to the old behaviour.
   * Always returns at least one segment.
   */
  _segments(clip, dur) {
    const list = (clip.segments && clip.segments.length) ? clip.segments : [{ in: 0, out: 0, outIsEnd: true }];
    const out = [];
    for (let k = 0; k < list.length; k++) {
      const seg = list[k];
      const isLast = k === list.length - 1;
      const inP = this._trimIn(seg, dur);
      const outP = this._trimOut(seg, dur);
      if (!isLast && outP == null) continue;                 // can't cut -> would never advance
      if (dur != null && outP != null && outP - inP < MIN_CLIP) continue; // zero-length
      out.push({ inP, outP });
    }
    if (!out.length) {
      const seg = list[0];
      out.push({ inP: this._trimIn(seg, dur), outP: this._trimOut(seg, dur) });
    }
    return out;
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
    if (entry.clip.kind === 'pdf') {
      const url = entry.server ? entry.server.url : '/videos/' + encodePath(entry.name);
      return loadDoc(url).then(({ numPages }) => {
        if (entry.server) this.onPageCount(entry.server, numPages);
      });
    }
    // ---- existing video prepare below (unchanged) ----
    const url = entry.server ? entry.server.url : '/videos/' + encodePath(entry.name);
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
          const inP = this._segments(entry.clip, dur)[0].inP;
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

  /**
   * Reached the OUT of the current segment. If the active clip has more
   * segments, seek to the next on the SAME element (a brief in-place hitch, no
   * buffer swap); otherwise hand off to advance() for the gap-free clip swap.
   * _clearWatchers() bumps activeToken so the stale watcher that triggered this
   * can't fire again — making this idempotent per segment, like advance().
   */
  _segmentDone(reason) {
    if (!this.running || this.transitionInProgress) return;
    if (this._segs && this._segIdx < this._segs.length - 1) {
      this._clearWatchers();
      this._segIdx++;
      const seg = this._segs[this._segIdx];
      this._inP = seg.inP;
      this._outP = seg.outP;
      this._updateProgress();
      const v = this.videos[this.activeIdx];
      this._seekTo(v, seg.inP).then(() => {
        if (!this.running) return;
        if (v.paused) this._playActive(v);
        this._armWatchers(v, this._activeClip, seg.inP, seg.outP);
      });
      return;
    }
    this.advance(reason); // last segment -> next clip
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
    if (this.base[baseIdx].clip.kind === 'pdf') { this._activatePdf(baseIdx); return; }
    // ---- existing video activate below (unchanged) ----
    if (this.pdfCanvas) this.pdfCanvas.classList.remove('is-active');
    const v = this.videos[this.activeIdx];
    const old = this.videos[1 - this.activeIdx];
    const entry = this.base[baseIdx];
    const clip = entry.clip;
    const dur = Number.isFinite(v.duration) ? v.duration : null;
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
    this._inP = inP;
    this._outP = outP;
    this._activeClip = clip;
    this._loadCaptions(entry);

    v.classList.add('is-active');
    old.classList.remove('is-active');
    try { old.pause(); } catch (_) { /* */ }

    v.muted = this.muted;
    v.volume = this.volume;

    // Overlay text + initial visibility (re-shown on every clip entry).
    this.titleEl.textContent = clip.title || entry.name;
    this.titleEl.classList.toggle('is-visible', this.overlayEnabled);

    this._updateProgress();
    if (startAt != null) { try { v.currentTime = startAt; } catch (_) { /* */ } }
    this._playActive(v);
    this._armWatchers(v, clip, inP, outP);
    this.onSaveResume(this.getResumeSnapshot());
  }

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
    if (this._resumeSpot && this._resumeSpot.kind === 'pdf') {
      this._pdfIdx = clamp(this._resumeSpot.pageIdx || 0, 0, this._pdfPages.length - 1);
    }
    this._resumeSpot = null;
    this._pdfPaused = false;
    this._pdfRemaining = null;
    this._updateProgress();
    this.onSaveResume(this.getResumeSnapshot());

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

    const onEnded = () => { if (tok !== this.activeToken || !this.running) return; this._segmentDone('ended'); };
    v.addEventListener('ended', onEnded, { once: true });
    this._onEnded = { v, fn: onEnded };

    this._armOutTimer(v, outP);

    if (HAS_RVFC) {
      const tick = (now, meta) => {
        if (tok !== this.activeToken || !this.running) return;
        const t = meta ? meta.mediaTime : v.currentTime;
        this._updateCaption(t);
        if (outP != null && t >= outP - EPS) { this._segmentDone('out'); return; }
        this._rvfcHandle = v.requestVideoFrameCallback(tick);
        this._rvfcVideo = v;
      };
      this._rvfcHandle = v.requestVideoFrameCallback(tick);
      this._rvfcVideo = v;
    } else {
      const onTU = () => {
        if (tok !== this.activeToken || !this.running) return;
        const t = v.currentTime;
        this._updateCaption(t);
        if (outP != null && t >= outP - EPS) this._segmentDone('out');
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
    this._outTimer = setTimeout(() => { if (this.running) this._segmentDone('timeout'); }, remaining * 1000 + 120);
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
    clearTimeout(this._pdfTimer);
    this._pdfTimer = null;
    if (this._onEnded) { this._onEnded.v.removeEventListener('ended', this._onEnded.fn); this._onEnded = null; }
    if (this._onTU) { this._onTU.v.removeEventListener('timeupdate', this._onTU.fn); this._onTU = null; }
  }

  _updateProgress() {
    const n = this.base.length;
    const inCycle = (this.pos % n) + 1;
    const cycle = Math.floor(this.pos / n) + 1;
    const cycleLabel = this.isLoop ? ` · cycle ${cycle}` : '';
    let segLabel = '';
    if (this._activeClip && this._activeClip.kind === 'pdf') {
      segLabel = ` · page ${this._pdfIdx + 1}/${this._pdfPages.length}`;
    } else if (this._segs && this._segs.length > 1) {
      segLabel = ` · seg ${this._segIdx + 1}/${this._segs.length}`;
    }
    this.progressEl.textContent = `${inCycle} / ${n}${cycleLabel}${segLabel}`;
  }

  // ===================== captions =====================
  /**
   * Fetch + parse the active clip's sidecar caption file (cached per URL).
   * Cues carry ORIGINAL-file timestamps; since playback seeks within that same
   * file, matching cues against the raw currentTime makes trimmed/reordered
   * segments fall out for free — portions we skip simply never get matched.
   */
  _loadCaptions(entry) {
    this._captionCues = [];
    this._captionText = null;
    this._renderCaption('');
    const url = entry && entry.server && entry.server.captionUrl;
    this._captionUrl = url || null;
    if (!url) return;
    const apply = (cues) => { if (this._captionUrl === url) this._captionCues = cues || []; };
    if (this._captionCache.has(url)) {
      this._captionCache.get(url).then(apply);
      return;
    }
    const promise = fetch(url, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((txt) => parseCaptions(txt))
      .catch(() => []);
    this._captionCache.set(url, promise);
    promise.then(apply);
  }

  /** Show the cue covering media time `t` (or clear it between cues). */
  _updateCaption(t) {
    if (!this.captionEl) return;
    const cues = this._captionCues;
    let text = '';
    if (cues && cues.length) {
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (c.start > t) break;            // sorted: nothing later can match
        if (t < c.end) { text = c.text; break; }
      }
    }
    if (text !== this._captionText) {
      this._captionText = text;
      this._renderCaption(text);
    }
  }

  _renderCaption(text) {
    if (!this.captionEl) return;
    if (text) {
      // One styled "line box" per physical line so the background hugs the text.
      this.captionEl.replaceChildren(...text.split('\n').map((line) => {
        const span = document.createElement('span');
        span.className = 'caption-overlay__line';
        span.textContent = line;
        return span;
      }));
      this.captionEl.classList.add('is-visible');
    } else {
      this.captionEl.classList.remove('is-visible');
      this.captionEl.replaceChildren();
    }
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
      case 'ArrowRight':
        e.preventDefault();
        this.advance('skip');
        break;
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
      case 'ArrowUp':
        e.preventDefault();
        if (this._activeClip && this._activeClip.kind === 'pdf') { e.preventDefault(); break; }
        this._setVolume(0.1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (this._activeClip && this._activeClip.kind === 'pdf') { e.preventDefault(); break; }
        this._setVolume(-0.1);
        break;
      case 'm': case 'M':
        e.preventDefault();
        if (this._activeClip && this._activeClip.kind === 'pdf') { e.preventDefault(); break; }
        this.muted = !this.muted;
        v.muted = this.muted;
        break;
      case 'f': case 'F':
        e.preventDefault();
        if (!this.theater && !(document.fullscreenElement || document.webkitFullscreenElement)) this._requestFs();
        break;
      default:
        break;
    }
  }

  _restartCurrent() {
    const v = this.videos[this.activeIdx];
    this._clearWatchers();            // cancel the stale rVFC/out/ended for this clip
    // Restart the WHOLE clip from its first segment, not the current one.
    this._segIdx = 0;
    const seg0 = (this._segs && this._segs[0]) || { inP: this._inP, outP: this._outP };
    this._inP = seg0.inP;
    this._outP = seg0.outP;
    this._updateProgress();
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
