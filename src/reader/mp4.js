// MP4 / M4A (AAC, ALAC): a tree of "atoms". Audio properties live in the
// track's sample description, tags in the iTunes-style list under moov/udta/meta.
import { parseStreamInfo } from './flac.js';
import { MAX_BLOCK, ReadError } from './source.js';
import { clean, GENRES, imageType } from './text.js';

const ITEMS = {
  '©nam': 'title', '©ART': 'artist', aART: 'albumartist', '©alb': 'album', '©day': 'date', trkn: 'track', disk: 'disk',
  '©gen': 'genre', gnre: 'genre', '©wrt': 'composer', '©cmt': 'comment', '©lyr': 'lyrics', '©grp': 'grouping',
  cpil: 'compilation', tmpo: 'bpm', cprt: 'copyright', '©too': 'encodedby',
  '----:com.apple.iTunes:LABEL': 'label', '----:com.apple.iTunes:ISRC': 'isrc', '----:com.apple.iTunes:ARTISTS': 'artists',
};
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Child atoms inside buf[start, end). */
function* atoms(buf, start, end) {
  let o = start;
  for (let n = 0; n < 5000 && o + 8 <= end; n++) {
    let size = buf.readUInt32BE(o);
    let head = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = Number(buf.readBigUInt64BE(o + 8));
      head = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < head || o + size > end) return;
    yield { type: buf.toString('latin1', o + 4, o + 8), start: o + head, end: o + size };
    o += size;
  }
}

function child(buf, parent, type) {
  if (!parent) return null;
  for (const a of atoms(buf, parent.start, parent.end)) if (a.type === type) return a;
  return null;
}

/** mvhd / mdhd: time scale and duration, in two layouts. */
function seconds(buf, a) {
  if (!a) return undefined;
  const v1 = buf[a.start] === 1;
  const scale = buf.readUInt32BE(a.start + (v1 ? 20 : 12));
  const units = v1 ? Number(buf.readBigUInt64BE(a.start + 24)) : buf.readUInt32BE(a.start + 16);
  if (!scale || !units || (!v1 && units === 0xffffffff)) return undefined;
  return units / scale;
}

