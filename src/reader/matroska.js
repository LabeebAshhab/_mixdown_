// Matroska and WebM (.mka, .webm): nested elements with variable-length ids
// and sizes. Only the small sections in front of the audio are read; the
// file's own index (SeekHead) finds any that were written after it.
import { MAX_BLOCK, ReadError } from './source.js';
import { clean, imageType } from './text.js';

const ID = {
  EBML: 0x1a45dfa3, DOCTYPE: 0x4282, SEGMENT: 0x18538067, SEEKHEAD: 0x114d9b74, SEEK: 0x4dbb, SEEK_ID: 0x53ab, SEEK_POS: 0x53ac,
  INFO: 0x1549a966, TIME_SCALE: 0x2ad7b1, DURATION: 0x4489, TITLE: 0x7ba9,
  TRACKS: 0x1654ae6b, TRACK: 0xae, TRACK_TYPE: 0x83, CODEC: 0x86, AUDIO: 0xe1, RATE: 0xb5, OUT_RATE: 0x78b5, CHANNELS: 0x9f, DEPTH: 0x6264,
  TAGS: 0x1254c367, TAG: 0x7373, TARGETS: 0x63c0, TARGET_LEVEL: 0x68ca, TARGET_TRACK: 0x63c5, SIMPLE: 0x67c8, NAME: 0x45a3, STRING: 0x4487,
  ATTACHMENTS: 0x1941a469, FILE: 0x61a7, FILE_MIME: 0x4660, FILE_DATA: 0x465c, FILE_NAME: 0x466e,
  CLUSTER: 0x1f43b675,
};
const SECTIONS = new Set([ID.INFO, ID.TRACKS, ID.TAGS, ID.ATTACHMENTS]);

const TAGS = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUM_ARTIST: 'albumartist', ALBUMARTIST: 'albumartist', DATE: 'date',
  DATE_RELEASED: 'date', DATE_RECORDED: 'date', GENRE: 'genre', TRACK: 'track', PART_NUMBER: 'track', TOTAL_PARTS: 'tracktotal',
  DISC: 'disk', COMPOSER: 'composer', COMMENT: 'comment', DESCRIPTION: 'comment', LYRICS: 'lyrics', PUBLISHER: 'label',
  LABEL: 'label', ISRC: 'isrc', BPM: 'bpm', COPYRIGHT: 'copyright', ENCODED_BY: 'encodedby',
};
// The same names mean something else when a tag is explicitly about the album.
const ALBUM_TAGS = { TITLE: 'album', ARTIST: 'albumartist', PART_NUMBER: 'disk', TOTAL_PARTS: 'tracktotal' };
const CODECS = { A_OPUS: 'Opus', A_VORBIS: 'Vorbis', A_FLAC: 'FLAC', A_ALAC: 'ALAC', A_AC3: 'AC-3', A_EAC3: 'E-AC-3', A_DTS: 'DTS', 'A_MPEG/L3': 'MP3', 'A_MPEG/L2': 'MP2' };

/** Element header at `o`: id, data size (-1 = unknown) and where the data starts. */
function header(buf, o) {
  const idLen = Math.clz32(buf[o] ?? 0) - 23;
  if (idLen < 1 || idLen > 4 || o + idLen >= buf.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[o + i];
  const p = o + idLen;
  const sizeLen = Math.clz32(buf[p]) - 23;
  if (sizeLen < 1 || sizeLen > 8 || p + sizeLen > buf.length) return null;
  let size = buf[p] & (0xff >> sizeLen);
  let unknown = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    size = size * 256 + buf[p + i];
    unknown &&= buf[p + i] === 0xff;
  }
  return { id, size: unknown ? -1 : size, start: p + sizeLen };
}

function* children(buf, start, end) {
  let o = start;
  for (let n = 0; n < 20000 && o < end; n++) {
    const e = header(buf, o);
    if (!e || e.size < 0 || e.start + e.size > end) return;
    yield { id: e.id, start: e.start, end: e.start + e.size };
    o = e.start + e.size;
  }
}

const uint = (buf, e) => {
  let v = 0;
  for (let i = e.start; i < e.end && i < e.start + 8; i++) v = v * 256 + buf[i];
  return v;
};
const float = (buf, e) => (e.end - e.start === 4 ? buf.readFloatBE(e.start) : e.end - e.start === 8 ? buf.readDoubleBE(e.start) : undefined);
const text = (buf, e) => clean(buf.toString('utf8', e.start, e.end));

