// Output formats and their options. This is the allowlist: a format or option
// value that is not listed here is rejected before any work starts, and only
// values from these tables ever reach the ffmpeg command line.
import { PublicError } from './security.js';

const khz = (v) => `${Number(v) / 1000} kHz`;
const rateOption = (values) => ({
  id: 'sampleRate',
  label: 'Sample rate',
  default: 'source',
  values: [{ value: 'source', label: 'Same as source' }, ...values.map((v) => ({ value: String(v), label: khz(v) }))],
});
const HIRES_RATES = [44100, 48000, 88200, 96000, 176400, 192000];
const rateArgs = (o) => (o.sampleRate === 'source' ? [] : ['-ar', o.sampleRate]);
const pick = (id, label, def, values) => ({
  id,
  label,
  default: String(def),
  values: values.map(([value, text]) => ({ value: String(value), label: text })),
});

/**
 * tags:  how tags are written ('ffmpeg' = by the muxer, 'id3' = our own ID3v2 writer)
 * cover: 'attach' (ffmpeg attached picture), 'vorbis' (picture block in comments), 'id3', or null
 */
export const FORMATS = {
  flac: {
    label: 'FLAC',
    hint: 'Lossless, compressed',
    ext: 'flac',
    tags: 'ffmpeg',
    numbering: 'split',
    cover: 'attach',
    options: [
      pick('bitDepth', 'Bit depth', 16, [
        [16, '16-bit'],
        [24, '24-bit'],
        [32, '32-bit'],
      ]),
      rateOption(HIRES_RATES),
      pick('compression', 'Compression', 5, [
        [0, 'Fastest, larger file'],
        [5, 'Balanced'],
        [8, 'Smaller file'],
        [12, 'Smallest, slowest'],
      ]),
    ],
    args: (o) => [
      '-c:a', 'flac',
      ...(o.bitDepth === '16'
        ? ['-sample_fmt', 's16']
        : o.bitDepth === '24'
          ? ['-sample_fmt', 's32', '-bits_per_raw_sample', '24']
          : ['-sample_fmt', 's32', '-bits_per_raw_sample', '32', '-strict', 'experimental']),
      '-compression_level', o.compression,
      ...rateArgs(o),
    ],
  },
  wav: {
    label: 'WAV',
    hint: 'Uncompressed PCM',
    ext: 'wav',
    tags: 'id3',
    cover: 'id3',
    options: [
      pick('bitDepth', 'Bit depth', 16, [
        [16, '16-bit'],
        [24, '24-bit'],
        [32, '32-bit'],
        ['32f', '32-bit float'],
      ]),
      rateOption(HIRES_RATES),
    ],
    args: (o) => ['-c:a', { 16: 'pcm_s16le', 24: 'pcm_s24le', 32: 'pcm_s32le', '32f': 'pcm_f32le' }[o.bitDepth], ...rateArgs(o)],
  },
  aiff: {
    label: 'AIFF',
    hint: 'Uncompressed PCM',
    ext: 'aiff',
    tags: 'id3',
    cover: 'id3',
    options: [
      pick('bitDepth', 'Bit depth', 16, [
        [16, '16-bit'],
        [24, '24-bit'],
        [32, '32-bit'],
      ]),
      rateOption(HIRES_RATES),
    ],
    args: (o) => ['-c:a', { 16: 'pcm_s16be', 24: 'pcm_s24be', 32: 'pcm_s32be' }[o.bitDepth], ...rateArgs(o)],
  },
  alac: {
    label: 'ALAC',
    hint: 'Apple Lossless (.m4a)',
    ext: 'm4a',
    tags: 'ffmpeg',
    numbering: 'slash',
    cover: 'attach',
    options: [
      pick('bitDepth', 'Bit depth', 16, [
        [16, '16-bit'],
        [24, '24-bit'],
      ]),
      rateOption(HIRES_RATES),
    ],
    args: (o) => [
      '-c:a', 'alac',
      ...(o.bitDepth === '16' ? ['-sample_fmt', 's16p'] : ['-sample_fmt', 's32p', '-bits_per_raw_sample', '24']),
      ...rateArgs(o),
    ],
  },
  dsd: {
    label: 'DSD',
    hint: '1-bit DSF, very large files',
    ext: 'dsf',
    tags: 'id3',
    cover: 'id3',
    special: 'dsd',
    options: [
      pick('rate', 'DSD rate', 64, [
        [64, 'DSD64 (2.8 MHz)'],
        [128, 'DSD128 (5.6 MHz)'],
      ]),
    ],
  },
  mp3: {
    label: 'MP3',
    hint: 'Plays everywhere',
    ext: 'mp3',
    tags: 'id3',
    cover: 'id3',
    options: [
      pick('quality', 'Quality', '320', [
        ['320', '320 kbps'],
        ['v0', 'V0 (variable, ~245 kbps)'],
        ['256', '256 kbps'],
        ['192', '192 kbps'],
        ['128', '128 kbps'],
      ]),
      rateOption([44100, 48000]),
    ],
    // Tags are written by our ID3 writer afterwards, so ffmpeg writes none.
    args: (o) => [
      '-c:a', 'libmp3lame',
      ...(o.quality === 'v0' ? ['-q:a', '0'] : ['-b:a', `${o.quality}k`]),
      '-ac', '2',
      '-id3v2_version', '0',
      ...rateArgs(o),
    ],
  },
  aac: {
    label: 'AAC',
    hint: 'Small files (.m4a)',
    ext: 'm4a',
    tags: 'ffmpeg',
    numbering: 'slash',
    cover: 'attach',
    options: [
      pick('bitrate', 'Bitrate', 256, [
        [320, '320 kbps'],
        [256, '256 kbps'],
        [192, '192 kbps'],
        [128, '128 kbps'],
      ]),
      rateOption([44100, 48000]),
    ],
    args: (o) => ['-c:a', 'aac', '-b:a', `${o.bitrate}k`, '-movflags', '+faststart', ...rateArgs(o)],
  },
  opus: {
    label: 'Opus',
    hint: 'Efficient, modern',
    ext: 'opus',
    tags: 'ffmpeg',
    numbering: 'split',
    cover: 'vorbis',
    options: [
      pick('bitrate', 'Bitrate', 160, [
        [256, '256 kbps'],
        [192, '192 kbps'],
        [160, '160 kbps'],
        [128, '128 kbps'],
        [96, '96 kbps'],
      ]),
    ],
    args: (o) => ['-c:a', 'libopus', '-b:a', `${o.bitrate}k`],
  },
  ogg: {
    label: 'OGG',
    hint: 'Ogg Vorbis',
    ext: 'ogg',
    tags: 'ffmpeg',
    numbering: 'split',
    cover: 'vorbis',
    options: [
      pick('quality', 'Quality', 6, [
        [10, 'q10 (~500 kbps)'],
        [8, 'q8 (~256 kbps)'],
        [6, 'q6 (~192 kbps)'],
        [5, 'q5 (~160 kbps)'],
        [3, 'q3 (~112 kbps)'],
      ]),
      rateOption([44100, 48000]),
    ],
    args: (o) => ['-c:a', 'libvorbis', '-q:a', o.quality, ...rateArgs(o)],
  },
  original: {
    label: 'Original',
    hint: 'Untouched stream, no re-encode',
    special: 'original',
    options: [],
  },
};

