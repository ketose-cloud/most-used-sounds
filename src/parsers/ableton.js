// Reads sample paths out of Ableton Live sets (.als).
//
// An .als file is gzip-compressed XML. Every sample a set uses (audio clips,
// Simpler, Sampler, Drum Rack pads) appears as a <SampleRef> holding a
// <FileRef>. Live 11+ writes the absolute path as <Path Value="…"/>; Live 9/10
// write a <Name> plus the folders as <RelativePathElement Dir="…"/> entries
// inside <SearchHint><PathHint>.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()];
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function valueOf(block, tag) {
  const m = new RegExp(`<${tag} Value="([^"]*)"`).exec(block);
  return m ? decodeXml(m[1]) : '';
}

// Samples from Ableton's own packs (Core Library, installed Packs) carry an
// ableton.com pack id — that's stock content, not a sound the user picked.
function isAbletonPack(block) {
  return /ableton\.com/i.test(valueOf(block, 'LivePackId')) || /^core library$/i.test(valueOf(block, 'LivePackName'));
}

function pathFromFileRef(block) {
  if (isAbletonPack(block)) return '';
  const absolute = valueOf(block, 'Path');
  if (absolute) return absolute;
  const relative = valueOf(block, 'RelativePath');
  const name = valueOf(block, 'Name');
  if (!name) return relative;
  const folders =
    /<PathHint>([\s\S]*?)<\/PathHint>/.exec(block)?.[1] ??
    /<RelativePath>([\s\S]*?)<\/RelativePath>/.exec(block)?.[1] ??
    '';
  const dirs = [...folders.matchAll(/Dir="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  return [...dirs, name].join('/');
}

export function extractAbletonSamples(xml) {
  const paths = [];
  const sampleRefs = /<SampleRef>([\s\S]*?)<\/SampleRef>/g;
  let m;
  while ((m = sampleRefs.exec(xml))) {
    const fileRef = /<FileRef[^>]*>([\s\S]*?)<\/FileRef>/.exec(m[1]);
    const path = fileRef && pathFromFileRef(fileRef[1]);
    if (path) paths.push(path);
  }
  return paths;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function parseAbleton(bytes) {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : bytes;
  const xml = new TextDecoder('utf-8').decode(raw);
  if (!xml.includes('<Ableton')) throw new Error('Keine gültige Ableton-Live-Datei');
  return extractAbletonSamples(xml);
}
