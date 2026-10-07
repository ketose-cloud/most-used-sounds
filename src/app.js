import {
  canPickHandles,
  ensurePermission,
  handleSource,
  mergeScans,
  pickDirectory,
  scanSources,
  sourcesFromDrop,
  sourcesFromFileList,
} from './sources.js';
import {
  CATEGORIES,
  aggregate,
  buildSelection,
  filterProjects,
  groupMissing,
  monthlyActivity,
  resolveSound,
  yearsOf,
} from './library.js';
import { ZipWriter } from './zip.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const el = {
  intro: $('intro'), pick: $('pick'), drop: $('drop'), dirInput: $('dirInput'), sources: $('sources'), scan: $('scan'),
  progress: $('progress'), progressLabel: $('progressLabel'), progressNumber: $('progressNumber'), progressSub: $('progressSub'),
  results: $('results'), sourcesCompact: $('sourcesCompact'), addMore: $('addMore'), rescan: $('rescan'),
  stats: $('stats'), chart: $('chart'), rangeCount: $('rangeCount'), range: $('range'), mix: $('mix'),
  perCat: $('perCat'), perCatValue: $('perCatValue'), drumsOnly: $('drumsOnly'), packName: $('packName'),
  cats: $('cats'), missing: $('missing'), dock: $('dock'), dockCount: $('dockCount'), dockSub: $('dockSub'),
  build: $('build'), toast: $('toast'),
};

const saved = store.loadSettings();
const state = {
  sources: [],
  scan: null,
  selection: null,
  missingGroups: [],
  busy: false,
  resolved: new Map(),
  settings: {
    range: saved.range ?? 'all',
    perCat: saved.perCat ?? 10,
    drumsOnly: saved.drumsOnly ?? true,
  },
  excluded: new Set(saved.excluded ?? []),
};

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const nf = new Intl.NumberFormat('de-DE');
const COLORS = {
  kick: '#ff7ab6', snare: '#7c9cff', clap: '#ffc46b', hat: '#2ef2c2', openhat: '#a78bfa', cymbal: '#93c5fd',
  perc: '#fb923c', 808: '#e879f9', fx: '#60a5fa', vocal: '#fda4af', loop: '#34d399', other: '#94a3b8',
};
const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>';
const ICON_WAVE = '<svg viewBox="0 0 24 24"><path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4"/></svg>';

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 4200);
}

function persistSettings() {
  store.saveSettings({ ...state.settings, excluded: [...state.excluded] });
}

function persistSources() {
  store.saveHandles(
    state.sources.filter((s) => s.kind === 'handle').map(({ id, label, handle }) => ({ id, label, handle })),
  );
}

function showView(view) {
  el.intro.hidden = view !== 'start';
  el.pick.hidden = view !== 'start';
  el.progress.hidden = view !== 'scanning';
  el.results.hidden = view !== 'results';
  if (view !== 'results') el.dock.hidden = true;
}

/* ---------- sources ---------- */

async function addSources(list) {
  const added = [];
  for (const source of list) {
    let duplicate = false;
    for (const existing of state.sources) {
      if (existing.kind === 'handle' && source.kind === 'handle') {
        duplicate = await existing.handle.isSameEntry(source.handle).catch(() => false);
      }
      if (duplicate) break;
    }
    if (!duplicate) {
      state.sources.push(source);
      added.push(source);
    }
  }
  persistSources();
  renderSources();
  // After the first scan, new folders are indexed on their own — no full rescan.
  if (state.scan && added.length) await scanMore(added);
}

function renderSources() {
  const chips = state.sources
    .map(
      (s) => `<li class="chip" title="${escapeHtml(s.label)}">${ICON_FOLDER}<span>${escapeHtml(s.label)}</span>` +
        `<button data-remove="${s.id}" aria-label="${escapeHtml(s.label)} entfernen">×</button></li>`,
    )
    .join('');
  el.sources.innerHTML = chips;
  el.sourcesCompact.innerHTML = chips;
  el.scan.disabled = !state.sources.length || state.busy;
  el.rescan.disabled = !state.sources.length || state.busy;
}

