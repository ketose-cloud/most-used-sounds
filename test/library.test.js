import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, buildSelection, categorize, filterProjects, groupMissing, monthlyActivity, resolveSound, splitPath } from '../src/library.js';

const cat = (path) => categorize(splitPath(path));

test('categorize: file names', () => {
  assert.equal(cat('KSHMR_Kick_01.wav'), 'kick');
  assert.equal(cat('BigKick.wav'), 'kick');
  assert.equal(cat('808 Snare Tight.wav'), 'snare');
  assert.equal(cat('Open Hat 3.wav'), 'openhat');
  assert.equal(cat('OH_Dusty.wav'), 'openhat');
  assert.equal(cat('HH_closed_02.wav'), 'hat');
  assert.equal(cat('Clap Layer.wav'), 'clap');
  assert.equal(cat('Rimshot.wav'), 'perc');
  assert.equal(cat('808 Mafia Bass.wav'), '808');
  assert.equal(cat('Hat Loop 140bpm.wav'), 'loop');
  assert.equal(cat('Crash 2.aif'), 'cymbal');
  assert.equal(cat('Riser Long.wav'), 'fx');
  assert.equal(cat('Mystery Sound.wav'), 'other');
});

test('categorize: falls back to folder names', () => {
  assert.equal(cat('C:\\Packs\\Drums\\Kicks\\Hard 01.wav'), 'kick');
  assert.equal(cat('/Users/me/Snares/One/Thing.wav'), 'snare');
});

const day = 864e5;
const projects = [
  { type: 'flp', mtime: Date.UTC(2025, 3, 1), refs: ['C:\\S\\Kicks\\Kick A.wav', 'C:\\S\\Kicks\\Kick A.wav', 'C:\\S\\Snare B.wav'] },
  { type: 'als', mtime: Date.UTC(2025, 5, 1), refs: ['/Users/me/S/Kicks/Kick A.wav', '/x/Kick C.wav', '/x/Samples/Recorded/Audio 1.wav'] },
  { type: 'als', mtime: Date.UTC(2023, 5, 1), refs: ['/x/Kick C.wav', '/x/Kick C.wav', '/x/Samples/Processed/Freeze/Freeze Kick.wav', '/x/readme.txt'] },
];

test('aggregate: ranks by number of projects, counts copies once per project', () => {
  const sounds = aggregate(projects);
  assert.deepEqual(
    sounds.map((s) => [s.name, s.projects, s.uses]),
    [
      ['Kick A.wav', 2, 3],
      ['Kick C.wav', 2, 3],
      ['Snare B.wav', 1, 1],
    ],
  );
});

test('filterProjects: by year and last 12 months', () => {
  assert.equal(filterProjects(projects, '2025').length, 2);
  assert.equal(filterProjects(projects, '2023').length, 1);
  assert.equal(filterProjects(projects, '12m', Date.UTC(2026, 0, 1)).length, 2);
  assert.equal(filterProjects(projects, '12m', Date.UTC(2026, 0, 1) + 300 * day).length, 0);
  assert.equal(filterProjects(projects, 'all').length, 3);
});

test('resolveSound: prefers the candidate with matching folders', () => {
  const [kickA] = aggregate(projects);
  const index = new Map([
    ['kick a.wav', [{ path: 'Music/Other/Kick A.wav' }, { path: 'Music/S/Kicks/Kick A.wav' }]],
  ]);
  assert.equal(resolveSound(kickA, index).path, 'Music/S/Kicks/Kick A.wav');
  assert.equal(resolveSound({ key: 'nope.wav', refPaths: new Set() }, index), null);
});

test('buildSelection: fills categories with found sounds, reports missing', () => {
  const sounds = aggregate(projects);
  const found = new Set(['kick c.wav', 'snare b.wav']);
  const sel = buildSelection(sounds, {
    perCat: 1,
    drumsOnly: true,
    excluded: new Set(),
    resolve: (s) => (found.has(s.key) ? { path: s.key } : null),
  });
  assert.deepEqual(
    sel.groups.map((g) => [g.id, g.items.map((i) => i.sound.name)]),
    [
      ['kick', ['Kick C.wav']],
      ['snare', ['Snare B.wav']],
    ],
  );
  assert.deepEqual(sel.missing.map((s) => s.name), ['Kick A.wav']);
});

test('buildSelection: excluded sounds stay listed but free their slot', () => {
  const sounds = aggregate(projects);
  const sel = buildSelection(sounds, {
    perCat: 1,
    drumsOnly: true,
    excluded: new Set(['kick a.wav']),
    resolve: (s) => ({ path: s.key }),
  });
  const kicks = sel.groups.find((g) => g.id === 'kick');
  assert.deepEqual(kicks.items.map((i) => [i.sound.name, i.excluded]), [
    ['Kick A.wav', true],
    ['Kick C.wav', false],
  ]);
  assert.equal(kicks.picked, 1);
});

test('aggregate: matches names regardless of Unicode normalization and case', () => {
  const nfd = 'Kick Ü.wav'.normalize('NFD');
  const sounds = aggregate([
    { type: 'als', mtime: 1, refs: [`/a/${nfd}`] },
    { type: 'flp', mtime: 2, refs: ['C:\\b\\KICK Ü.WAV'.normalize('NFC')] },
  ]);
  assert.equal(sounds.length, 1);
  assert.equal(sounds[0].projects, 2);
});

test('groupMissing: groups by library root, FL factory separately', () => {
  const s = (path) => ({ name: path.split(/[\\/]/).at(-1), refPaths: new Set([path]) });
  const groups = groupMissing([
    s('/Users/gp/Desktop/MUSIC/Packs/2022 Sauce Kit/OPEN HATS/oh.wav'),
    s('/Users/gp/Desktop/MUSIC/Packs/Other/kick.wav'),
    s('%FLStudioFactoryData%\\Data\\Patches\\Packs\\Legacy\\Drums\\Dance\\Basic 808 Clap.wav'),
    s('/Users/gp/Music/Ableton/User Library/Samples/Imported/808.wav'),
    s('C:\\Users\\gp\\Documents\\Samples\\Snare.wav'),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.path, g.count, g.factory]),
    [
      ['/Users/gp/Desktop/MUSIC', 2, false],
      ['', 1, true],
      ['/Users/gp/Music/Ableton/User Library', 1, false],
      ['C:\\Users\\gp\\Documents\\Samples', 1, false],
    ],
  );
});

test('monthlyActivity: counts projects per month up to now', () => {
  const now = new Date(2026, 9, 15).getTime();
  const months = monthlyActivity(
    [{ mtime: new Date(2026, 7, 3).getTime() }, { mtime: new Date(2026, 7, 20).getTime() }, { mtime: new Date(2026, 9, 1).getTime() }],
    48,
    now,
  );
  assert.deepEqual(months.map((m) => [m.month, m.count]), [[7, 2], [8, 0], [9, 1]]);
});