export async function readMatroska(src, meta) {
  const first = header(await src.read(0, 16), 0);
  if (!first || first.id !== ID.EBML || first.size < 0 || first.size > 4096) throw new ReadError('corrupt');
  const ebml = await src.read(first.start, first.size);
  let docType = 'matroska';
  for (const e of children(ebml, 0, ebml.length)) if (e.id === ID.DOCTYPE) docType = text(ebml, e);

  const segPos = first.start + first.size;
  const seg = header(await src.read(segPos, 16), 0);
  if (!seg || seg.id !== ID.SEGMENT) throw new ReadError('corrupt');
  const segStart = segPos + seg.start;
  const segEnd = seg.size < 0 ? src.size : Math.min(src.size, segStart + seg.size);

  const s = { scale: 1_000_000 }; // what the sections tell us
  const index = new Map(); // section id -> position, from the SeekHead
  const seen = new Set();

  const section = (id, b) => {
    const all = () => children(b, 0, b.length);
    if (id === ID.SEEKHEAD) {
      for (const seek of all()) {
        if (seek.id !== ID.SEEK) continue;
        let target;
        let pos;
        for (const e of children(b, seek.start, seek.end)) {
          if (e.id === ID.SEEK_ID) target = uint(b, e);
          else if (e.id === ID.SEEK_POS) pos = uint(b, e);
        }
        if (target !== undefined && pos !== undefined && !index.has(target)) index.set(target, pos);
      }
    } else if (id === ID.INFO) {
      for (const e of all()) {
        if (e.id === ID.TIME_SCALE) s.scale = uint(b, e) || s.scale;
        else if (e.id === ID.DURATION) s.duration = float(b, e);
        else if (e.id === ID.TITLE) s.title = text(b, e);
      }
    } else if (id === ID.TRACKS) {
      for (const track of all()) {
        if (track.id !== ID.TRACK || s.codecId) continue;
        const t = {};
        for (const e of children(b, track.start, track.end)) {
          if (e.id === ID.TRACK_TYPE) t.type = uint(b, e);
          else if (e.id === ID.CODEC) t.codecId = text(b, e);
          else if (e.id === ID.AUDIO) {
            for (const a of children(b, e.start, e.end)) {
              if (a.id === ID.RATE) t.sampleRate = float(b, a);
              else if (a.id === ID.OUT_RATE) t.outRate = float(b, a);
              else if (a.id === ID.CHANNELS) t.channels = uint(b, a);
              else if (a.id === ID.DEPTH) t.depth = uint(b, a);
            }
          }
        }
        if (t.type === 2) Object.assign(s, t); // the first audio track
      }
    } else if (id === ID.TAGS) {
      for (const tag of all()) {
        if (tag.id !== ID.TAG) continue;
        let level = null;
        let forTrack = false;
        const pairs = [];
        for (const e of children(b, tag.start, tag.end)) {
          if (e.id === ID.TARGETS) {
            for (const t of children(b, e.start, e.end)) {
              if (t.id === ID.TARGET_LEVEL) level = uint(b, t);
              else if (t.id === ID.TARGET_TRACK) forTrack = uint(b, t) !== 0;
            }
          } else if (e.id === ID.SIMPLE) {
            let name;
            let value;
            for (const x of children(b, e.start, e.end)) {
              if (x.id === ID.NAME) name = text(b, x);
              else if (x.id === ID.STRING) value = text(b, x);
            }
            if (name && value) pairs.push([name.toUpperCase(), value]);
          }
        }
        for (const [name, value] of pairs) {
          // Tags about one stream (its encoder, its duration) are kept as stored only.
          const key = forTrack ? undefined : (level !== null && level >= 50 && ALBUM_TAGS[name]) || TAGS[name];
          meta.tag('matroska', name, value, key);
        }
      }
    } else if (id === ID.ATTACHMENTS) {
      for (const file of all()) {
        if (file.id !== ID.FILE) continue;
        let mime = '';
        let name = '';
        let data = null;
        for (const e of children(b, file.start, file.end)) {
          if (e.id === ID.FILE_MIME) mime = text(b, e).toLowerCase();
          else if (e.id === ID.FILE_NAME) name = text(b, e);
          else if (e.id === ID.FILE_DATA) data = b.subarray(e.start, e.end);
        }
        const format = data && (imageType(data) || (mime.startsWith('image/') ? mime : null));
        if (format) meta.picture('matroska', { format, data, description: name, kind: 3 });
      }
    }
  };

  const load = async (pos) => {
    const e = header(await src.read(pos, 16), 0);
    return e && e.size >= 0 ? { id: e.id, size: e.size, dataPos: pos + e.start } : null;
  };
  const take = async (e) => {
    seen.add(e.id);
    if (e.size <= MAX_BLOCK) section(e.id, await src.read(e.dataPos, e.size));
  };

  // Sections in front of the audio.
  let pos = segStart;
  for (let n = 0; n < 1000 && pos < segEnd; n++) {
    const e = await load(pos);
    if (!e || e.id === ID.CLUSTER) break;
    if (SECTIONS.has(e.id) || e.id === ID.SEEKHEAD) await take(e);
    pos = e.dataPos + e.size;
  }
  // Sections after it, found through the index.
  for (const [id, offset] of index) {
    if (!SECTIONS.has(id) || seen.has(id)) continue;
    const e = await load(segStart + offset);
    if (e && e.id === id) await take(e);
  }

  if (s.title) meta.tag('matroska', 'SEGMENT TITLE', s.title, 'title'); // only used when no TITLE tag was found
  const codec = s.codecId ? CODECS[s.codecId] || (s.codecId.startsWith('A_AAC') ? 'AAC' : s.codecId.startsWith('A_PCM') ? 'PCM' : s.codecId.replace(/^A_/, '')) : undefined;
  const lossless = ['FLAC', 'ALAC', 'PCM'].includes(codec);
  const duration = s.duration ? (s.duration * s.scale) / 1e9 : undefined;
  meta.setFormat({
    container: docType === 'webm' ? 'WebM' : 'Matroska',
    codec,
    lossless: codec ? lossless : undefined,
    sampleRate: Math.round(s.outRate || s.sampleRate || 0) || undefined,
    bitsPerSample: lossless ? s.depth : undefined,
    numberOfChannels: s.codecId ? s.channels || 1 : undefined,
    duration,
    bitrate: duration ? (src.size * 8) / duration : undefined,
  });
}