async function chooseFolder(startIn) {
  if (!canPickHandles) return el.dirInput.click();
  try {
    await addSources([await pickDirectory(startIn)]);
  } catch (err) {
    if (err?.name !== 'AbortError') el.dirInput.click();
  }
}

/* ---------- scanning ---------- */

function onProgress(p) {
  if (p.phase === 'walk') {
    el.progressLabel.textContent = '// Durchsuche Ordner';
    el.progressNumber.textContent = nf.format(p.files);
    el.progressSub.textContent = `Dateien · ${nf.format(p.projects)} Projekte · ${nf.format(p.audio)} Samples`;
  } else {
    el.progressLabel.textContent = '// Lese Projekte';
    el.progressNumber.textContent = nf.format(p.done);
    el.progressSub.textContent = `von ${nf.format(p.total)} Projekten`;
  }
}

async function withScan(sources, apply) {
  if (state.busy || !sources.length) return;
  // Ask for folder access first, while the click still counts as a user gesture.
  for (const s of sources) {
    if (s.kind === 'handle' && !(await ensurePermission(s.handle))) {
      toast(`Kein Zugriff auf „${s.label}“`);
      return;
    }
  }
  state.busy = true;
  stopPreview();
  renderSources();
  const previous = state.scan ? 'results' : 'start';
  el.progressLabel.textContent = '// Durchsuche Ordner';
  el.progressNumber.textContent = '0';
  el.progressSub.textContent = '';
  showView('scanning');
  try {
    apply(await scanSources(sources, onProgress));
    state.resolved = new Map();
    const ranges = ['all', '12m', ...yearsOf(state.scan.projects).map(String)];
    if (!ranges.includes(state.settings.range)) state.settings.range = 'all';
    showView('results');
    renderResults();
  } catch (err) {
    console.error(err);
    toast('Scan fehlgeschlagen: ' + (err?.message ?? err));
    showView(previous);
  } finally {
    state.busy = false;
    renderSources();
  }
}

const startScan = () => withScan(state.sources, (scan) => (state.scan = scan));
const scanMore = (sources) => withScan(sources, (scan) => (state.scan = mergeScans(state.scan, scan)));

/* ---------- results ---------- */

function rangeLabel(range) {
  if (range === 'all') return 'Alles';
  if (range === '12m') return '12 Monate';
  return range;
}

function defaultPackName() {
  const { range } = state.settings;
  if (range === 'all') return 'Most Used Sounds';
  if (range === '12m') return `Most Used ${new Date().toLocaleDateString('de-DE', { month: 'short', year: 'numeric' })}`;
  return `Most Used ${range}`;
}

function resolve(sound) {
  if (!state.resolved.has(sound.key)) state.resolved.set(sound.key, resolveSound(sound, state.scan.audioIndex));
  return state.resolved.get(sound.key);
}

function renderResults() {
  const { scan, settings } = state;
  const projects = filterProjects(scan.projects, settings.range);
  const sounds = aggregate(projects);
  const selection = buildSelection(sounds, { ...settings, excluded: state.excluded, resolve });
  state.selection = selection;

  const picked = selection.groups.reduce((n, g) => n + g.picked, 0);
  const found = selection.groups.reduce((n, g) => n + g.items.length, 0);
  const foundShare = found + selection.missing.length ? found / (found + selection.missing.length) : 1;

  el.stats.innerHTML = [
    stat('Projekte', nf.format(projects.length), scan.projects.length ? projects.length / scan.projects.length : 0, 'var(--mint)'),
    stat('Sounds benutzt', nf.format(sounds.length), 1, 'var(--blue)'),
    stat('Gefunden', `${Math.round(foundShare * 100)} %`, foundShare, foundShare < 0.6 ? 'var(--amber)' : 'var(--pink)'),
  ].join('');

  renderSettings();
  el.rangeCount.textContent = nf.format(projects.length);
  el.chart.innerHTML = activityChart(monthlyActivity(scan.projects), settings.range);
  el.mix.innerHTML = soundMix(sounds);
  renderMissing(selection.missing);

  if (!scan.projects.length) {
    el.cats.innerHTML = `<div class="card empty"><strong>Keine Projekte gefunden</strong>Füge den Ordner hinzu, in dem deine .flp- oder .als-Dateien liegen.</div>`;
  } else if (!selection.groups.length) {
    el.cats.innerHTML = `<div class="card empty"><strong>Noch nichts im Pack</strong>${
      projects.length ? 'Gib oben die fehlenden Sample-Ordner frei.' : 'In diesem Zeitraum gibt es keine Projekte.'
    }</div>`;
  } else {
    el.cats.innerHTML = selection.groups.map(renderGroup).join('');
  }

  el.dock.hidden = picked === 0;
  el.dockCount.textContent = picked;
  el.dockSub.textContent = `Sounds · ${selection.groups.filter((g) => g.picked).length} Ordner`;
}

