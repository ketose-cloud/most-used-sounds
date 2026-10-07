import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipWriter, crc32 } from '../src/zip.js';

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('ZipWriter output opens with a standard unzip implementation', async () => {
  const zip = new ZipWriter();
  zip.add('Pack/01 Kicks/01 Kick ä.wav', new Uint8Array([1, 2, 3, 4]), new Date(2025, 4, 6, 7, 8, 10));
  zip.add('Pack/readme.txt', new TextEncoder().encode('hallo\n'));
  const file = join(mkdtempSync(join(tmpdir(), 'zip-')), 'pack.zip');
  writeFileSync(file, Buffer.from(await zip.finish().arrayBuffer()));

  const script = `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for i in z.infolist(): print(f"{i.filename}|{i.file_size}|{i.date_time}")
print(z.read("Pack/readme.txt").decode().strip())`;
  const out = execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(out[0], 'Pack/01 Kicks/01 Kick ä.wav|4|(2025, 5, 6, 7, 8, 10)');
  assert.match(out[1], /^Pack\/readme\.txt\|6\|/);
  assert.equal(out[2], 'hallo');
});
