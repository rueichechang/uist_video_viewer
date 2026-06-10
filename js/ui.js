// ui.js — library viewer, authoring pane, options pane, modals, toasts.
//
// Owns all DOM rendering and user input for the three panes. Reads/writes the
// store; triggers playback through a callback supplied by main.js (so the Play
// click stays synchronous within the user gesture).

import { store } from './store.js';
import {
  MIN_CLIP, clamp, round3, debounce, formatTime, formatShort, parseTime,
  titleFromName, canBrowserPlay, el, $, $all,
} from './util.js';

/** Resolve a video element's duration, probing the Infinity case. */
function resolveVideoDuration(v) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (val) => { if (done) return; done = true; cleanup(); resolve(val); };
    const onErr = () => fin(null);
    const onDur = () => { if (Number.isFinite(v.duration) && v.duration > 0) fin(v.duration); };
    const onMeta = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) return fin(v.duration);
      v.addEventListener('durationchange', onDur);
      v.addEventListener('seeked', onDur);
      try { v.currentTime = 1e7; } catch (_) { fin(null); }
    };
    const cleanup = () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('durationchange', onDur);
      v.removeEventListener('seeked', onDur);
      v.removeEventListener('error', onErr);
      clearTimeout(to);
    };
    const to = setTimeout(() => fin(null), 12000);
    v.addEventListener('error', onErr);
    if (v.readyState >= 1) onMeta();
    else v.addEventListener('loadedmetadata', onMeta);
  });
}

class UI {
  init(refs, handlers) {
    this.r = refs;
    this.onPlay = handlers.onPlay;
    this.onReload = handlers.onReload;
    this.selected = null;
    this.activePane = 'library';
    this._saveTitle = debounce((name, value) => {
      store.updateClip(name, { title: value });
      this.renderCard(name);
      this.updatePlayState();
      this._flashSaved();
    }, 300);

    this._bindTabs();
    this._bindOptions();
    this._bindAuthoring();
    this._bindConfigButtons();
    this.r.playBtn.addEventListener('click', () => this.onPlay());
    this.r.reloadBtn.addEventListener('click', () => this.onReload());
    this.r.libraryEmpty.querySelector('[data-action="reload"]')
      ?.addEventListener('click', () => this.onReload());
  }

  // ===================== server entry helpers =====================
  serverEntry(name) {
    return store.library.find((v) => v.name === name) || null;
  }
  serverMap() {
    const m = new Map();
    for (const v of store.library) m.set(v.name, { ...v, unplayable: !canBrowserPlay(v.type) });
    return m;
  }

  // ===================== full refresh =====================
  refreshAll() {
    this.renderLibrary();
    this.updatePlayState();
    if (this.selected && !store.getClip(this.selected)) this.selected = null;
    this.renderAuthoring();
    this._syncOptionInputs();
  }

  // ===================== library =====================
  renderLibrary() {
    const list = this.r.libraryList;
    const entries = store.library; // present files, already sorted by the server
    // Also surface authored-but-missing clips so they can be forgotten.
    const missing = Object.entries(store.doc.clips)
      .filter(([, c]) => c.missing)
      .map(([name]) => name);

    list.textContent = '';
    const empty = entries.length === 0 && missing.length === 0;
    this.r.libraryEmpty.hidden = !empty;
    list.hidden = empty;

    const smap = this.serverMap();
    for (const v of entries) list.append(this._card(v.name, smap.get(v.name)));
    for (const name of missing) list.append(this._card(name, null));
  }

  _card(name, sv) {
    const clip = store.getClip(name);
    if (!clip) return el('li');
    const card = el('li', {
      class: 'lib-card',
      role: 'option',
      tabindex: '0',
      'aria-selected': this.selected === name ? 'true' : 'false',
      dataset: { name },
    });

    const thumb = el('div', { class: 'lib-card__thumb' });
    if (sv && !sv.unplayable) {
      const vid = el('video', { class: 'thumb', muted: true, preload: 'none', playsInline: true });
      vid.setAttribute('aria-hidden', 'true');
      this._observeThumb(vid, sv, clip);
      thumb.append(vid);
    } else {
      thumb.append(el('span', { class: 'placeholder', text: '🎞' }));
    }

    const body = el('div', { class: 'lib-card__body' });
    body.append(el('div', { class: 'lib-card__name', title: name, text: name }));
    body.append(el('div', { class: 'lib-card__meta', dataset: { meta: name } }, this._metaText(clip)));
    body.append(this._badges(name, clip, sv));

    card.append(thumb, body);
    card.addEventListener('click', () => this.select(name));
    card.addEventListener('keydown', (e) => this._cardKey(e, name));
    return card;
  }