export const FORMAT_IDS = Object.keys(FORMATS);

/** What the "original" choice becomes for a given source file extension. */
export function originalFormat(srcExt) {
  const copy = () => ['-c:a', 'copy'];
  if (srcExt === 'webm' || srcExt === 'opus') return { ext: 'opus', tags: 'ffmpeg', numbering: 'split', cover: 'vorbis', args: copy };
  if (srcExt === 'm4a' || srcExt === 'mp4') {
    return { ext: 'm4a', tags: 'ffmpeg', numbering: 'slash', cover: 'attach', args: () => ['-c:a', 'copy', '-movflags', '+faststart'] };
  }
  if (srcExt === 'mp3') return { ext: 'mp3', tags: 'id3', cover: 'id3', args: () => ['-c:a', 'copy', '-id3v2_version', '0'] };
  return { ext: 'mka', tags: 'ffmpeg', numbering: 'slash', cover: null, args: copy };
}

/** Arguments that copy the audio of a finished file unchanged, used when its tags are rewritten. */
export function copyArgs(ext) {
  if (ext === 'm4a') return ['-c:a', 'copy', '-movflags', '+faststart'];
  if (ext === 'mp3') return ['-c:a', 'copy', '-id3v2_version', '0'];
  return ['-c:a', 'copy'];
}

/** Rough size of the finished file, used to check the storage limit before converting. */
export function estimateBytes(formatId, o, { duration, sourceRate, sourceBytes }) {
  const rate = o.sampleRate && o.sampleRate !== 'source' ? Number(o.sampleRate) : sourceRate;
  const bits = o.bitDepth === '32f' ? 32 : Number(o.bitDepth) || 16;
  const pcm = (duration * rate * 2 * bits) / 8;
  const kbps = (n) => duration * n * 125;
  switch (formatId) {
    case 'wav':
    case 'aiff':
      return pcm;
    case 'flac':
    case 'alac':
      return pcm * 0.7;
    case 'dsd':
      return (duration * 44100 * Number(o.rate) * 2) / 8;
    case 'mp3':
      return kbps(o.quality === 'v0' ? 245 : Number(o.quality));
    case 'aac':
    case 'opus':
      return kbps(Number(o.bitrate));
    case 'ogg':
      return kbps(Number(o.quality) >= 8 ? 320 : 192);
    default:
      return sourceBytes;
  }
}

/** Validate a format's options against its table and fill in defaults. */
export function resolveOptions(formatId, raw = {}) {
  const format = FORMATS[formatId];
  if (!format) throw new PublicError('That format is not supported.');
  const known = new Map(format.options.map((o) => [o.id, o]));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new PublicError('That option is not available for this format.');
  }
  const out = {};
  for (const opt of format.options) {
    const value = raw[opt.id] === undefined ? opt.default : String(raw[opt.id]);
    if (!opt.values.some((v) => v.value === value)) throw new PublicError(`"${opt.label}" has a value that is not allowed.`);
    out[opt.id] = value;
  }
  return out;
}

/** Format list for the interface. */
export function publicFormats() {
  return FORMAT_IDS.map((id) => {
    const f = FORMATS[id];
    return { id, label: f.label, hint: f.hint, options: f.options.map(({ id: oid, label, values, default: def }) => ({ id: oid, label, values, default: def })) };
  });
}
