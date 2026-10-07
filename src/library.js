// Turns parsed projects into a ranked list of sounds and picks the pack.

export const AUDIO_EXT = new Set(['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a']);

export const CATEGORIES = [
  { id: 'kick', label: 'Kicks', drum: true },
  { id: 'snare', label: 'Snares', drum: true },
  { id: 'clap', label: 'Claps & Snaps', drum: true },
  { id: 'hat', label: 'Hi-Hats', drum: true },
  { id: 'openhat', label: 'Open Hats', drum: true },
  { id: 'cymbal', label: 'Cymbals', drum: true },
  { id: 'perc', label: 'Percussion', drum: true },
  { id: '808', label: '808s', drum: true },
  { id: 'fx', label: 'FX', drum: false },
  { id: 'vocal', label: 'Vocals', drum: false },
  { id: 'loop', label: 'Loops', drum: false },
  { id: 'other', label: 'Sonstiges', drum: false },
];

// Order matters: the first rule that matches wins ("808 Snare" is a snare,
// "Hat Loop 140bpm" is a loop).
const RULES = [
  ['loop', /\b(loops?|bpm|\d{2,3} ?bpm)\b/],
  ['openhat', /\b(open ?hats?|open ?hh|hat open|oh|ohh|ohat)\b/],
  ['hat', /\b(hi ?hats?|hats?|hh|chh|closed ?hats?)\b/],
  ['snare', /\b(snares?|snr|sd)\b/],
  ['clap', /\b(claps?|clp|snaps?)\b/],
  ['kick', /\b(kicks?|kik|kck|bd|bass ?drum)\b/],
  ['cymbal', /\b(cymbals?|cym|crash(es)?|rides?|china|splash)\b/],
  ['perc', /\b(percs?|percussion|toms?|rims?|rimshot|shakers?|congas?|bongos?|tamb|tambourine|cowbell|clave|woodblock|triangle|guiro|cabasa|timbales?|djembe|tabla|knock|stick)\b/],
  ['808', /\b(808s?|subs?)\b/],
  ['fx', /\b(fx|sfx|riser|impact|sweep|uplifter|downlifter|whoosh|swoosh|noise|transition|reverse)\b/],
  ['vocal', /\b(vox|vocals?|voc|chant|adlib|phrase|voice)\b/],
];

// Folders DAWs write their own audio into (recordings, freezes, bounces) —
// those are not "sounds" anybody picked.
const GENERATED_DIR = /^(recorded|processed|freeze|consolidate|crop|reverse|rendered|bounced|bounces|resampled)$/i;

export function splitPath(path) {
  return path.replace(/\\/g, '/').split('/').filter(Boolean);
}

