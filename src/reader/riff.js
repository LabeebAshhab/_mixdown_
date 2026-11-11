// WAV (RIFF) and AIFF (FORM): both are a list of chunks. WAV sizes are
// little-endian, AIFF sizes big-endian. Tags come from the ID3 chunk this app
// writes, and from the formats' own text chunks.
import { parseId3v2 } from './id3.js';
import { MAX_BLOCK } from './source.js';
import { clean } from './text.js';

const INFO = {
  INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'date', IGNR: 'genre', ITRK: 'track', IPRT: 'track',
  ICMT: 'comment', ISFT: 'encodedby', ICOP: 'copyright',
};
const AIFF_TEXT = { NAME: 'title', AUTH: 'artist', ANNO: 'comment', '(c) ': 'copyright' };
const WAV_CODECS = { 1: 'PCM', 2: 'ADPCM', 3: 'PCM (float)', 6: 'A-law', 7: 'µ-law', 0x11: 'ADPCM', 0x55: 'MP3', 0x2000: 'AC-3' };
const AIFC_CODECS = { NONE: 'PCM', twos: 'PCM', sowt: 'PCM', in24: 'PCM', in32: 'PCM', fl32: 'PCM (float)', FL32: 'PCM (float)', fl64: 'PCM (float)', alaw: 'A-law', ulaw: 'µ-law' };

/**
 * Walk the chunks after the 12-byte file header.
 * `visit(id, bodyPos, size)` may return a corrected size (for a data chunk that runs to the end of the file).
 */
async function chunks(src, bigEndian, visit) {
  let pos = 12;
  for (let n = 0; n < 10000 && pos + 8 <= src.size; n++) {
    const h = await src.read(pos, 8);
    if (h.length < 8) break;
    const id = h.toString('latin1', 0, 4);
    let size = bigEndian ? h.readUInt32BE(4) : h.readUInt32LE(4);
    size = (await visit(id, pos + 8, size)) ?? size;
    pos += 8 + size + (size & 1);
  }
}

async function readId3Chunk(src, pos, size, meta) {
  if (size >= 10 && size <= MAX_BLOCK) parseId3v2(await src.read(pos, size), meta);
}

/** 80-bit extended float, the way AIFF stores its sample rate. */
function extended(b, o) {
  const exponent = b.readUInt16BE(o) & 0x7fff;
  const mantissa = b.readUInt32BE(o + 2) * 2 ** 32 + b.readUInt32BE(o + 6);
  return mantissa * 2 ** (exponent - 16383 - 63);
}

