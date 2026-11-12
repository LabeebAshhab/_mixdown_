// The kinds of audio file the metadata inspector can accept, and how a file
// is recognised as one of them. Nothing here trusts a file's name or the type
// a browser declares for it: only its bytes count. No imports, so the settings
// (config.js), the server (inspect.js) and the reading process
// (inspect-child.js) can all share it.

/** id -> name shown to visitors, and the file endings offered in the file picker. */
export const INSPECT_TYPES = {
  mp3: { label: 'MP3', ext: ['mp3'] },
  flac: { label: 'FLAC', ext: ['flac'] },
  wav: { label: 'WAV', ext: ['wav'] },
  aiff: { label: 'AIFF', ext: ['aiff', 'aif'] },
  m4a: { label: 'M4A', ext: ['m4a', 'mp4', 'm4b'] },
  ogg: { label: 'Ogg', ext: ['ogg', 'oga'] },
  opus: { label: 'Opus', ext: ['opus'] },
  dsf: { label: 'DSF', ext: ['dsf'] },
  mka: { label: 'Matroska', ext: ['mka', 'webm'] },
};

/** Other names an administrator may write in INSPECT_TYPES. */
export const TYPE_ALIASES = { aif: 'aiff', mp4: 'm4a', m4b: 'm4a', alac: 'm4a', aac: 'm4a', oga: 'ogg', vorbis: 'ogg', dsd: 'dsf', matroska: 'mka', mkv: 'mka', webm: 'mka' };

/**
 * The kind of file these first bytes (64 or more) belong to, or null when they
 * are not the start of an audio file the inspector reads. A file starting with
 * an ID3 tag is taken for MP3 here; typeOf() below has the last word.
 * @param {Buffer} head
 */
export function sniff(head) {
  if (!head || head.length < 12) return null;
  const at = (a, b) => head.toString('latin1', a, b);
  if (at(0, 4) === 'fLaC') return 'flac';
  if (at(0, 3) === 'ID3') return 'mp3';
  if (at(0, 4) === 'OggS') return head.includes('OpusHead', 0, 'latin1') ? 'opus' : 'ogg';
  if ((at(0, 4) === 'RIFF' || at(0, 4) === 'RF64') && at(8, 12) === 'WAVE') return 'wav';
  if (at(0, 4) === 'FORM' && (at(8, 12) === 'AIFF' || at(8, 12) === 'AIFC')) return 'aiff';
  if (at(0, 4) === 'DSD ') return 'dsf';
  if (at(4, 8) === 'ftyp') return 'm4a';
  if (head.readUInt32BE(0) === 0x1a45dfa3) return 'mka';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3'; // an MPEG audio frame
  return null;
}

/**
 * The kind of file the reader actually found, from what it reports once the
 * whole file has been parsed.
 * @param {{container?: string, codec?: string}} format
 */
export function typeOf(format) {
  const container = String(format?.container || '');
  if (container === 'MPEG') return 'mp3';
  if (container === 'FLAC') return 'flac';
  if (container === 'WAVE') return 'wav';
  if (container === 'AIFF' || container === 'AIFF-C') return 'aiff';
  if (container === 'DSF') return 'dsf';
  if (container === 'Ogg') return /opus/i.test(String(format.codec || '')) ? 'opus' : 'ogg';
  if (container === 'Matroska' || container === 'WebM') return 'mka';
  if (['M4A', 'M4B', 'M4P', 'MP4', 'QuickTime'].includes(container)) return 'm4a';
  return null;
}
