import {
  canPickHandles,
  ensurePermission,
  handleSource,
  pickDirectory,
  scanSources,
  sourcesFromDrop,
  sourcesFromFileList,
} from './sources.js';
import { aggregate, buildSelection, filterProjects, resolveSound, yearsOf } from './library.js';
import { ZipWriter } from './zip.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const el = {
  pick: $('pick'), drop: $('drop'), dirInput: $('dirInput'), sources: $('sources'), scan: $('scan'),
  progress: $('progress'), progressText: $('progressText'), progressSub: $('progressSub'),
  results: $('results'), stats: $('stats'), range: $('range'), perCat: $('perCat'), perCatValue: $('perCatValue'),
  drumsOnly: $('drumsOnly'), packName: $('packName'), cats: $('cats'), missing: $('missing'),
  dock: $('dock'), dockInfo: $('dockInfo'), build: $('build'), toast: $('toast'),
};

const saved = store.loadSettings();
const state = {
  sources: [],
  scan: null,
  selection: null,
  busy: false,
  resolved: new Map(),
  settings: {
    range: saved.range ?? 'all',
    perCat: saved.perCat ?? 10,
    drumsOnly: saved.drumsOnly ?? true,
  },
  excluded: new Set(saved.excluded ?? []),
};

const nf = new Intl.NumberFormat('de-DE');
const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>';

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 3800);
}

function persistSettings() {
  store.saveSettings({ ...state.settings, excluded: [...state.excluded] });
}

function persistSources() {
  store.saveHandles(
    state.sources.filter((s) => s.kind === 'handle').map(({ id, label, handle }) => ({ id, label, handle })),
  );
}

/* ---------- sources ---------- */

async function addSources(list) {
  for (const source of list) {
    let duplicate = false;
    for (const existing of state.sources) {
      if (existing.kind === 'handle' && source.kind === 'handle') {
        duplicate = await existing.handle.isSameEntry(source.handle).catch(() => false);
      }
      if (duplicate) break;
    }
    if (!duplicate) state.sources.push(source);
  }
  persistSources();
  renderSources();
}

function renderSources() {
  el.sources.innerHTML = state.sources
    .map(
      (s) => `<li class="chip" title="${escapeHtml(s.label)}">${ICON_FOLDER}<span>${escapeHtml(s.label)}</span>` +
        `<button data-remove="${s.id}" aria-label="${escapeHtml(s.label)} entfernen">×</button></li>`,
    )
    .join('');
  el.scan.disabled = !state.sources.length || state.busy;
  el.scan.textContent = state.scan ? 'Neu scannen' : 'Scannen';
}

async function chooseFolder() {
  if (!canPickHandles) return el.dirInput.click();
  try {
    await addSources([await pickDirectory()]);
  } catch (err) {
    if (err?.name !== 'AbortError') el.dirInput.click();
  }
}

/* ---------- scanning ---------- */

async function startScan() {
  if (state.busy || !state.sources.length) return;
  // Ask for folder access first, while the click still counts as a user gesture.
  for (const s of state.sources) {
    if (s.kind === 'handle' && !(await ensurePermission(s.handle))) {
      toast(`Kein Zugriff auf „${s.label}“`);
      return;
    }
  }

  state.busy = true;
  renderSources();
  el.progress.hidden = false;
  el.results.hidden = true;
  el.dock.hidden = true;
  el.progressText.textContent = 'Durchsuche Ordner…';
  el.progressSub.textContent = '';

  try {
    state.scan = await scanSources(state.sources, (p) => {
      if (p.phase === 'walk') {
        el.progressText.textContent = 'Durchsuche Ordner…';
        el.progressSub.textContent = `${nf.format(p.files)} Dateien · ${nf.format(p.projects)} Projekte · ${nf.format(p.audio)} Samples`;
      } else {
        el.progressText.textContent = 'Lese Projekte…';
        el.progressSub.textContent = `${nf.format(p.done)} von ${nf.format(p.total)}`;
      }
    });
    state.resolved = new Map();
    const years = yearsOf(state.scan.projects).map(String);
    if (!['all', '12m', ...years].includes(state.settings.range)) state.settings.range = 'all';
    el.pick.classList.add('compact');
    el.results.hidden = false;
    renderResults();
  } catch (err) {
    console.error(err);
    toast('Scan fehlgeschlagen: ' + (err?.message ?? err));
  } finally {
    state.busy = false;
    el.progress.hidden = true;
    renderSources();
  }
}