  _metaText(clip) {
    if (clip.missing) return 'File no longer in folder';
    if (clip.duration == null) {
      // A pinned OUT is playable even before the browser reports duration.
      if (!clip.outIsEnd && Number.isFinite(clip.out)) {
        const len = Math.max(0, clip.out - (clip.in || 0));
        return `${formatTime(clip.in || 0)} → ${formatTime(clip.out)} · plays ${formatShort(len)}`;
      }
      return 'Loading metadata…';
    }
    const { in: i, out: o } = store.effectiveTrim(clip);
    const len = store.trimmedLength(clip);
    return `${formatTime(i)} → ${formatTime(o)} · plays ${formatShort(len)}`;
  }

  _badges(name, clip, sv) {
    const wrap = el('div', { class: 'lib-card__badges' });
    const add = (cls, text) => wrap.append(el('span', { class: `badge ${cls}`, text }));
    const validity = store.clipValidity(clip, sv);
    if (clip.missing) { add('badge--bad', '⚠ Missing'); return wrap; }
    if (sv && sv.unplayable) add('badge--bad', '⚠ Unsupported');
    if (!clip.title || !clip.title.trim()) add('badge--warn', '⚠ Needs title');
    if (clip.changed) add('badge--warn', '↻ File changed');
    if (!clip.enabled) add('badge--off', 'Excluded');
    else if (validity.valid) add('badge--ok', '✓ In showreel');
    return wrap;
  }

  /** Lazily load a poster frame at the clip's IN point when the card is visible. */
  _observeThumb(vid, sv, clip) {
    if (!this._thumbObserver) {
      this._thumbObserver = new IntersectionObserver((items) => {
        for (const it of items) {
          if (!it.isIntersecting) continue;
          const v = it.target;
          this._thumbObserver.unobserve(v);
          if (!v.dataset.src) continue;
          v.preload = 'metadata';
          v.src = v.dataset.src;
        }
      }, { rootMargin: '200px' });
    }
    const at = clip.duration != null ? clamp(clip.in || 0, 0, Math.max(0, clip.duration - 0.05)) : (clip.in || 0.1);
    vid.dataset.src = `${sv.url}#t=${at.toFixed(2)}`;
    this._thumbObserver.observe(vid);
  }

  renderCard(name) {
    const card = this.r.libraryList.querySelector(`.lib-card[data-name="${CSS.escape(name)}"]`);
    if (!card) return;
    const clip = store.getClip(name);
    if (!clip) { card.remove(); return; }
    const sv = this.serverEntry(name);
    const svp = sv ? { ...sv, unplayable: !canBrowserPlay(sv.type) } : null;
    const meta = card.querySelector('.lib-card__meta');
    if (meta) meta.textContent = this._metaText(clip);
    const badges = card.querySelector('.lib-card__badges');
    if (badges) badges.replaceWith(this._badges(name, clip, svp));
  }

