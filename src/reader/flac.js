// FLAC: a chain of metadata blocks in front of the audio.
import { parseFlacPicture, parseVorbisComment } from './vorbis.js';

/** @param {Buffer} b a STREAMINFO block body (34 bytes; the first 18 are enough) */
export function parseStreamInfo(b) {
  const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
  return {
    sampleRate,
    numberOfChannels: ((b[12] >> 1) & 7) + 1,
    bitsPerSample: (((b[12] & 1) << 4) | (b[13] >> 4)) + 1,
    samples: (b[13] & 0x0f) * 2 ** 32 + b.readUInt32BE(14),
  };
}

/** @param {number} start offset of the "fLaC" marker */
export async function readFlac(src, meta, start) {
  let pos = start + 4;
  let info = null;
  for (let n = 0; n < 2000; n++) {
    const h = await src.read(pos, 4);
    if (h.length < 4) break;
    const type = h[0] & 0x7f;
    const len = h.readUIntBE(1, 3);
    pos += 4;
    try {
      if (type === 0) info = parseStreamInfo(await src.read(pos, 34));
      else if (type === 4) parseVorbisComment(await src.read(pos, len), meta);
      else if (type === 6) parseFlacPicture(await src.read(pos, len), meta);
    } catch (e) {
      if (e?.code === 'limit') throw e; // a damaged block is skipped; running out of budget is not
    }
    pos += len;
    if (h[0] & 0x80) break; // last metadata block
  }

  const duration = info?.samples && info.sampleRate ? info.samples / info.sampleRate : undefined;
  meta.setFormat({
    container: 'FLAC',
    codec: 'FLAC',
    lossless: true,
    sampleRate: info?.sampleRate,
    bitsPerSample: info?.bitsPerSample,
    numberOfChannels: info?.numberOfChannels,
    duration,
    bitrate: duration ? (Math.max(0, src.size - pos) * 8) / duration : undefined,
  });
}