/** The MPEG-4 descriptor chain holding the codec type, bitrate and AAC setup. */
function parseEsds(buf, start) {
  let o = start + 4;
  const out = {};
  const length = () => {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const b = buf[o++];
      n = (n << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return n;
  };
  if (buf[o++] !== 3) return out;
  length();
  o += 2;
  const flags = buf[o++];
  if (flags & 0x80) o += 2;
  if (flags & 0x40) o += 1 + buf[o];
  if (flags & 0x20) o += 2;
  if (buf[o++] !== 4) return out;
  length();
  out.objectType = buf[o];
  out.bitrate = buf.readUInt32BE(o + 9);
  o += 13;
  if (buf[o++] !== 5) return out;
  length();
  // AudioSpecificConfig, bit by bit
  let bit = o * 8;
  const read = (k) => {
    let v = 0;
    for (; k > 0; k--, bit++) v = (v << 1) | (((buf[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
    return v;
  };
  const rate = () => {
    const i = read(4);
    return i === 15 ? read(24) : AAC_RATES[i];
  };
  let profile = read(5);
  if (profile === 31) profile = 32 + read(6);
  out.sampleRate = rate();
  const channels = read(4);
  out.channels = channels === 7 ? 8 : channels;
  if (profile === 5 || profile === 29) out.sampleRate = rate() || out.sampleRate; // HE-AAC: the output rate
  out.profile = profile;
  return out;
}

/** The first sample description of an audio track. */
function parseSampleEntry(buf, stsd) {
  const o = stsd.start + 8; // version/flags, entry count
  if (o + 36 > stsd.end) return {};
  const size = buf.readUInt32BE(o);
  const format = buf.toString('latin1', o + 4, o + 8);
  const version = buf.readUInt16BE(o + 16);
  const s = { format, numberOfChannels: buf.readUInt16BE(o + 24), sampleRate: buf.readUInt16BE(o + 32) };
  let kids = o + 36;
  if (version === 1) kids = o + 52;
  else if (version === 2) {
    s.sampleRate = Math.round(buf.readDoubleBE(o + 40));
    s.numberOfChannels = buf.readUInt32BE(o + 48);
    kids = o + 72;
  }
  const end = Math.min(stsd.end, o + size);
  const visit = (from, to) => {
    for (const a of atoms(buf, from, to)) {
      if (a.type === 'wave') visit(a.start, a.end); // QuickTime wraps the codec setup
      else if (a.type === 'esds') s.esds = parseEsds(buf, a.start);
      else if (a.type === 'alac' && a.end - a.start >= 28) {
        s.bitsPerSample = buf[a.start + 9];
        s.numberOfChannels = buf[a.start + 13];
        s.bitrate = buf.readUInt32BE(a.start + 20);
        s.sampleRate = buf.readUInt32BE(a.start + 24);
      } else if (a.type === 'dfLa' && a.end - a.start >= 26) Object.assign(s, parseStreamInfo(buf.subarray(a.start + 8, a.end)));
      else if (a.type === 'dOps') {
        s.numberOfChannels = buf[a.start + 1];
        s.sampleRate = 48000;
      }
    }
  };
  visit(kids, end);

  if (format === 'mp4a') {
    const e = s.esds || {};
    const type = e.objectType;
    if (type === 0x69 || type === 0x6b) s.codec = 'MP3';
    else s.codec = e.profile === 5 ? 'HE-AAC' : e.profile === 29 ? 'HE-AAC v2' : 'AAC';
    if (e.sampleRate) s.sampleRate = e.sampleRate;
    if (e.channels) s.numberOfChannels = e.channels;
    if (e.bitrate) s.bitrate = e.bitrate;
  } else {
    s.codec = { alac: 'ALAC', fLaC: 'FLAC', Opus: 'Opus', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', samr: 'AMR', sawb: 'AMR-WB' }[format] || format.trim();
  }
  s.lossless = s.codec === 'ALAC' || s.codec === 'FLAC';
  if (!s.lossless) delete s.bitsPerSample; // lossy audio has no bit depth
  return s;
}

function parseTags(buf, ilst, meta) {
  for (const item of atoms(buf, ilst.start, ilst.end)) {
    let id = item.type;
    let mean = '';
    let name = '';
    const values = [];
    for (const a of atoms(buf, item.start, item.end)) {
      if (a.type === 'data' && a.end - a.start >= 8) values.push(a);
      else if (a.type === 'mean') mean = buf.toString('utf8', a.start + 4, a.end);
      else if (a.type === 'name') name = buf.toString('utf8', a.start + 4, a.end);
    }
    if (id === '----') id = `----:${mean}:${name}`;
    const key = ITEMS[id];

    for (const a of values) {
      const kind = buf.readUInt32BE(a.start) & 0xffffff;
      const v = buf.subarray(a.start + 8, a.end);
      if (id === 'covr') {
        meta.picture('iTunes', { format: imageType(v) || (kind === 14 ? 'image/png' : 'image/jpeg'), data: v, kind: 3 });
      } else if (id === 'trkn' || id === 'disk') {
        if (v.length < 6) continue;
        const no = v.readUInt16BE(2);
        const of = v.readUInt16BE(4);
        meta.tag('iTunes', id, of ? `${no}/${of}` : String(no), key);
      } else if (id === 'gnre') {
        const genre = v.length >= 2 ? GENRES[v.readUInt16BE(0) - 1] : null;
        if (genre) meta.tag('iTunes', id, genre, key);
      } else if (kind === 1) {
        meta.tag('iTunes', id, clean(v.toString('utf8')), key);
      } else if (kind === 2) {
        meta.tag('iTunes', id, clean(Buffer.from(v.subarray(0, v.length & ~1)).swap16().toString('utf16le')), key);
      } else if ((kind === 0 || kind === 21 || kind === 22) && [1, 2, 4].includes(v.length)) {
        meta.tag('iTunes', id, kind === 21 ? v.readIntBE(0, v.length) : v.readUIntBE(0, v.length), key);
      }
    }
  }
}

/**
 * Length of one fragment ("moof") of a fragmented file, in track time units.
 * Fragmented files keep no total duration, so the fragments are added up.
 */
function fragmentUnits(buf, trackId, defaultDuration) {
  let units = 0;
  for (const traf of atoms(buf, 0, buf.length)) {
    if (traf.type !== 'traf') continue;
    let perSample = defaultDuration;
    let wanted = true;
    for (const a of atoms(buf, traf.start, traf.end)) {
      const flags = buf.readUInt32BE(a.start) & 0xffffff;
      if (a.type === 'tfhd') {
        wanted = !trackId || buf.readUInt32BE(a.start + 4) === trackId;
        const o = a.start + 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
        if (flags & 8) perSample = buf.readUInt32BE(o);
      } else if (a.type === 'trun' && wanted) {
        const count = buf.readUInt32BE(a.start + 4);
        if (!(flags & 0x100)) {
          units += count * perSample;
          continue;
        }
        const step = 4 * (1 + !!(flags & 0x200) + !!(flags & 0x400) + !!(flags & 0x800));
        let o = a.start + 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
        for (let i = 0; i < count && o + 4 <= a.end; i++, o += step) units += buf.readUInt32BE(o);
      }
    }
  }
  return units;
}

/** The "moov" index: audio properties, duration and tags. */
function parseMoov(moov, meta) {
  const root = { start: 0, end: moov.length };
  const t = { s: {} };
  for (const trak of atoms(moov, 0, moov.length)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(moov, trak, 'mdia');
    const hdlr = child(moov, mdia, 'hdlr');
    if (!hdlr || moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'soun') continue;
    const stsd = child(moov, child(moov, child(moov, mdia, 'minf'), 'stbl'), 'stsd');
    if (stsd) t.s = parseSampleEntry(moov, stsd);
    const mdhd = child(moov, mdia, 'mdhd');
    t.duration = seconds(moov, mdhd);
    if (mdhd) t.timescale = moov.readUInt32BE(mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));
    const tkhd = child(moov, trak, 'tkhd');
    if (tkhd) t.trackId = moov.readUInt32BE(tkhd.start + (moov[tkhd.start] === 1 ? 20 : 12));
    break;
  }
  t.duration ??= seconds(moov, child(moov, root, 'mvhd'));
  // Fragmented files: the default sample length, and sometimes the total length (in movie time units).
  const mvex = child(moov, root, 'mvex');
  const mvhd = child(moov, root, 'mvhd');
  for (const a of mvex ? atoms(moov, mvex.start, mvex.end) : []) {
    if (a.type === 'trex' && (!t.trackId || moov.readUInt32BE(a.start + 4) === t.trackId)) {
      t.fragmentDefault = moov.readUInt32BE(a.start + 12);
    } else if (a.type === 'mehd' && mvhd && !t.duration) {
      const units = moov[a.start] === 1 ? Number(moov.readBigUInt64BE(a.start + 4)) : moov.readUInt32BE(a.start + 4);
      const scale = moov.readUInt32BE(mvhd.start + (moov[mvhd.start] === 1 ? 20 : 12));
      if (units && scale) t.duration = units / scale;
    }
  }

  // Tags: moov/udta/meta/ilst. "meta" normally starts with 4 version bytes.
  const metaAtom = child(moov, child(moov, root, 'udta'), 'meta') || child(moov, root, 'meta');
  if (metaAtom) {
    const skip = moov.toString('latin1', metaAtom.start + 4, metaAtom.start + 8) === 'hdlr' ? 0 : 4;
    const ilst = child(moov, { start: metaAtom.start + skip, end: metaAtom.end }, 'ilst');
    if (ilst) parseTags(moov, ilst, meta);
  }
  return t;
}

export async function readMp4(src, meta) {
  // Top level: the brand, the "moov" index, the audio data, and any fragments.
  let pos = 0;
  let brand = '';
  let t = null;
  let audioBytes = 0;
  let fragments = 0;
  for (let n = 0; n < 20000 && pos + 8 <= src.size; n++) {
    const h = await src.read(pos, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0);
    let head = 8;
    const type = h.toString('latin1', 4, 8);
    if (size === 1) {
      if (h.length < 16) break;
      size = Number(h.readBigUInt64BE(8));
      head = 16;
    } else if (size === 0) {
      size = src.size - pos;
    }
    if (size < head) break;
    if (type === 'ftyp') brand = (await src.read(pos + head, 4)).toString('latin1').trim();
    else if (type === 'mdat') audioBytes += size - head;
    else if (type === 'moov' && !t) {
      if (size - head > MAX_BLOCK) throw new ReadError('limit');
      t = parseMoov(await src.read(pos + head, size - head), meta);
    } else if (type === 'moof' && t && !t.duration && size - head <= 4 * 1048576) {
      try {
        fragments += fragmentUnits(await src.read(pos + head, size - head), t.trackId, t.fragmentDefault || 0);
      } catch (e) {
        if (e?.code === 'limit') throw e; // a damaged fragment is skipped; running out of budget is not
      }
    }
    pos += size;
  }
  if (!t) throw new ReadError('corrupt');
  const s = t.s;
  const duration = t.duration || (fragments && t.timescale ? fragments / t.timescale : undefined);
  const measured = duration && audioBytes ? (audioBytes * 8) / duration : undefined;

  meta.setFormat({
    container: ['M4A', 'M4B', 'M4P'].includes(brand) ? brand : brand === 'qt' ? 'QuickTime' : 'MP4',
    codec: s.codec,
    lossless: s.codec ? s.lossless : undefined,
    sampleRate: s.sampleRate,
    bitsPerSample: s.bitsPerSample,
    numberOfChannels: s.numberOfChannels,
    duration,
    // ALAC declares its uncompressed rate, so lossless audio is measured instead.
    bitrate: (s.lossless ? measured : s.bitrate) || measured || s.bitrate,
  });
}