  _cardKey(e, name) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.select(name); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cards = $all('.lib-card', this.r.libraryList);
      const idx = cards.findIndex((c) => c.dataset.name === name);
      const next = cards[idx + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
    }
  }

  // ===================== selection / authoring =====================
  select(name) {
    this.selected = name;
    for (const c of $all('.lib-card', this.r.libraryList)) {
      c.setAttribute('aria-selected', c.dataset.name === name ? 'true' : 'false');
    }
    this.renderAuthoring();
    if (window.matchMedia('(max-width: 900px)').matches) this._activatePane('authoring');
  }

  renderAuthoring() {
    const name = this.selected;
    const clip = name ? store.getClip(name) : null;
    const sv = name ? this.serverEntry(name) : null;
    this.r.authoringEmpty.hidden = !!clip;
    this.r.authoringEditor.hidden = !clip;
    if (!clip) return;

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

  /** (Re)load the preview <video> for a clip, with robust metadata handling. */
  _loadPreview(prev, sv, clip, name) {
    // Reload on a different clip, or when reconcile cleared the duration (file
    // changed) — but not on a plain re-select, so the playhead is preserved.
    const needsLoad = prev.dataset.for !== name || clip.duration == null;
    if (!needsLoad) return;
    prev.dataset.for = name;
    const tok = (this._previewTok = (this._previewTok || 0) + 1);

    // Handlers are attached BEFORE src so a fast metadata event isn't missed.
    prev.onloadedmetadata = async () => {
      if (tok !== this._previewTok) return;
      let dur = prev.duration;
      if (!Number.isFinite(dur) || dur <= 0) dur = await resolveVideoDuration(prev); // probe Infinity
      if (Number.isFinite(dur) && dur > 0) {
        store.setDuration(sv, dur);
        this.renderCard(name);
        try { prev.currentTime = store.effectiveTrim(clip).in || 0; } catch (_) { /* */ }
      }
      this._syncEditor();
      this.updatePlayState();
    };
    prev.onerror = () => {
      if (tok !== this._previewTok) return;
      const code = prev.error ? prev.error.code : 0;
      // Once metadata exists the video is usable; a later error is non-fatal
      // (e.g. a moov-at-end file range-fetching during playback). Just log it.
      if (prev.readyState >= 1) { console.warn('preview media error (non-fatal):', code); return; }
      console.warn('preview could not load (MediaError code', code + ')');
      this.r.trimPlayhead.hidden = true;
    };
    prev.preload = 'metadata';
    prev.src = sv.url;
    prev.load();
  }

  /** Seek the preview to a timestamp so the user sees that frame while trimming. */
  _scrubPreview(t) {
    const prev = this.r.previewVideo;
    if (!prev || !Number.isFinite(t)) return;
    if (!prev.paused) prev.pause();
    try { prev.currentTime = t; } catch (_) { /* not seekable yet */ }
  }

  /** Position the playhead marker from the preview's current time. */
  _updatePlayhead() {
    const clip = this.selected ? store.getClip(this.selected) : null;
    const prev = this.r.previewVideo;
    const dur = clip && clip.duration != null ? clip.duration : (Number.isFinite(prev.duration) ? prev.duration : null);
    const ph = this.r.trimPlayhead;
    if (!dur || dur <= 0 || !Number.isFinite(prev.currentTime)) { ph.hidden = true; return; }
    ph.hidden = false;
    ph.style.left = `${clamp((prev.currentTime / dur) * 100, 0, 100)}%`;
  }

  /** Push the current clip's state into the editor controls. */
  _syncEditor(skipRanges) {
    const clip = store.getClip(this.selected);
    if (!clip) return;
    const dur = clip.duration;
    const { in: i, out: o } = store.effectiveTrim(clip);

    if (!skipRanges) {
      const max = dur != null ? dur : 100;
      this.r.rangeIn.max = max; this.r.rangeOut.max = max;
      this.r.rangeIn.value = i;
      this.r.rangeOut.value = o != null ? o : max;
      this.r.rangeIn.disabled = dur == null;
      this.r.rangeOut.disabled = dur == null;
    }
    this.r.inInput.value = round3(i);
    this.r.outInput.value = o != null ? round3(o) : '';
    // fill bar
    if (dur != null && dur > 0) {
      this.r.trimFill.style.left = `${(i / dur) * 100}%`;
      this.r.trimFill.style.right = `${(1 - (o != null ? o : dur) / dur) * 100}%`;
    } else {
      this.r.trimFill.style.left = '0%';
      this.r.trimFill.style.right = '0%';
    }
    const len = store.trimmedLength(clip);
    this.r.trimmedDuration.textContent = len != null ? formatShort(len) : '—';
    this.r.fullDuration.textContent = dur != null ? formatShort(dur) : '—';
    this._updatePlayhead();
    this._validateInOut();
  }

  _bindAuthoring() {
    const r = this.r;
    r.titleInput.addEventListener('input', () => {
      if (!this.selected) return;
      this._saveTitle(this.selected, r.titleInput.value);
      this._validateTitle();
    });
    r.titleInput.addEventListener('blur', () => this._validateTitle());

    const onRange = (which) => {
      const clip = store.getClip(this.selected);
      if (!clip || clip.duration == null) return;
      const dur = clip.duration;
      let inV = Number(r.rangeIn.value);
      let outV = Number(r.rangeOut.value);
      if (which === 'in' && inV > outV - MIN_CLIP) { inV = Math.max(0, outV - MIN_CLIP); r.rangeIn.value = inV; }
      if (which === 'out' && outV < inV + MIN_CLIP) { outV = Math.min(dur, inV + MIN_CLIP); r.rangeOut.value = outV; }
      // scrub the preview to the handle being dragged so its frame is visible
      this._scrubPreview(which === 'in' ? inV : outV);
      const atEnd = outV >= dur - 0.001;
      this._commitTrim(round3(inV), round3(outV), atEnd, { skipRanges: true });
    };
    r.rangeIn.addEventListener('input', () => onRange('in'));
    r.rangeOut.addEventListener('input', () => onRange('out'));

    // Reflect the preview's playback position as a playhead on the trim track.
    r.previewVideo.addEventListener('timeupdate', () => this._updatePlayhead());
    r.previewVideo.addEventListener('seeked', () => this._updatePlayhead());

    const onNum = (field) => {
      const clip = store.getClip(this.selected);
      if (!clip) return;
      const raw = field === 'in' ? r.inInput.value : r.outInput.value;
      const parsed = parseTime(raw);
      if (Number.isNaN(parsed)) { this._validateInOut('Enter a number like 12.5 or 1:23.'); return; }
      const dur = clip.duration;
      if (field === 'in') {
        const inV = dur != null ? clamp(parsed, 0, dur) : Math.max(0, parsed);
        if (clip.outIsEnd) {
          // keep the "play to end" intent; don't fabricate a numeric OUT
          this._commitTrim(round3(inV), dur != null ? dur : (clip.out || 0), true);
        } else {
          const outV = dur != null ? clamp(clip.out || 0, 0, dur) : (clip.out || 0);
          this._commitTrim(round3(inV), round3(outV), false);
        }
      } else {
        const outV = dur != null ? clamp(parsed, 0, dur) : Math.max(0, parsed);
        const atEnd = dur != null && outV >= dur - 0.001;
        this._commitTrim(clip.in || 0, round3(outV), atEnd);
      }
    };
    r.inInput.addEventListener('change', () => onNum('in'));
    r.outInput.addEventListener('change', () => onNum('out'));

    r.setInBtn.addEventListener('click', () => {
      const clip = store.getClip(this.selected); if (!clip) return;
      const t = round3(this.r.previewVideo.currentTime || 0);
      const o = clip.outIsEnd ? (clip.duration ?? t + 1) : clip.out;
      this._commitTrim(t, o, clip.outIsEnd);
    });
    r.setOutBtn.addEventListener('click', () => {
      const clip = store.getClip(this.selected); if (!clip) return;
      const t = round3(this.r.previewVideo.currentTime || 0);
      const atEnd = clip.duration != null && t >= clip.duration - 0.001;
      this._commitTrim(clip.in || 0, t, atEnd);
    });

    r.enabledInput.addEventListener('change', () => {
      if (!this.selected) return;
      store.updateClip(this.selected, { enabled: r.enabledInput.checked });
      this.renderCard(this.selected);
      this.updatePlayState();
      this._flashSaved();
    });

    r.playTrimmedBtn.addEventListener('click', () => this._playTrimmedPreview());

    r.forgetBtn.addEventListener('click', () => {
      const name = this.selected;
      if (!name) return;
      store.forgetClip(name);
      this.selected = null;
      this.refreshAll();
      this.toast(`Forgot “${name}”.`);
    });
  }

  _commitTrim(inV, outV, atEnd, opts = {}) {
    const name = this.selected;
    const clip = store.getClip(name);
    if (!clip) return;
    // Reject a degenerate range (when duration is known); revert the inputs to
    // the last valid values rather than persisting an invalid trim.
    if (clip.duration != null && outV - inV < MIN_CLIP && !atEnd) {
      this._validateInOut(`Start and end must be at least ${MIN_CLIP}s apart.`);
      this._syncEditor(opts.skipRanges);
      return;
    }
    this._validateInOut();
    store.updateClip(name, { in: inV, out: outV, outIsEnd: !!atEnd });
    this._syncEditor(opts.skipRanges);
    this.renderCard(name);
    this.updatePlayState();
    this._flashSaved();
  }

  _playTrimmedPreview() {
    const clip = store.getClip(this.selected);
    if (!clip) return;
    const v = this.r.previewVideo;
    const { in: i, out: o } = store.effectiveTrim(clip);
    if (this._trimWatch) { v.removeEventListener('timeupdate', this._trimWatch); this._trimWatch = null; }
    v.currentTime = i;
    v.muted = true;
    v.play().catch(() => {});
    if (o != null) {
      this._trimWatch = () => {
        if (v.currentTime >= o - 0.03) { v.pause(); v.removeEventListener('timeupdate', this._trimWatch); this._trimWatch = null; }
      };
      v.addEventListener('timeupdate', this._trimWatch);
    }
  }

  _validateTitle() {
    const clip = store.getClip(this.selected);
    const bad = clip && (!clip.title || !clip.title.trim());
    this.r.titleError.hidden = !bad;
  }
  _validateInOut(msg) {
    const e = this.r.inOutError;
    if (msg) { e.textContent = msg; e.hidden = false; }
    else { e.textContent = ''; e.hidden = true; }
  }
  _flashSaved() {
    this.r.saveStatus.textContent = 'Saved';
    clearTimeout(this._savedTimer);
    this._savedTimer = setTimeout(() => { this.r.saveStatus.textContent = ''; }, 1200);
  }

  // ===================== options + play state =====================
  _bindOptions() {
    for (const radio of $all('input[name="mode"]', this.r.optionsPane)) {
      radio.addEventListener('change', () => {
        if (radio.checked) { store.setOption('mode', radio.value); this.updatePlayState(); }
      });
    }
    this.r.overlayEnabled.addEventListener('change', () =>
      store.setOption('titleOverlayEnabled', this.r.overlayEnabled.checked));
    this.r.startMuted.addEventListener('change', () =>
      store.setOption('startMuted', this.r.startMuted.checked));
  }

  _syncOptionInputs() {
    const o = store.options;
    const radio = $(`input[name="mode"][value="${o.mode}"]`, this.r.optionsPane);
    if (radio) radio.checked = true;
    this.r.overlayEnabled.checked = !!o.titleOverlayEnabled;
    this.r.startMuted.checked = !!o.startMuted;
  }

  buildPlaylist() {
    return store.playablePlaylist(this.serverMap());
  }

  updatePlayState() {
    const playlist = this.buildPlaylist();
    const ready = playlist.length > 0;
    this.r.playBtn.disabled = !ready;

    if (ready) {
      const total = playlist.reduce((s, x) => s + (store.trimmedLength(x.clip) || 0), 0);
      const txt = `Playlist: ${playlist.length} clip${playlist.length === 1 ? '' : 's'} · total ${formatShort(total)}`;
      this.r.sessionSummary.textContent = txt;
      this.r.playBlockers.textContent = '';
    } else {
      this.r.sessionSummary.textContent = '';
      this.r.playBlockers.textContent = this._blockerSummary();
    }
  }

  _blockerSummary() {
    const smap = this.serverMap();
    const enabled = Object.entries(store.doc.clips).filter(([, c]) => c.enabled && !c.missing);
    if (store.library.length === 0) return 'No videos in the folder — add files and rescan.';
    if (enabled.length === 0) return 'No clips are enabled for the showreel.';
    const counts = {};
    for (const [name, clip] of enabled) {
      const { reasons } = store.clipValidity(clip, smap.get(name));
      for (const reZ of reasons) counts[reZ] = (counts[reZ] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([reZ, n]) => `${n} ${reZ}`);
    return parts.length ? `Nothing ready to play — ${parts.join(', ')}.` : 'Nothing ready to play.';
  }

  // ===================== config (export / import) =====================
  _bindConfigButtons() {
    this.r.exportBtn.addEventListener('click', () => this._export());
    this.r.importBtn.addEventListener('click', () => this.r.importInput.click());
    this.r.importInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) this._import(file);
      e.target.value = '';
    });
  }

  _export() {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'showreel-config.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast('Exported showreel-config.json');
  }

  async _import(file) {
    let text;
    try { text = await file.text(); } catch (_) { this.toast('Could not read the file.', 'bad'); return; }
    const res = store.parseImport(text);
    if (!res.ok) { this.toast(`Import failed: ${res.error}`, 'bad'); return; }
    const apply = (mode) => {
      if (mode === 'replace') store.replaceWith(res.doc);
      else store.mergeFrom(res.doc);
      store.reconcile(store.library); // re-link to files actually present
      this.refreshAll();
      this.toast(`Imported config (${mode}).`);
    };
    this.showModal({
      title: 'Import configuration',
      body: [el('p', { text: 'Replace your current configuration, or merge the imported clips into it?' })],
      actions: [
        { label: 'Replace', kind: 'btn--primary', onClick: () => apply('replace') },
        { label: 'Merge', onClick: () => apply('merge') },
        { label: 'Cancel' },
      ],
    });
  }

  // ===================== tabs (narrow viewport) =====================
  _bindTabs() {
    for (const tab of $all('.tab', this.r.shell)) {
      tab.addEventListener('click', () => this._activatePane(tab.dataset.pane));
    }
  }
  _activatePane(pane) {
    this.activePane = pane;
    for (const t of $all('.tab', this.r.shell)) {
      t.setAttribute('aria-selected', t.dataset.pane === pane ? 'true' : 'false');
    }
    for (const p of $all('.pane', this.r.shell)) {
      p.classList.toggle('is-active', p.dataset.pane === pane);
    }
  }

  // ===================== duration scan =====================
  async scanDurations() {
    const pending = store.library.filter((v) => {
      const c = store.getClip(v.name);
      return c && !c.missing && c.duration == null && canBrowserPlay(v.type);
    });
    if (!pending.length) return;
    let i = 0;
    const POOL = Math.min(3, pending.length);
    const worker = async () => {
      while (i < pending.length) {
        const v = pending[i++];
        const sv = document.createElement('video');
        sv.preload = 'metadata'; sv.muted = true; sv.src = v.url;
        const dur = await resolveVideoDuration(sv);
        if (dur != null) store.setDuration(v, dur);
        try { sv.removeAttribute('src'); sv.load(); } catch (_) { /* */ }
        this.renderCard(v.name);
        if (this.selected === v.name) this._syncEditor();
        this.updatePlayState();
      }
    };
    await Promise.all(Array.from({ length: POOL }, worker));
  }

  // ===================== toasts / announce / modal =====================
  toast(msg, kind) {
    const t = el('div', { class: `toast${kind ? ' toast--' + kind : ''}`, text: msg });
    this.r.toasts.append(t);
    setTimeout(() => t.remove(), 2400);
  }

  announce(msg) { this.r.liveAssertive.textContent = msg; }

  showModal({ title, body, actions }) {
    const root = this.r.modalRoot;
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' });
    modal.append(el('h2', { text: title }));
    const bodyEl = el('div', { class: 'modal__body' }, body || []);
    modal.append(bodyEl);
    const actionsEl = el('div', { class: 'modal__actions' });
    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); if (this._modalReturn) this._modalReturn.focus(); };
    for (const a of (actions || [{ label: 'Close' }])) {
      const btn = el('button', { class: `btn ${a.kind || ''}`, type: 'button', text: a.label });
      btn.addEventListener('click', () => { close(); if (a.onClick) a.onClick(); });
      actionsEl.append(btn);
    }
    modal.append(actionsEl);
    backdrop.append(modal);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') { // simple focus trap
        const f = $all('button, [href], input, [tabindex]:not([tabindex="-1"])', modal);
        if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    this._modalReturn = document.activeElement;
    root.append(backdrop);
    (actionsEl.querySelector('button') || modal).focus();
  }

  /** End-of-playback summary (only shown when something was skipped). */
  showSummary(summary) {
    if (!summary.failed.length && summary.reason !== 'all-failed') return;
    const title = summary.reason === 'all-failed' ? 'Couldn’t play any clips' : 'Finished — some clips were skipped';
    const intro = el('p', {
      text: summary.reason === 'all-failed'
        ? 'None of the clips could be loaded:'
        : `Played ${summary.played} clip${summary.played === 1 ? '' : 's'}. Skipped the following:`,
    });
    const ul = el('ul', { class: 'modal__list' });
    for (const f of summary.failed) ul.append(el('li', { text: `${f.name} — ${f.reason}` }));
    this.showModal({ title, body: [intro, ul], actions: [{ label: 'Close', kind: 'btn--primary' }] });
  }
}

export const ui = new UI();