function stat(label, value, fill, color) {
  return `<div class="card stat" style="--c:${color}"><div class="stat-label">${label}</div>` +
    `<div class="stat-value">${value}</div><div class="stat-bar"><i style="width:${Math.max(2, Math.round(fill * 100))}%"></i></div></div>`;
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

/* ---------- charts ---------- */

function smoothPath(points, floor) {
  if (points.length === 1) return `M${points[0][0] - 1},${points[0][1]} L${points[0][0] + 1},${points[0][1]}`;
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [points[i - 1] ?? points[i], points[i], points[i + 1], points[i + 2] ?? points[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, Math.min(floor, p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, Math.min(floor, p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

function inRange(month, range, now = new Date()) {
  if (range === 'all') return false;
  if (range === '12m') return (now.getFullYear() - month.year) * 12 + now.getMonth() - month.month < 12;
  return String(month.year) === range;
}

function activityChart(months, range) {
  if (!months.length) return '';
  const W = 640, H = 190, top = 20, floor = 160;
  // A 3-month moving average keeps the curve readable when single months spike.
  const values = months.map((_, i) => {
    const near = months.slice(Math.max(0, i - 1), i + 2);
    return near.reduce((n, m) => n + m.count, 0) / near.length;
  });
  const peakValue = Math.max(...values);
  const max = peakValue || 1;
  const step = months.length > 1 ? W / (months.length - 1) : 0;
  const x = (i) => (months.length > 1 ? i * step : W / 2);
  const points = values.map((v, i) => [Math.round(x(i) * 10) / 10, Math.round((floor - (v / max) * (floor - top)) * 10) / 10]);
  const line = smoothPath(points, floor);
  const area = `${line} L${points.at(-1)[0]},${floor} L${points[0][0]},${floor} Z`;

  const selected = months.map((m, i) => (inRange(m, range) ? i : -1)).filter((i) => i >= 0);
  let band = '';
  if (selected.length) {
    const x0 = Math.max(0, x(selected[0]) - step / 2);
    const x1 = Math.min(W, x(selected.at(-1)) + step / 2);
    band = `<rect class="band" x="${x0}" y="0" width="${x1 - x0}" height="${floor}" rx="10"/>` +
      `<line class="band-edge" x1="${x0}" x2="${x0}" y1="0" y2="${floor}"/><line class="band-edge" x1="${x1}" x2="${x1}" y1="0" y2="${floor}"/>`;
  }

  const short = months.length <= 14;
  const labels = months
    .map((m, i) => {
      const show = short ? i % 2 === 0 : m.month === 0;
      if (!show) return '';
      const text = short ? new Date(m.year, m.month).toLocaleDateString('de-DE', { month: 'short' }) : m.year;
      const anchor = i === 0 ? 'start' : i === months.length - 1 ? 'end' : 'middle';
      return `<text class="axis" x="${x(i)}" y="${H - 4}" text-anchor="${anchor}">${text}</text>`;
    })
    .join('');

  const peak = values.indexOf(peakValue);
  const grid = [0.33, 0.66].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${floor - f * (floor - top)}" y2="${floor - f * (floor - top)}"/>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Projekte pro Monat">
    <defs>
      <linearGradient id="curveStroke" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#7c9cff"/><stop offset="0.55" stop-color="#ff7ab6"/><stop offset="1" stop-color="#2ef2c2"/></linearGradient>
      <linearGradient id="curveFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff7ab6" stop-opacity="0.32"/><stop offset="1" stop-color="#ff7ab6" stop-opacity="0"/></linearGradient>
    </defs>
    ${grid}${band}
    <path class="area" d="${area}"/>
    <path class="curve" d="${line}"/>
    <circle class="peak" cx="${points[peak][0]}" cy="${points[peak][1]}" r="4.5"/>
    ${labels}
  </svg>`;
}

function soundMix(sounds) {
  const uses = new Map();
  let total = 0;
  for (const s of sounds) {
    const cat = CATEGORIES.find((c) => c.id === s.category);
    if (s.category === 'other' || (state.settings.drumsOnly && !cat.drum)) continue;
    uses.set(s.category, (uses.get(s.category) ?? 0) + s.uses);
    total += s.uses;
  }
  if (!total) return '<p class="muted">Noch keine Daten.</p>';
  const top = [...uses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const radii = [70, 54, 38];
  const rings = top
    .map(([id, n], i) => {
      const r = radii[i];
      const c = 2 * Math.PI * r;
      const len = Math.max(0.02, n / total) * c;
      return `<circle class="track" cx="85" cy="85" r="${r}"/>` +
        `<circle class="arc" style="--c:${COLORS[id]}" cx="85" cy="85" r="${r}" stroke-dasharray="${len.toFixed(1)} ${c.toFixed(1)}"/>`;
    })
    .join('');
  const legend = top
    .map(([id, n]) => {
      const label = CATEGORIES.find((c) => c.id === id).label;
      const pct = Math.round((n / total) * 100);
      return `<div class="legend-row" style="--c:${COLORS[id]}"><span>${label}</span><b>${pct} % · ${nf.format(n)}×</b>` +
        `<div class="bar"><i style="width:${Math.max(3, pct)}%"></i></div></div>`;
    })
    .join('');
  return `<svg class="mix-rings" viewBox="0 0 170 170" aria-hidden="true">${rings}</svg><div class="legend">${legend}</div>`;
}

/* ---------- categories ---------- */

function renderGroup(group) {
  const color = COLORS[group.id];
  const max = Math.max(...group.items.map((i) => i.sound.projects));
  const rows = group.items
    .map(({ sound, excluded }) => {
      const width = Math.max(4, Math.round((sound.projects / max) * 100));
      const title = `${sound.projects} Projekte, ${sound.uses}× benutzt\n${[...sound.refPaths][0]}`;
      return `<li class="row${excluded ? ' off' : ''}" data-key="${escapeHtml(sound.key)}">
        <button class="icon-btn" data-play aria-label="Anhören">${ICON_PLAY}</button>
        <div title="${escapeHtml(title)}"><div class="name">${escapeHtml(sound.name)}</div><div class="bar"><i style="width:${width}%"></i></div></div>
        <div class="count"><b>${sound.projects}</b><span>${sound.projects === 1 ? 'Projekt' : 'Projekte'}</span></div>
        <button class="icon-btn toggle" data-toggle aria-label="${excluded ? 'Wieder aufnehmen' : 'Aus Pack entfernen'}">${excluded ? '+' : '−'}</button>
      </li>`;
    })
    .join('');
  return `<article class="card cat" style="--c:${color}">
    <header class="card-head"><span class="badge">${ICON_WAVE}</span><h2>${group.label}</h2>
    <div class="head-value"><b>${group.picked}</b><span>Sounds</span></div></header>
    <ol class="rows">${rows}</ol></article>`;
}

/* ---------- missing folders ---------- */

function wellKnownFolder(path) {
  const p = path.toLowerCase();
  if (/[\\/]desktop([\\/]|$)/.test(p)) return 'desktop';
  if (/[\\/](documents|dokumente)([\\/]|$)/.test(p)) return 'documents';
  if (/[\\/]downloads([\\/]|$)/.test(p)) return 'downloads';
  if (/[\\/](music|musik)([\\/]|$)/.test(p)) return 'music';
  return undefined;
}

function renderMissing(missing) {
  state.missingGroups = groupMissing(missing);
  if (!missing.length) {
    el.missing.hidden = true;
    return;
  }
  const rows = state.missingGroups
    .slice(0, 6)
    .map((g, i) => {
      return `<li class="folder">
        <div class="folder-count"><b>${nf.format(g.count)}</b><span>Sounds</span></div>
        <div><div class="folder-path">${escapeHtml(g.path || 'Unbekannter Ort')}</div><div class="folder-sub">z. B. ${g.names.map(escapeHtml).join(', ')}</div></div>
        <div class="folder-actions">
          ${g.path ? `<button class="btn ghost small" data-copy="${i}">Pfad kopieren</button>` : ''}
          <button class="btn mint small" data-grant="${i}">Freigeben</button>
        </div>
      </li>`;
    })
    .join('');
  const more = state.missingGroups.length > 6 ? `<p class="tip">+ ${state.missingGroups.length - 6} weitere Orte</p>` : '';
  const tip = isMac
    ? 'Tipp: Pfad kopieren, dann im Auswahlfenster <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>G</kbd> drücken und einfügen. Ordner aus dem Finder kannst du auch einfach auf die Seite ziehen.'
    : 'Tipp: Pfad kopieren und im Auswahlfenster in die Adresszeile einfügen. Ordner kannst du auch einfach auf die Seite ziehen.';
  el.missing.hidden = false;
  el.missing.innerHTML = `<p class="eyebrow">// Fehlende Sample-Ordner</p>
    <h2>${nf.format(missing.length)} ${missing.length === 1 ? 'Sound liegt' : 'Sounds liegen'} in Ordnern, die die App noch nicht sehen darf.</h2>
    <p>Deine Projekte verweisen auf diese Orte. Gib sie frei – es werden nur die Samples eingelesen, kein kompletter Neu-Scan.</p>
    <ul class="folders">${rows}</ul>${more}<p class="tip">${tip}</p>`;
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    toast(isMac ? 'Pfad kopiert – im Auswahlfenster ⌘⇧G drücken und einfügen' : 'Pfad kopiert – im Auswahlfenster einfügen');
  } catch {
    toast(path);
  }
}

function grantFolder(group) {
  return chooseFolder(wellKnownFolder(group.path));
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

function findItem(key) {
  for (const g of state.selection.groups) for (const item of g.items) if (item.sound.key === key) return item;
  return null;
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
  const label = el.build.innerHTML;
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
    el.build.innerHTML = label;
  }
}

/* ---------- events ---------- */

el.drop.addEventListener('click', () => chooseFolder());
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    chooseFolder();
  }
});
el.addMore.addEventListener('click', () => chooseFolder());
el.dirInput.addEventListener('change', async () => {
  const sources = sourcesFromFileList(el.dirInput.files);
  el.dirInput.value = '';
  await addSources(sources);
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

function onRemoveSource(e) {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if (!id || state.busy) return;
  state.sources = state.sources.filter((s) => s.id !== id);
  persistSources();
  renderSources();
}
el.sources.addEventListener('click', onRemoveSource);
el.sourcesCompact.addEventListener('click', onRemoveSource);

el.scan.addEventListener('click', startScan);
el.rescan.addEventListener('click', startScan);
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
  const play = e.target.closest('[data-play]');
  if (play) return togglePreview(key, play);
  if (e.target.closest('[data-toggle]')) {
    if (state.excluded.has(key)) state.excluded.delete(key);
    else state.excluded.add(key);
    persistSettings();
    stopPreview();
    renderResults();
  }
});

el.missing.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  const grant = e.target.closest('[data-grant]');
  if (copy) copyPath(state.missingGroups[+copy.dataset.copy].path);
  if (grant) grantFolder(state.missingGroups[+grant.dataset.grant]);
});

/* ---------- start ---------- */

(async () => {
  if (canPickHandles) {
    const remembered = await store.loadHandles();
    state.sources = remembered.filter((s) => s.handle).map((s) => ({ ...handleSource(s.handle), id: s.id }));
  }
  renderSources();
  showView('start');
})();
