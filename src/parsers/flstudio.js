// Reads sample paths out of FL Studio project files (.flp).
//
// An .flp file is a small "FLhd" header chunk followed by an "FLdt" chunk that
// holds a flat stream of events. Each event starts with a one-byte id; the id
// range decides how much data follows:
//   0–63 → 1 byte, 64–127 → 2 bytes, 128–191 → 4 bytes,
//   192–255 → variable length (7-bit little-endian varint prefix).
// Sampler channels and audio clips store their file in event 196. Since
// FL Studio 11.5 text events are UTF-16LE; older projects use 8-bit text.

const EV_SAMPLE_PATH = 196;
const EV_VERSION = 199;

function magic(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function usesUtf16(version) {
  const [major, minor] = version.split('.').map((n) => parseInt(n, 10));
  if (!Number.isFinite(major)) return null;
  return major > 11 || (major === 11 && minor >= 5);
}

function decodeText(data, utf16) {
  const wide = utf16 ?? (data.length >= 2 && data[1] === 0);
  const text = new TextDecoder(wide ? 'utf-16le' : 'windows-1252').decode(data);
  return text.replace(/\0+$/, '').trim();
}

export function parseFlStudio(bytes) {
  if (bytes.length < 22 || magic(bytes, 0) !== 'FLhd') {
    throw new Error('Keine gültige FL-Studio-Datei');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8 + view.getUint32(4, true);
  if (magic(bytes, pos) !== 'FLdt') throw new Error('FL-Studio-Datei ohne Daten');
  const end = Math.min(bytes.length, pos + 8 + view.getUint32(pos + 4, true));
  pos += 8;

  let utf16 = null;
  const paths = [];
  while (pos < end) {
    const id = bytes[pos++];
    if (id < 64) pos += 1;
    else if (id < 128) pos += 2;
    else if (id < 192) pos += 4;
    else {
      let len = 0;
      let shift = 0;
      let b;
      do {
        b = bytes[pos++];
        len += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80 && pos < end);
      const data = bytes.subarray(pos, pos + len);
      pos += len;
      if (id === EV_VERSION) utf16 = usesUtf16(new TextDecoder('ascii').decode(data));
      else if (id === EV_SAMPLE_PATH) paths.push(data);
    }
  }
  return paths.map((data) => decodeText(data, utf16)).filter(Boolean);
}
