// Audio file reader: tags, artwork and audio properties, straight from the
// file's bytes. Written for this app, so it covers the formats the app
// produces and accepts: MP3, FLAC, WAV, AIFF, M4A/MP4 (AAC, ALAC), Ogg
// (Opus, Vorbis, FLAC), DSF and Matroska/WebM.
//
// The result has the shape { format, common, native } that music-metadata
// (https://github.com/Borewit/music-metadata, MIT) established and that this
// app used before; the parsing itself is this project's own code.
import { readDsf } from './dsf.js';
import { readFlac } from './flac.js';
import { readId3v2 } from './id3.js';
import { readMatroska } from './matroska.js';
import { Meta } from './meta.js';
import { readMp4 } from './mp4.js';
import { readMpeg } from './mpeg.js';
import { readOgg } from './ogg.js';
import { readAiff, readWav } from './riff.js';
import { ReadError, Source } from './source.js';

export { ReadError };

/**
 * @param {string} file path of the audio file
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{format: object, common: object, native: object}>}
 * @throws {ReadError} code 'unsupported', 'corrupt' or 'limit'
 */
export async function readAudio(file, { timeoutMs = 30_000 } = {}) {
  const src = await Source.open(file, timeoutMs);
  try {
    const meta = new Meta();

    // ID3v2 tags sit in front of MP3 audio, and sometimes in front of FLAC.
    let start = 0;
    for (let n = 0; n < 4; n++) {
      const size = await readId3v2(src, start, meta);
      if (!size) break;
      start += size;
    }

    const magic = await src.read(start, 12);
    const at = (a, b) => magic.toString('latin1', a, b);
    if (at(0, 4) === 'fLaC') await readFlac(src, meta, start);
    else if (start > 0) {
      if (!(await readMpeg(src, meta, start))) throw new ReadError('unsupported');
    } else if (at(0, 4) === 'OggS') await readOgg(src, meta);
    else if ((at(0, 4) === 'RIFF' || at(0, 4) === 'RF64') && at(8, 12) === 'WAVE') await readWav(src, meta);
    else if (at(0, 4) === 'FORM' && (at(8, 12) === 'AIFF' || at(8, 12) === 'AIFC')) await readAiff(src, meta, at(8, 12) === 'AIFC');
    else if (at(0, 4) === 'DSD ') await readDsf(src, meta);
    else if (at(4, 8) === 'ftyp') await readMp4(src, meta);
    else if (magic.length >= 4 && magic.readUInt32BE(0) === 0x1a45dfa3) await readMatroska(src, meta);
    else if (!(await readMpeg(src, meta, 0))) throw new ReadError('unsupported');

    return meta.finish();
  } catch (e) {
    // Reading past the end of a buffer means the file is cut short or lying about a size.
    if (e instanceof RangeError || e?.code === 'ERR_OUT_OF_RANGE' || e?.code === 'ERR_BUFFER_OUT_OF_BOUNDS') throw new ReadError('corrupt');
    throw e;
  } finally {
    await src.close();
  }
}
