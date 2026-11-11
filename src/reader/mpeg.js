// MPEG audio (MP3, and the rarer Layer I/II): finds the first audio frame and
// works out duration and bitrate from the Xing/Info/VBRI header, or from the
// file size when the file is plain constant-bitrate.
import { readId3v1 } from './id3.js';

const KBPS = {
  v1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  v2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Decode the 4-byte frame header at `o`, or null when it is not one. */
function frameHeader(b, o) {
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[o + 1] >> 3) & 3; // 3 = MPEG 1, 2 = MPEG 2, 0 = MPEG 2.5
  const layerBits = (b[o + 1] >> 1) & 3;
  const rateIndex = b[o + 2] >> 4;
  const srIndex = (b[o + 2] >> 2) & 3;
  if (version === 1 || layerBits === 0 || rateIndex === 0 || rateIndex === 15 || srIndex === 3) return null;
  const layer = 4 - layerBits;
  const v1 = version === 3;
  const kbps = KBPS[v1 ? 'v1' : 'v2'][layer - 1][rateIndex];
  const sampleRate = RATES[version][srIndex];
  const padding = (b[o + 2] >> 1) & 1;
  const samples = layer === 1 ? 384 : layer === 2 || v1 ? 1152 : 576;
  const length = layer === 1 ? (Math.floor((12000 * kbps) / sampleRate) + padding) * 4 : Math.floor(((samples / 8) * 1000 * kbps) / sampleRate) + padding;
  return { version, v1, layer, kbps, sampleRate, samples, length, mono: b[o + 3] >> 6 === 3 };
}

/** @returns {Promise<boolean>} false when no MPEG audio was found after `start` */
export async function readMpeg(src, meta, start) {
  const buf = await src.read(start, 262144);
  let first = null;
  let at = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] !== 0xff) continue;
    const h = frameHeader(buf, i);
    if (!h) continue;
    // a real frame is followed by another frame of the same kind
    const j = i + h.length;
    const nextBytes = j + 4 <= buf.length ? buf.subarray(j, j + 4) : await src.read(start + j, 4);
    const next = nextBytes.length === 4 ? frameHeader(nextBytes, 0) : null;
    if (next && next.version === h.version && next.layer === h.layer && next.sampleRate === h.sampleRate) {
      first = h;
      at = i;
      break;
    }
  }
  if (!first) return false;

  const tagged = await readId3v1(src, meta);
  const audioBytes = Math.max(0, src.size - (start + at) - (tagged ? 128 : 0));

  // The first frame may be a header frame holding the frame count.
  const f = buf.subarray(at, at + 512);
  let frames = null;
  let bytes = null;
  let vbr = false;
  const side = first.v1 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17;
  for (const o of [4 + side, 6 + side]) {
    const id = f.toString('latin1', o, o + 4);
    if ((id !== 'Xing' && id !== 'Info') || o + 16 > f.length) continue;
    const flags = f.readUInt32BE(o + 4);
    let p = o + 8;
    if (flags & 1) {
      frames = f.readUInt32BE(p);
      p += 4;
    }
    if (flags & 2) bytes = f.readUInt32BE(p);
    vbr = id === 'Xing';
    break;
  }
  if (frames === null && f.length >= 54 && f.toString('latin1', 36, 40) === 'VBRI') {
    bytes = f.readUInt32BE(46);
    frames = f.readUInt32BE(50);
    vbr = true;
  }

  let duration;
  let bitrate = first.kbps * 1000;
  if (frames) {
    duration = (frames * first.samples) / first.sampleRate;
    if (vbr) bitrate = ((bytes || audioBytes) * 8) / duration;
  } else {
    duration = (audioBytes * 8) / bitrate;
  }

  meta.setFormat({
    container: 'MPEG',
    codec: first.layer === 3 ? 'MP3' : `MPEG Layer ${first.layer}`,
    lossless: false,
    sampleRate: first.sampleRate,
    numberOfChannels: first.mono ? 1 : 2,
    bitrate,
    duration,
  });
  return true;
}