/* ---------- results ---------- */

function rangeLabel(range) {
  if (range === 'all') return 'Alles';
  if (range === '12m') return '12 Monate';
  return range;
}

function defaultPackName() {
  const { range } = state.settings;
  if (range === 'all') return 'Most Used Sounds';
  if (range === '12m') {
    return `Most Used ${new Date().toLocaleDateString('de-DE', { month: 'short', year: 'numeric' })}`;
  }
  return `Most Used ${range}`;
}

function resolve(sound) {
  if (!state.resolved.has(sound.key)) state.resolved.set(sound.key, resolveSound(sound, state.scan.audioIndex));
  return state.resolved.get(sound.key);
}

function renderSettings() {
  const ranges = ['all', '12m', ...yearsOf(state.scan.projects).slice(0, 4).map(String)];
  el.range.innerHTML = ranges
    .map((r) => `<button role="radio" data-range="${r}" aria-checked="${r === state.settings.range}">${rangeLabel(r)}</button>`)
    .join('');
  el.perCat.value = state.settings.perCat;
  el.perCatValue.textContent = state.settings.perCat;
  el.perCat.style.setProperty('--fill', `${((state.settings.perCat - el.perCat.min) / (el.perCat.max - el.perCat.min)) * 100}%`);
  el.drumsOnly.checked = state.settings.drumsOnly;
  el.packName.placeholder = defaultPackName();
}

function renderResults() {
  renderSettings();
  const { scan, settings } = state;
  const projects = filterProjects(scan.projects, settings.range);
  const sounds = aggregate(projects);
  const selection = buildSelection(sounds, { ...settings, excluded: state.excluded, resolve });
  state.selection = selection;

  const picked = selection.groups.reduce((n, g) => n + g.picked, 0);
  const als = projects.filter((p) => p.type === 'als').length;
  const notes = [];
  if (projects.length) notes.push(`${nf.format(als)} Ableton · ${nf.format(projects.length - als)} FL Studio`);
  if (scan.failed.length) notes.push(`${nf.format(scan.failed.length)} Datei(en) nicht lesbar`);
  el.stats.innerHTML =
    `<div class="stat"><b>${nf.format(projects.length)}</b><span>Projekte</span></div>` +
    `<div class="stat"><b>${nf.format(sounds.length)}</b><span>Sounds benutzt</span></div>` +
    `<div class="stat"><b>${nf.format(picked)}</b><span>im Pack</span></div>` +
    (notes.length ? `<div class="note">${notes.join(' · ')}</div>` : '');

  if (!scan.projects.length) {
    el.cats.innerHTML = `<div class="glass card empty"><strong>Keine Projekte gefunden</strong>Füge den Ordner hinzu, in dem deine .flp- oder .als-Dateien liegen.</div>`;
  } else if (!selection.groups.length) {
    el.cats.innerHTML = `<div class="glass card empty"><strong>Nichts gefunden</strong>${
      projects.length ? 'Füge deine Sample-Ordner hinzu, damit die Sounds gefunden werden.' : 'In diesem Zeitraum gibt es keine Projekte.'
    }</div>`;
  } else {
    el.cats.innerHTML = selection.groups.map(renderGroup).join('');
  }

  renderMissing(selection.missing);
  el.dock.hidden = picked === 0;
  el.dockInfo.textContent = `${picked} Sounds · ${selection.groups.filter((g) => g.picked).length} Ordner`;
}

