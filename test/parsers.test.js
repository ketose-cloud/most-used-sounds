import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseFlStudio } from '../src/parsers/flstudio.js';
import { parseAbleton, extractAbletonSamples } from '../src/parsers/ableton.js';

// --- FL Studio fixtures ---------------------------------------------------

function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function textEvent(id, bytes) {
  return [id, ...varint(bytes.length), ...bytes];
}

const utf16 = (s) => [...Buffer.from(s + '\0', 'utf16le')];
const ascii = (s) => [...Buffer.from(s + '\0', 'latin1')];

function flp(events) {
  const data = events.flat();
  const header = Buffer.alloc(14);
  header.write('FLhd', 0, 'ascii');
  header.writeUInt32LE(6, 4);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(3, 10);
  header.writeUInt16LE(96, 12);
  const dt = Buffer.alloc(8);
  dt.write('FLdt', 0, 'ascii');
  dt.writeUInt32LE(data.length, 4);
  return new Uint8Array(Buffer.concat([header, dt, Buffer.from(data)]));
}

test('FL Studio 20+: reads UTF-16 sample paths and skips other events', () => {
  const bytes = flp([
    textEvent(199, ascii('20.8.4.2576')),
    [64, 0x01, 0x00], // word event
    [128, 1, 2, 3, 4], // dword event
    [10, 5], // byte event
    textEvent(196, utf16('C:\\Samples\\Drums\\Kick Hard.wav')),
    textEvent(192, utf16('Some channel name')),
    textEvent(196, utf16('%FLStudioFactoryData%\\Data\\Patches\\Packs\\Drums\\Snares\\Grv Snare 01.wav')),
  ]);
  assert.deepEqual(parseFlStudio(bytes), [
    'C:\\Samples\\Drums\\Kick Hard.wav',
    '%FLStudioFactoryData%\\Data\\Patches\\Packs\\Drums\\Snares\\Grv Snare 01.wav',
  ]);
});

test('FL Studio < 11.5: reads 8-bit sample paths', () => {
  const bytes = flp([textEvent(199, ascii('10.0.9')), textEvent(196, ascii('C:\\Samples\\Hat ä.wav'))]);
  assert.deepEqual(parseFlStudio(bytes), ['C:\\Samples\\Hat ä.wav']);
});

test('FL Studio: long text events use multi-byte length', () => {
  const long = 'D:/' + 'x'.repeat(300) + '/Clap.wav';
  const bytes = flp([textEvent(199, ascii('21.0.0')), textEvent(196, utf16(long))]);
  assert.deepEqual(parseFlStudio(bytes), [long]);
});

test('FL Studio: rejects non-FLP data', () => {
  assert.throws(() => parseFlStudio(new Uint8Array(40)));
});

// --- Ableton fixtures -----------------------------------------------------

const live11 = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="11.0_433">
  <LiveSet>
    <SampleRef>
      <FileRef>
        <RelativePathType Value="3" />
        <RelativePath Value="../../Samples/Kicks/Kick &amp; Sub.wav" />
        <Path Value="/Users/me/Samples/Kicks/Kick &amp; Sub.wav" />
        <Type Value="1" />
        <LivePackName Value="" />
        <OriginalFileSize Value="123" />
      </FileRef>
      <LastModDate Value="1" />
    </SampleRef>
    <SampleRef>
      <FileRef>
        <RelativePathType Value="3" />
        <RelativePath Value="Samples/Imported/Hat 1.wav" />
        <Path Value="" />
      </FileRef>
    </SampleRef>
  </LiveSet>
</Ableton>`;

const live10 = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="10.0_377">
  <SampleRef>
    <FileRef>
      <HasRelativePath Value="true" />
      <RelativePathType Value="1" />
      <RelativePath>
        <RelativePathElement Id="0" Dir="Samples" />
        <RelativePathElement Id="1" Dir="Imported" />
      </RelativePath>
      <Name Value="Snare 04.wav" />
      <SearchHint>
        <PathHint>
          <RelativePathElement Id="0" Dir="Users" />
          <RelativePathElement Id="1" Dir="me" />
          <RelativePathElement Id="2" Dir="Drums" />
        </PathHint>
      </SearchHint>
      <LivePackName Value="Core Library" />
    </FileRef>
    <SourceContext>
      <SourceContext>
        <OriginalFileRef>
          <FileRef Id="0"><Name Value="ignored.wav" /></FileRef>
        </OriginalFileRef>
      </SourceContext>
    </SourceContext>
  </SampleRef>
</Ableton>`;

test('Ableton 11+: reads absolute paths, falls back to relative path', () => {
  assert.deepEqual(extractAbletonSamples(live11), ['/Users/me/Samples/Kicks/Kick & Sub.wav', 'Samples/Imported/Hat 1.wav']);
});

test('Ableton 9/10: joins path hint folders with the file name', () => {
  assert.deepEqual(extractAbletonSamples(live10), ['Users/me/Drums/Snare 04.wav']);
});

test('Ableton: decompresses gzipped sets', async () => {
  const bytes = new Uint8Array(gzipSync(Buffer.from(live11)));
  assert.equal((await parseAbleton(bytes)).length, 2);
});

test('Ableton: rejects non-Ableton XML', async () => {
  await assert.rejects(parseAbleton(new Uint8Array(gzipSync(Buffer.from('<foo/>')))));
});
