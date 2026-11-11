// Ogg: Opus, Vorbis, FLAC and Speex streams. The first packets describe the
// audio and hold the tags; the last page gives the length.
import { parseStreamInfo } from './flac.js';
import { MAX_BLOCK, ReadError } from './source.js';
import { parseFlacPicture, parseVorbisComment } from './vorbis.js';

/**
 * Feed the packets of the first stream to `onPacket(packet, index)` until it
 * returns false. A packet may span many pages (tags with artwork do).
 * @returns {Promise<{serial: number|null, end: number}>} the stream's serial number, and where the page holding the last packet read ends
 */
async function eachPacket(src, onPacket) {
  let pos = 0;
  let serial = null;
  let parts = [];
  let size = 0;
  let index = 0;
  for (let n = 0; n < 5000; n++) {
    const h = await src.read(pos, 282);
    if (h.length < 27 || h.toString('latin1', 0, 4) !== 'OggS' || h[4] !== 0) break;
    const segments = h[26];
    if (h.length < 27 + segments) break;
    let body = 0;
    for (let i = 0; i < segments; i++) body += h[27 + i];
    const dataPos = pos + 27 + segments;
    pos = dataPos + body;
    const pageSerial = h.readUInt32LE(14);
    if (serial === null) serial = pageSerial;
    if (pageSerial !== serial) continue;

    const data = await src.read(dataPos, body);
    let o = 0;
    for (let i = 0; i < segments; i++) {
      const len = h[27 + i];
      parts.push(data.subarray(o, o + len));
      o += len;
      size += len;
      if (size > MAX_BLOCK) throw new ReadError('limit');
      if (len === 255) continue; // the packet goes on
      const packet = Buffer.concat(parts);
      parts = [];
      size = 0;
      if (!onPacket(packet, index++)) return { serial, end: pos };
    }
  }
  return { serial, end: pos };
}

/** Position, in samples, of the last page of the stream. */
async function lastGranule(src, serial) {
  const span = Math.min(src.size, 131072); // two maximum-size pages
  const b = await src.read(src.size - span, span);
  for (let i = b.lastIndexOf('OggS'); i >= 0; i = i > 0 ? b.lastIndexOf('OggS', i - 1) : -1) {
    if (i + 27 > b.length || b[i + 4] !== 0 || b.readUInt32LE(i + 14) !== serial) continue;
    const granule = b.readBigInt64LE(i + 6);
    if (granule >= 0n) return Number(granule);
  }
  return null;
}

export async function readOgg(src, meta) {
  let codec;
  let s = {}; // stream properties
  const ascii = (p, a, b) => p.toString('latin1', a, b);

  const { serial, end: audioStart } = await eachPacket(src, (p, i) => {
    try {
      if (i === 0) {
        if (ascii(p, 0, 8) === 'OpusHead') {
          codec = 'Opus';
          s = { sampleRate: 48000, numberOfChannels: p[9], preSkip: p.readUInt16LE(10) };
        } else if (p[0] === 1 && ascii(p, 1, 7) === 'vorbis') {
          codec = 'Vorbis';
          s = { sampleRate: p.readUInt32LE(12), numberOfChannels: p[11] };
        } else if (p[0] === 0x7f && ascii(p, 1, 5) === 'FLAC') {
          codec = 'FLAC';
          s = parseStreamInfo(p.subarray(17));
        } else if (ascii(p, 0, 8) === 'Speex   ') {
          codec = 'Speex';
          s = { sampleRate: p.readUInt32LE(36), numberOfChannels: p.readUInt32LE(48) };
          return false;
        }
        return !!codec;
      }
      if (codec === 'Opus') {
        if (ascii(p, 0, 8) === 'OpusTags') parseVorbisComment(p, meta, 8);
        return false;
      }
      if (codec === 'Vorbis') {
        if (i === 1 && p[0] === 3 && ascii(p, 1, 7) === 'vorbis') parseVorbisComment(p, meta, 7);
        return i < 2; // the third packet is the codec setup, still not audio
      }
      // Ogg FLAC: one metadata block per packet
      const type = p[0] & 0x7f;
      if (type === 4) parseVorbisComment(p, meta, 4);
      else if (type === 6) parseFlacPicture(p.subarray(4), meta);
      return !(p[0] & 0x80) && i < 64;
    } catch {
      return false; // a damaged header: keep what was read so far
    }
  });

  let duration;
  const granule = serial === null ? null : await lastGranule(src, serial);
  if (granule !== null && s.sampleRate) duration = Math.max(0, granule - (s.preSkip || 0)) / s.sampleRate;
  else if (s.samples && s.sampleRate) duration = s.samples / s.sampleRate;

  meta.setFormat({
    container: 'Ogg',
    codec,
    lossless: codec === 'FLAC',
    sampleRate: s.sampleRate,
    bitsPerSample: s.bitsPerSample,
    numberOfChannels: s.numberOfChannels,
    duration,
    bitrate: duration ? (Math.max(0, src.size - audioStart) * 8) / duration : undefined, // tags and artwork are not audio
  });
}