function renderGroup(group) {
  const max = Math.max(...group.items.map((i) => i.sound.projects));
  const rows = group.items
    .map(({ sound, excluded }) => {
      const width = Math.max(4, Math.round((sound.projects / max) * 100));
      const title = `${sound.projects} Projekte, ${sound.uses}× benutzt\n${[...sound.refPaths][0]}`;
      return `<li class="row${excluded ? ' off' : ''}" data-key="${escapeHtml(sound.key)}">
        <button class="icon-btn play" data-play aria-label="Anhören">${ICON_PLAY}</button>
        <div title="${escapeHtml(title)}"><div class="name">${escapeHtml(sound.name)}</div><div class="bar"><i style="width:${width}%"></i></div></div>
        <div class="count"><b>${sound.projects}</b> <span>${sound.projects === 1 ? 'Projekt' : 'Projekte'}</span></div>
        <button class="icon-btn toggle" data-toggle aria-label="${excluded ? 'Wieder aufnehmen' : 'Aus Pack entfernen'}">${excluded ? '+' : '−'}</button>
      </li>`;
    })
    .join('');
  return `<section class="glass card cat"><header><h2>${group.label}</h2><span>${group.picked}</span></header><ol class="rows">${rows}</ol></section>`;
}

function renderMissing(missing) {
  if (!missing.length) {
    el.missing.hidden = true;
    return;
  }
  const list = missing
    .slice(0, 6)
    .map((s) => `<li>${escapeHtml(s.name)} <small>— ${escapeHtml([...s.refPaths][0])}</small></li>`)
    .join('');
  el.missing.hidden = false;
  el.missing.innerHTML = `<h2>${missing.length === 1 ? '1 oft genutzter Sound' : `${missing.length} oft genutzte Sounds`} nicht gefunden</h2>
    <p>Die Projekte verweisen auf Samples, die in keinem deiner Ordner liegen. Füge den Ordner hinzu und scanne neu.
    FL-Studio-Factory-Samples liegen im Programmordner (…/Image-Line/FL Studio/Data/Patches/Packs).</p>
    <ul>${list}</ul>
    <div class="actions"><button class="link" data-add>Ordner hinzufügen</button><button class="link" data-classic>Geschützten Ordner wählen</button></div>`;
}

function findItem(key) {
  for (const g of state.selection.groups) for (const item of g.items) if (item.sound.key === key) return item;
  return null;
}

/* ---------- preview ---------- */

let player = null;
function stopPreview() {
  if (!player) return;
  player.audio.pause();
  URL.revokeObjectURL(player.url);
  player.button.classList.remove('playing');
  player.button.innerHTML = ICON_PLAY;
  player = null;
}

async function togglePreview(key, button) {
  const wasPlaying = player?.key === key;
  stopPreview();
  if (wasPlaying) return;
  const item = findItem(key);
  if (!item) return;
  try {
    const url = URL.createObjectURL(await item.file.getFile());
    const audio = new Audio(url);
    player = { key, url, audio, button };
    button.classList.add('playing');
    button.innerHTML = ICON_STOP;
    audio.onended = stopPreview;
    await audio.play();
  } catch {
    stopPreview();
    toast('Dieses Format kann der Browser nicht abspielen');
  }
}

/* ---------- pack ---------- */

function safeName(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Pack';
}