export async function readWav(src, meta) {
  let fmt = null;
  let dataBytes = null;
  let factSamples = null;
  let ds64 = null; // 64-bit sizes of an RF64 file

  await chunks(src, false, async (id, pos, size) => {
    if (id === 'ds64') {
      const b = await src.read(pos, 24);
      if (b.length === 24) ds64 = { data: Number(b.readBigUInt64LE(8)), samples: Number(b.readBigUInt64LE(16)) };
    } else if (id === 'fmt ') {
      fmt = await src.read(pos, Math.min(size, 40));
    } else if (id === 'fact') {
      const b = await src.read(pos, 4);
      if (b.length === 4) factSamples = b.readUInt32LE(0);
    } else if (id === 'data') {
      const left = src.size - pos;
      let real = size === 0xffffffff && ds64 ? ds64.data : size;
      // Past 4 GB without RF64, or written to a pipe: the size field is wrong and the audio runs to the end.
      if (real === 0xffffffff || real > left || (src.size > 0xffffffff && !ds64)) real = left;
      dataBytes = real;
      return real;
    } else if (id === 'LIST') {
      if (size < 12 || size > 1048576) return undefined;
      const b = await src.read(pos, size);
      if (b.toString('latin1', 0, 4) !== 'INFO') return undefined;
      for (let o = 4, n = 0; o + 8 <= b.length && n < 1000; n++) {
        const key = b.toString('latin1', o, o + 4);
        const len = b.readUInt32LE(o + 4);
        const value = clean(b.toString('utf8', o + 8, o + 8 + len));
        if (value) meta.tag('RIFF INFO', key, value, INFO[key]);
        o += 8 + len + (len & 1);
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      await readId3Chunk(src, pos, size, meta);
    }
    return undefined;
  });

  const f = {};
  if (fmt && fmt.length >= 16) {
    let tag = fmt.readUInt16LE(0);
    f.channels = fmt.readUInt16LE(2);
    f.sampleRate = fmt.readUInt32LE(4);
    f.byteRate = fmt.readUInt32LE(8);
    f.blockAlign = fmt.readUInt16LE(12);
    f.bits = fmt.readUInt16LE(14);
    if (tag === 0xfffe && fmt.length >= 26) {
      // "extensible" header, used above 16-bit and 2 channels: the real format is further in
      f.bits = fmt.readUInt16LE(18) || f.bits;
      tag = fmt.readUInt16LE(24);
    }
    f.tag = tag;
  }
  const pcm = f.tag === 1 || f.tag === 3;
  let duration;
  if (dataBytes !== null && f.sampleRate) {
    if (pcm && f.blockAlign) duration = dataBytes / f.blockAlign / f.sampleRate;
    else if (factSamples) duration = factSamples / f.sampleRate;
    else if (f.byteRate) duration = dataBytes / f.byteRate;
  }
  meta.setFormat({
    container: 'WAVE',
    codec: f.tag === undefined ? undefined : WAV_CODECS[f.tag] || `0x${f.tag.toString(16)}`,
    lossless: f.tag === undefined ? undefined : pcm,
    sampleRate: f.sampleRate,
    bitsPerSample: pcm ? f.bits : undefined,
    numberOfChannels: f.channels,
    duration,
    bitrate: f.byteRate ? f.byteRate * 8 : undefined,
  });
}

/** @param {boolean} compressed true for AIFF-C ("AIFC") */
export async function readAiff(src, meta, compressed) {
  let comm = null;
  let dataBytes = null;

  await chunks(src, true, async (id, pos, size) => {
    if (id === 'COMM') {
      comm = await src.read(pos, Math.min(size, 64));
    } else if (id === 'SSND') {
      const left = src.size - pos;
      const real = size > left || src.size > 0xffffffff ? left : size;
      dataBytes = Math.max(0, real - 8);
      return real;
    } else if (id === 'ID3 ' || id === 'id3 ') {
      await readId3Chunk(src, pos, size, meta);
    } else if (AIFF_TEXT[id] && size <= 65536) {
      const value = clean((await src.read(pos, size)).toString('utf8'));
      if (value) meta.tag('AIFF text', id.trim(), value, AIFF_TEXT[id]);
    }
    return undefined;
  });

  const f = {};
  if (comm && comm.length >= 18) {
    f.channels = comm.readUInt16BE(0);
    f.frames = comm.readUInt32BE(2);
    f.bits = comm.readUInt16BE(6);
    f.sampleRate = Math.round(extended(comm, 8));
    f.codec = compressed && comm.length >= 22 ? AIFC_CODECS[comm.toString('latin1', 18, 22)] || comm.toString('latin1', 18, 22).trim() : 'PCM';
  }
  const pcm = f.codec?.startsWith('PCM');
  let duration;
  if (f.sampleRate) {
    if (f.frames) duration = f.frames / f.sampleRate;
    else if (dataBytes && pcm && f.channels && f.bits) duration = dataBytes / (f.channels * Math.ceil(f.bits / 8)) / f.sampleRate;
  }
  meta.setFormat({
    container: compressed ? 'AIFF-C' : 'AIFF',
    codec: f.codec,
    lossless: f.codec ? pcm : undefined,
    sampleRate: f.sampleRate,
    bitsPerSample: pcm ? f.bits : undefined,
    numberOfChannels: f.channels,
    duration,
    bitrate: pcm && f.sampleRate ? f.sampleRate * f.channels * f.bits : duration && dataBytes ? (dataBytes * 8) / duration : undefined,
  });
}
