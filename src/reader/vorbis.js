// Vorbis comments: the "KEY=value" tags used by FLAC, Ogg Vorbis and Opus,
// and the FLAC picture block that carries cover art in all three.
import { imageType } from './text.js';

const KEYS = {
  TITLE: 'title', ARTIST: 'artist', ARTISTS: 'artists', ALBUM: 'album', ALBUMARTIST: 'albumartist', 'ALBUM ARTIST': 'albumartist',
  ALBUM_ARTIST: 'albumartist', DATE: 'date', YEAR: 'year', ORIGINALDATE: 'originaldate', ORIGINALYEAR: 'originalyear',
  TRACKNUMBER: 'track', TRACKTOTAL: 'tracktotal', TOTALTRACKS: 'tracktotal', DISCNUMBER: 'disk', DISCTOTAL: 'disktotal',
  TOTALDISCS: 'disktotal', GENRE: 'genre', COMPOSER: 'composer', COMMENT: 'comment', DESCRIPTION: 'comment', LYRICS: 'lyrics',
  UNSYNCEDLYRICS: 'lyrics', LABEL: 'label', ORGANIZATION: 'label', PUBLISHER: 'label', ISRC: 'isrc', BPM: 'bpm',
  COPYRIGHT: 'copyright', COMPILATION: 'compilation', ENCODEDBY: 'encodedby', 'ENCODED-BY': 'encodedby', LYRICIST: 'lyricist',
  CONDUCTOR: 'conductor', REMIXER: 'remixer', GROUPING: 'grouping', SUBTITLE: 'subtitle', LANGUAGE: 'language', MOOD: 'mood',
  KEY: 'key', MEDIA: 'media',
};

/** @param {Buffer} buf comment data, with the vendor string at `start` */
export function parseVorbisComment(buf, meta, start = 0) {
  let o = start;
  if (o + 4 > buf.length) return;
  o += 4 + buf.readUInt32LE(o); // vendor string
  if (o + 4 > buf.length) return;
  const count = buf.readUInt32LE(o);
  o += 4;
  for (let i = 0; i < count && i < 10000 && o + 4 <= buf.length; i++) {
    const len = buf.readUInt32LE(o);
    o += 4;
    if (len > buf.length - o) break;
    const eq = buf.indexOf(0x3d, o);
    if (eq > o && eq < o + len) {
      const id = buf.toString('latin1', o, eq).toUpperCase();
      if (id === 'METADATA_BLOCK_PICTURE') {
        try {
          parseFlacPicture(Buffer.from(buf.toString('latin1', eq + 1, o + len), 'base64'), meta);
        } catch {
          // damaged artwork: keep the other tags
        }
      } else {
        meta.tag('vorbis', id, buf.toString('utf8', eq + 1, o + len), KEYS[id]);
      }
    }
    o += len;
  }
}

/** @param {Buffer} buf the body of a FLAC PICTURE block */
export function parseFlacPicture(buf, meta) {
  let o = 0;
  const str = (enc) => {
    const len = buf.readUInt32BE(o);
    const s = buf.toString(enc, o + 4, o + 4 + len);
    o += 4 + len;
    return s;
  };
  const kind = buf.readUInt32BE(o);
  o += 4;
  const mime = str('latin1').toLowerCase();
  const description = str('utf8');
  o += 16; // width, height, colour depth, palette size
  const len = buf.readUInt32BE(o);
  const data = buf.subarray(o + 4, o + 4 + len);
  if (mime === '-->') return; // a link, not an image
  meta.picture('vorbis', { format: imageType(data) || mime || 'image/jpeg', data, description, kind });
}