async function buildPack() {
  if (state.busy || !state.selection) return;
  state.busy = true;
  el.build.disabled = true;
  const label = el.build.textContent;
  const packName = safeName(el.packName.value || defaultPackName());
  const groups = state.selection.groups.filter((g) => g.picked);
  const total = groups.reduce((n, g) => n + g.picked, 0);
  const zip = new ZipWriter();
  const report = [
    packName,
    `Erstellt am ${new Date().toLocaleDateString('de-DE')} · Zeitraum: ${rangeLabel(state.settings.range)}`,
    'Rangfolge = in wie vielen Projekten der Sound vorkommt.',
  ];
  let done = 0;
  let skipped = 0;

  try {
    for (const [gi, group] of groups.entries()) {
      const folder = `${String(gi + 1).padStart(2, '0')} ${safeName(group.label)}`;
      report.push('', `== ${group.label} ==`);
      let rank = 0;
      for (const { sound, file, excluded } of group.items) {
        if (excluded) continue;
        el.build.textContent = `${++done} / ${total}`;
        try {
          const blob = await file.getFile();
          rank++;
          const data = new Uint8Array(await blob.arrayBuffer());
          zip.add(`${packName}/${folder}/${String(rank).padStart(2, '0')} ${safeName(sound.name)}`, data, new Date(blob.lastModified));
          report.push(`${String(rank).padStart(2, '0')}  ${sound.name}  —  ${sound.projects} ${sound.projects === 1 ? 'Projekt' : 'Projekte'}, ${sound.uses}× benutzt`);
        } catch {
          skipped++;
        }
      }
    }
    zip.add(`${packName}/Most Used Sounds.txt`, new TextEncoder().encode(report.join('\n') + '\n'));
    const url = URL.createObjectURL(zip.finish());
    const a = Object.assign(document.createElement('a'), { href: url, download: `${packName}.zip` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(skipped ? `Pack erstellt · ${skipped} Datei(en) nicht lesbar` : 'Pack erstellt ✓');
  } catch (err) {
    console.error(err);
    toast('Pack konnte nicht erstellt werden: ' + (err?.message ?? err));
  } finally {
    state.busy = false;
    el.build.disabled = false;
    el.build.textContent = label;
  }
}

/* ---------- events ---------- */

el.drop.addEventListener('click', chooseFolder);
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    chooseFolder();
  }
});
el.dirInput.addEventListener('change', async () => {
  await addSources(sourcesFromFileList(el.dirInput.files));
  el.dirInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (dragDepth++ === 0) el.drop.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    el.drop.classList.remove('dragging');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.drop.classList.remove('dragging');
  if (state.busy) return;
  const sources = await sourcesFromDrop(e.dataTransfer);
  if (sources.length) await addSources(sources);
});

el.sources.addEventListener('click', (e) => {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if (!id || state.busy) return;
  state.sources = state.sources.filter((s) => s.id !== id);
  persistSources();
  renderSources();
});

el.scan.addEventListener('click', startScan);
el.build.addEventListener('click', buildPack);

el.range.addEventListener('click', (e) => {
  const range = e.target.closest('[data-range]')?.dataset.range;
  if (!range) return;
  state.settings.range = range;
  persistSettings();
  renderResults();
});
el.perCat.addEventListener('input', () => {
  state.settings.perCat = +el.perCat.value;
  persistSettings();
  renderResults();
});
el.drumsOnly.addEventListener('change', () => {
  state.settings.drumsOnly = el.drumsOnly.checked;
  persistSettings();
  renderResults();
});

el.cats.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const key = row.dataset.key;
  if (e.target.closest('[data-play]')) return togglePreview(key, e.target.closest('[data-play]'));
  if (e.target.closest('[data-toggle]')) {
    if (state.excluded.has(key)) state.excluded.delete(key);
    else state.excluded.add(key);
    persistSettings();
    stopPreview();
    renderResults();
  }
});

el.missing.addEventListener('click', (e) => {
  if (e.target.closest('[data-add]')) chooseFolder();
  if (e.target.closest('[data-classic]')) el.dirInput.click();
});

/* ---------- start ---------- */

(async () => {
  if (canPickHandles) {
    const remembered = await store.loadHandles();
    state.sources = remembered.filter((s) => s.handle).map((s) => ({ ...handleSource(s.handle), id: s.id }));
  }
  renderSources();
})();