// File names are compared case-insensitively and Unicode-normalized (macOS
// stores "ü" decomposed, DAWs usually composed).
export function soundKey(name) {
  return name.normalize('NFC').toLowerCase();
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function words(text) {
  return text
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchRule(text) {
  const w = words(text);
  for (const [id, re] of RULES) if (re.test(w)) return id;
  return null;
}

// Looks at the file name first, then up to three parent folders ("Kicks/Hard 01.wav").
export function categorize(segments) {
  for (let i = segments.length - 1; i >= Math.max(0, segments.length - 4); i--) {
    const id = matchRule(segments[i]);
    if (id) return id;
  }
  return 'other';
}

export function isPickedSound(rawPath) {
  const segments = splitPath(rawPath);
  const name = segments.at(-1) ?? '';
  if (!AUDIO_EXT.has(extOf(name))) return false;
  if (/^freeze /i.test(name)) return false;
  return !segments.slice(0, -1).some((s) => GENERATED_DIR.test(s));
}

export function filterProjects(projects, range, now = Date.now()) {
  if (range === '12m') return projects.filter((p) => p.mtime >= now - 365 * 864e5);
  if (/^\d{4}$/.test(range)) return projects.filter((p) => new Date(p.mtime).getFullYear() === +range);
  return projects;
}

export function yearsOf(projects) {
  return [...new Set(projects.map((p) => new Date(p.mtime).getFullYear()))].sort((a, b) => b - a);
}

// One sound = one file name. Copies of the same sample (e.g. collected into a
// project folder) count as the same sound. Ranking is by the number of
// projects a sound appears in, then by total uses.
export function aggregate(projects) {
  const sounds = new Map();
  for (const project of projects) {
    const seen = new Set();
    for (const raw of project.refs) {
      if (!isPickedSound(raw)) continue;
      const segments = splitPath(raw);
      const name = segments.at(-1);
      const key = soundKey(name);
      let sound = sounds.get(key);
      if (!sound) {
        sound = { key, name, category: categorize(segments), refPaths: new Set(), projects: 0, uses: 0, lastUsed: 0 };
        sounds.set(key, sound);
      }
      sound.uses++;
      sound.refPaths.add(raw);
      if (!seen.has(key)) {
        seen.add(key);
        sound.projects++;
        sound.lastUsed = Math.max(sound.lastUsed, project.mtime);
      }
    }
  }
  return [...sounds.values()].sort(
    (a, b) => b.projects - a.projects || b.uses - a.uses || b.lastUsed - a.lastUsed || a.name.localeCompare(b.name),
  );
}

function sharedTail(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

// Finds the file on disk for a sound: same file name, and among several
// candidates the one whose folders match the referenced path best.
export function resolveSound(sound, audioIndex) {
  const candidates = audioIndex.get(sound.key);
  if (!candidates?.length) return null;
  if (candidates.length === 1) return candidates[0];
  const refs = [...sound.refPaths].map((p) => splitPath(soundKey(p)));
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const segs = splitPath(soundKey(c.path));
    for (const ref of refs) {
      const score = sharedTail(segs, ref);
      if (score > bestScore) [best, bestScore] = [c, score];
    }
  }
  return best;
}

// Fills every category with its top sounds that exist on disk. Excluded
// sounds stay listed (so they can be restored) but don't take a slot. Sounds
// that would have made the cut but weren't found are reported as missing.
export function buildSelection(sounds, { perCat, drumsOnly, excluded, resolve }) {
  const groups = new Map(CATEGORIES.map((c) => [c.id, { ...c, items: [], picked: 0 }]));
  const missing = [];
  for (const sound of sounds) {
    const group = groups.get(sound.category);
    if ((drumsOnly && !group.drum) || group.picked >= perCat) continue;
    const file = resolve(sound);
    if (!file) {
      missing.push(sound);
      continue;
    }
    const off = excluded.has(sound.key);
    group.items.push({ sound, file, excluded: off });
    if (!off) group.picked++;
  }
  return { groups: [...groups.values()].filter((g) => g.items.length), missing };
}

// Folder names that usually mark the root of a sample library.
const LIBRARY_DIR = /^(music|musik|samples?|packs?|sounds?|splice|kits?|drum ?kits?|loops?|producing|production)$/i;

function libraryRoot(raw) {
  if (/%FLStudioFactoryData%/i.test(raw)) return { id: 'fl-factory', path: '', factory: true };
  const segments = splitPath(raw);
  const dirs = segments.slice(0, -1);
  let end = dirs.findIndex((s) => /^user library$/i.test(s));
  if (end < 0) end = dirs.findIndex((s, i) => i >= 2 && LIBRARY_DIR.test(s));
  if (end < 0) end = Math.min(3, dirs.length - 1);
  const parts = dirs.slice(0, end + 1);
  const windows = /^[a-z]:/i.test(raw) || raw.includes('\\');
  const path = windows ? parts.join('\\') : (raw.startsWith('/') ? '/' : '') + parts.join('/');
  return { id: parts.join('/').toLowerCase(), path, factory: false };
}

// Groups sounds that weren't found by the library folder they live in, so the
// user can grant exactly those folders. Biggest groups first.
export function groupMissing(missing) {
  const groups = new Map();
  for (const sound of missing) {
    const root = libraryRoot([...sound.refPaths][0]);
    if (!groups.has(root.id)) groups.set(root.id, { ...root, count: 0, names: [] });
    const group = groups.get(root.id);
    group.count++;
    if (group.names.length < 3) group.names.push(sound.name);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// Projects per month, oldest first, for the activity chart.
export function monthlyActivity(projects, maxMonths = 48, now = Date.now()) {
  if (!projects.length) return [];
  const end = new Date(now);
  const first = new Date(Math.min(...projects.map((p) => p.mtime)));
  let span = (end.getFullYear() - first.getFullYear()) * 12 + end.getMonth() - first.getMonth() + 1;
  span = Math.max(1, Math.min(maxMonths, span));
  const months = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth(), start: d.getTime(), count: 0 });
  }
  const index = new Map(months.map((m) => [m.year * 12 + m.month, m]));
  for (const p of projects) {
    const d = new Date(p.mtime);
    const m = index.get(d.getFullYear() * 12 + d.getMonth());
    if (m) m.count++;
  }
  return months;
}
