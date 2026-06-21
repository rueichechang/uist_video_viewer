// main.js — entry point. Wires the store, player engine, and UI together.

import { store } from './store.js';
import { player } from './player.js';
import { ui } from './ui.js';
import { idFromName } from './util.js';

const byId = (id) => document.getElementById(id);

const refs = {
  // shell / appbar
  shell: byId('shell'),
  playBtn: byId('playBtn'),
  savedIndicator: byId('savedIndicator'),
  sessionSummary: byId('sessionSummary'),
  reloadBtn: byId('reloadBtn'),
  playSidebarBtn: byId('playSidebarBtn'),
  startOverBtn: byId('startOverBtn'),

  // library
  libraryList: byId('libraryList'),
  libraryEmpty: byId('libraryEmpty'),
  forgetMissingBtn: byId('forgetMissingBtn'),

  // authoring
  authoringEmpty: byId('authoringEmpty'),
  authoringEditor: byId('authoringEditor'),
  previewVideo: byId('previewVideo'),
  titleInput: byId('titleInput'),
  titleError: byId('titleError'),
  rangeIn: byId('rangeIn'),
  rangeOut: byId('rangeOut'),
  trimFill: byId('trimFill'),
  trimBands: byId('trimBands'),
  trimPlayhead: byId('trimPlayhead'),
  inInput: byId('inInput'),
  outInput: byId('outInput'),
  inOutError: byId('inOutError'),
  setInBtn: byId('setInBtn'),
  setOutBtn: byId('setOutBtn'),
  segEditHint: byId('segEditHint'),
  segmentsBlock: byId('segmentsBlock'),
  segmentList: byId('segmentList'),
  addSegBtn: byId('addSegBtn'),
  trimmedDuration: byId('trimmedDuration'),
  fullDuration: byId('fullDuration'),
  playTrimmedBtn: byId('playTrimmedBtn'),
  enabledInput: byId('enabledInput'),
  forgetBtn: byId('forgetBtn'),
  saveStatus: byId('saveStatus'),

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

  // options
  optionsPane: byId('optionsPane'),
  overlayEnabled: byId('overlayEnabled'),
  startMuted: byId('startMuted'),
  playBlockers: byId('playBlockers'),
  previewConfigBtn: byId('previewConfigBtn'),
  exportBtn: byId('exportBtn'),
  importBtn: byId('importBtn'),
  importInput: byId('importInput'),

  // player
  container: byId('player'),
  videoA: byId('videoA'),
  videoB: byId('videoB'),
  pdfCanvas: byId('pdfCanvas'),
  titleOverlay: byId('titleOverlay'),
  captionOverlay: byId('captionOverlay'),
  clipProgress: byId('clipProgress'),
  controlHint: byId('controlHint'),
  exitBtn: byId('exitBtn'),

  // global
  toasts: byId('toasts'),
  liveAssertive: byId('liveAssertive'),
  modalRoot: byId('modalRoot'),
};

function startPlayback(theater) {
  const playlist = ui.buildPlaylist();
  if (!playlist.length) return;
  const snap = store.getResume();
  const plan = snap ? store.resolveResume(snap, playlist) : null;
  if (snap && !plan) ui.toast("Couldn't resume — starting over.", 'warn');
  // Synchronous within the click gesture so fullscreen is granted.
  player.start(playlist, { ...store.options, theater: !!theater }, plan);
}

async function loadLibrary() {
  let videos = [];
  try {
    const res = await fetch('/api/videos', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    videos = Array.isArray(data.videos) ? data.videos : [];
    // Order the library by the 4-digit clip ID so the cards (which show the ID)
    // read in numeric order; playback follows this order. Files without an ID
    // fall back to filename order, matching the server's default sort.
    videos.sort((a, b) =>
      idFromName(a.name).localeCompare(idFromName(b.name), undefined, { numeric: true, sensitivity: 'base' })
    );
  } catch (err) {
    ui.toast('Could not reach the server. Run "node server.js" and reload.', 'bad');
  }
  store.reconcile(videos);
  ui.refreshAll();
  ui.scanDurations();
}

function init() {
  store.load();

  player.init({
    container: refs.container,
    videoA: refs.videoA,
    videoB: refs.videoB,
    pdfCanvas: refs.pdfCanvas,
    titleOverlay: refs.titleOverlay,
    captionOverlay: refs.captionOverlay,
    clipProgress: refs.clipProgress,
    controlHint: refs.controlHint,
    exitBtn: refs.exitBtn,
    shell: refs.shell,
    onStop: (summary) => { ui.showSummary(summary); ui.refreshPlayControls(); refs.playBtn.focus(); },
    onToast: (m, k) => ui.toast(m, k),
    onAnnounce: (m) => ui.announce(m),
    onDuration: (sv, dur) => {
      if (!sv) return;
      store.setDuration(sv, dur);
      ui.renderCard(sv.name);
    },
    onPageCount: (sv, n) => {
      if (!sv) return;
      store.setPageCount(sv, n);
      ui.renderCard(sv.name);
      if (ui.selected === sv.name) ui.renderAuthoring();
    },
    onSaveResume: (snap) => store.setResume(snap),
    onClearResume: () => store.clearResume(),
  });

  ui.init(refs, {
    onPlay: () => startPlayback(false),
    onPlayTheater: () => startPlayback(true),
    onReload: loadLibrary,
    onJump: (name) => (player.running && player.theater) ? player.jumpTo(name) : false,
    onStartOver: () => { store.clearResume(); ui.refreshPlayControls(); },
  });
  ui.refreshPlayControls();
  ui._syncOptionInputs();

  store.on('storage-error', () =>
    ui.toast('Storage problem — changes may not be saved. Export to back up.', 'warn'));

  // Config is autosaved after every edit, but on a 300ms debounce. Force any
  // pending write out when the tab is hidden or closing so the last edit (e.g.
  // a quick segment tweak right before navigating away) is never lost.
  const flushNow = () => {
    store.flush();
    if (player.running) store.setResume(player.getResumeSnapshot());
  };
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });

  // Another tab edited the same config: warn rather than silently clobber.
  window.addEventListener('storage', (e) => {
    if (e.key === 'showreel.config.v1' && e.newValue) {
      ui.toast('Config changed in another tab — reload to load those changes.', 'warn');
    }
  });

  loadLibrary();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
