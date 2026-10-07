// Folder access and scanning. A "source" is something the user dropped or
// picked: a File System Access handle (Chromium, can be remembered between
// visits), a drag-and-drop entry (Safari/Firefox) or a plain file list.

import { parseAbleton } from './parsers/ableton.js';
import { parseFlStudio } from './parsers/flstudio.js';
import { AUDIO_EXT, extOf, soundKey } from './library.js';

const PROJECT_EXT = new Set(['als', 'flp']);
const SKIP_DIR = /^(backup|backups|__macosx|ableton project info|\$recycle\.bin|node_modules)$/i;

export const canPickHandles = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

let counter = 0;
const makeId = () => `s${Date.now().toString(36)}${counter++}`;
const tick = () => new Promise((resolve) => setTimeout(resolve));

function skipDir(name) {
  return name.startsWith('.') || SKIP_DIR.test(name);
}

// Autosaves and "overwritten at" copies would count the same song twice.
function isBackupProject(name) {
  return name.startsWith('._') || /\((overwritten at|autosave)/i.test(name);
}

export function handleSource(handle) {
  return { id: makeId(), label: handle.name, kind: 'handle', handle };
}

export function sourcesFromFileList(fileList) {
  const files = [...fileList];
  if (!files.length) return [];
  const first = files[0].webkitRelativePath || files[0].name;
  const label = first.includes('/') ? first.split('/')[0] : files.length === 1 ? files[0].name : `${files.length} Dateien`;
  return [{ id: makeId(), label, kind: 'files', files }];
}

export async function sourcesFromDrop(dataTransfer) {
  // Handles and entries must be requested synchronously inside the drop event.
  const pending = [...dataTransfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => {
      const entry = item.webkitGetAsEntry?.();
      const file = entry ? null : item.getAsFile();
      const handle = item.getAsFileSystemHandle?.().catch(() => null) ?? Promise.resolve(null);
      return handle.then((h) => {
        if (h) return handleSource(h);
        if (entry) return { id: makeId(), label: entry.name, kind: 'entry', entry };
        return file ? { id: makeId(), label: file.name, kind: 'files', files: [file] } : null;
      });
    });
  return (await Promise.all(pending)).filter(Boolean);
}

// startIn: one of the well-known folders (desktop, documents, downloads, music).
export async function pickDirectory(startIn) {
  const options = startIn ? { startIn, mode: 'read' } : { id: 'most-used-sounds', mode: 'read' };
  return handleSource(await window.showDirectoryPicker(options));
}

export async function ensurePermission(handle) {
  const opts = { mode: 'read' };
  if ((await handle.queryPermission?.(opts)) === 'granted') return true;
  return (await handle.requestPermission?.(opts)) === 'granted';
}

async function* walkHandle(handle, path) {
  if (handle.kind === 'file') {
    yield { name: handle.name, path, getFile: () => handle.getFile() };
    return;
  }
  for await (const child of handle.values()) {
    const childPath = `${path}/${child.name}`;
    if (child.kind === 'directory') {
      if (!skipDir(child.name)) yield* walkHandle(child, childPath);
    } else {
      yield { name: child.name, path: childPath, getFile: () => child.getFile() };
    }
  }
}

async function* walkEntry(entry, path) {
  if (entry.isFile) {
    yield { name: entry.name, path, getFile: () => new Promise((res, rej) => entry.file(res, rej)) };
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const child of batch) {
      if (child.isDirectory && skipDir(child.name)) continue;
      yield* walkEntry(child, `${path}/${child.name}`);
    }
  }
}

function* walkFiles(files) {
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (path.split('/').slice(1, -1).some(skipDir)) continue;
    yield { name: file.name, path, getFile: async () => file };
  }
}

function walk(source) {
  if (source.kind === 'handle') return walkHandle(source.handle, source.handle.name);
  if (source.kind === 'entry') return walkEntry(source.entry, source.entry.name);
  return walkFiles(source.files);
}

// Walks all sources, indexes audio files by name and parses every project.
export async function scanSources(sources, onProgress = () => {}) {
  const projectFiles = [];
  const audioIndex = new Map();
  let files = 0;
  let audio = 0;

  for (const source of sources) {
    for await (const item of walk(source)) {
      files++;
      const ext = extOf(item.name);
      if (PROJECT_EXT.has(ext)) {
        if (!isBackupProject(item.name)) projectFiles.push({ ...item, ext });
      } else if (AUDIO_EXT.has(ext) && !item.name.startsWith('._')) {
        const key = soundKey(item.name);
        if (!audioIndex.has(key)) audioIndex.set(key, []);
        audioIndex.get(key).push(item);
        audio++;
      }
      if (files % 300 === 0) {
        onProgress({ phase: 'walk', files, projects: projectFiles.length, audio });
        await tick();
      }
    }
  }

  const projects = [];
  const failed = [];
  const seen = new Set();
  for (let i = 0; i < projectFiles.length; i++) {
    const item = projectFiles[i];
    onProgress({ phase: 'parse', done: i, total: projectFiles.length });
    try {
      const file = await item.getFile();
      // The same project reachable twice (overlapping folders, copies) counts once.
      const fingerprint = `${file.name}|${file.size}|${file.lastModified}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const refs = item.ext === 'als' ? await parseAbleton(bytes) : parseFlStudio(bytes);
      projects.push({ name: file.name, path: item.path, type: item.ext, mtime: file.lastModified, refs, fingerprint });
    } catch (err) {
      failed.push({ path: item.path, error: err?.message ?? String(err) });
    }
    if (i % 3 === 0) await tick();
  }

  return { projects, audioIndex, failed, files, audio };
}

// Adds a scan of extra folders to an existing one (no need to re-read everything).
export function mergeScans(base, extra) {
  const known = new Set(base.projects.map((p) => p.fingerprint));
  const audioIndex = new Map(base.audioIndex);
  for (const [key, items] of extra.audioIndex) audioIndex.set(key, [...(audioIndex.get(key) ?? []), ...items]);
  return {
    projects: [...base.projects, ...extra.projects.filter((p) => !known.has(p.fingerprint))],
    audioIndex,
    failed: [...base.failed, ...extra.failed],
    files: base.files + extra.files,
    audio: base.audio + extra.audio,
  };
}
