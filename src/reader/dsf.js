// DSF (DSD audio): a fixed header, then the audio, then an ID3v2 tag that the
// header points to.
import { readId3v2 } from './id3.js';
import { ReadError } from './source.js';

export async function readDsf(src, meta) {
  const h = await src.read(0, 80);
  if (h.length < 80 || h.toString('latin1', 28, 32) !== 'fmt ') throw new ReadError('corrupt');
  const tagPos = Number(h.readBigUInt64LE(20));
  const channels = h.readUInt32LE(52);
  const sampleRate = h.readUInt32LE(56);
  const samples = Number(h.readBigUInt64LE(64));

  meta.setFormat({
    container: 'DSF',
    codec: 'DSD',
    lossless: true,
    sampleRate,
    bitsPerSample: 1,
    numberOfChannels: channels,
    duration: sampleRate ? samples / sampleRate : undefined,
    bitrate: sampleRate * channels, // one bit per sample
  });
  if (tagPos > 0 && tagPos < src.size) await readId3v2(src, tagPos, meta);
}
