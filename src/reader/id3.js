// ID3v2.2, 2.3 and 2.4 tags (MP3, and the tag this app writes into WAV, AIFF
// and DSF), plus the old 128-byte ID3v1 tag at the end of MP3 files.
import { MAX_BLOCK } from './source.js';
import { clean, cstring, decode, GENRES, imageType } from './text.js';

const FRAMES = {
  // v2.3 / v2.4
  TIT2: 'title', TPE1: 'artist', TPE2: 'albumartist', TALB: 'album', TYER: 'year', TDRC: 'date', TDOR: 'originaldate',
  TORY: 'originalyear', TRCK: 'track', TPOS: 'disk', TCON: 'genre', TCOM: 'composer', COMM: 'comment', USLT: 'lyrics',
  TPUB: 'label', TSRC: 'isrc', TBPM: 'bpm', TCOP: 'copyright', TENC: 'encodedby', TSSE: 'encodersettings',
  TIT1: 'grouping', TIT3: 'subtitle', TCMP: 'compilation', TEXT: 'lyricist', TPE3: 'conductor', TPE4: 'remixer',
  TLAN: 'language', TKEY: 'key', TMOO: 'mood', TMED: 'media', TOPE: 'originalartist',
  // v2.2
  TT2: 'title', TP1: 'artist', TP2: 'albumartist', TAL: 'album', TYE: 'year', TRK: 'track', TPA: 'disk', TCO: 'genre',
  TCM: 'composer', COM: 'comment', ULT: 'lyrics', TPB: 'label', TBP: 'bpm', TCR: 'copyright', TEN: 'encodedby',
  TSS: 'encodersettings', TT1: 'grouping', TT3: 'subtitle', TCP: 'compilation',
};
const USER_TEXT = { ARTISTS: 'artists', ISRC: 'isrc', LABEL: 'label', ORIGINALYEAR: 'originalyear' };

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

/** Total size of the ID3v2 tag that starts in `head` (10+ bytes), or 0 when there is none. */
export function id3v2Size(head) {
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3' || head[3] === 0xff || head[4] === 0xff) return 0;
  if ((head[6] | head[7] | head[8] | head[9]) & 0x80) return 0;
  return 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
}

/** Read the ID3v2 tag at `pos`, if there is one. Returns its total size (0 = none). */
export async function readId3v2(src, pos, meta) {
  const size = id3v2Size(await src.read(pos, 10));
  if (size && size <= MAX_BLOCK) parseId3v2(await src.read(pos, size), meta);
  return size;
}

/** Undo "unsynchronisation": every FF 00 was written in place of FF. */
function unsync(buf) {
  if (buf.indexOf(0xff) < 0) return buf;
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    out[n++] = buf[i];
    if (buf[i] === 0xff && buf[i + 1] === 0) i++;
  }
  return out.subarray(0, n);
}

const FRAME_ID = /^[A-Z0-9]+$/;

/** v2.4 sizes are sync-safe, but some writers stored plain sizes. Trust the one that lands on a frame. */
function frameSize24(body, o) {
  const plain = body.readUInt32BE(o + 4);
  if ((body[o + 4] | body[o + 5] | body[o + 6] | body[o + 7]) & 0x80) return plain;
  const safe = syncsafe(body, o + 4);
  if (plain === safe) return safe;
  const lands = (n) => {
    const next = o + 10 + n;
    return next === body.length || (next + 4 <= body.length && (body[next] === 0 || FRAME_ID.test(body.toString('latin1', next, next + 4))));
  };
  return !lands(safe) && lands(plain) ? plain : safe;
}

/** @param {Buffer} buf a whole tag, starting at "ID3" */
export function parseId3v2(buf, meta) {
  const major = buf[3];
  if (id3v2Size(buf) === 0 || major < 2 || major > 4) return;
  const type = `ID3v2.${major}`;
  const tagFlags = buf[5];
  let body = buf.subarray(10, 10 + syncsafe(buf, 6));
  if (tagFlags & 0x80 && major < 4) body = unsync(body);

  let o = 0;
  if (tagFlags & 0x40) {
    if (major === 2) return; // v2.2 "compression": never defined, nothing can be read
    if (body.length < 4) return;
    o = major === 3 ? 4 + body.readUInt32BE(0) : syncsafe(body, 0);
  }
  const idLen = major === 2 ? 3 : 4;
  const headLen = major === 2 ? 6 : 10;

  for (let n = 0; n < 5000 && o + headLen <= body.length; n++) {
    if (body[o] === 0) break; // padding
    const id = body.toString('latin1', o, o + idLen);
    if (!FRAME_ID.test(id)) break;
    const size = major === 2 ? body.readUIntBE(o + 3, 3) : major === 3 ? body.readUInt32BE(o + 4) : frameSize24(body, o);
    const flags = major === 2 ? 0 : body.readUInt16BE(o + 8);
    const start = o + headLen;
    const end = start + size;
    if (end > body.length) break;
    o = end;
    if (size === 0) continue;

    let data = body.subarray(start, end);
    if (major === 3) {
      if (flags & 0x00c0) continue; // compressed or encrypted
      if (flags & 0x0020) data = data.subarray(1); // group id
    } else if (major === 4) {
      if (flags & 0x000c) continue; // compressed or encrypted
      if (flags & 0x0040) data = data.subarray(1); // group id
      if (flags & 0x0001) data = data.subarray(4); // data length indicator
      if (flags & 0x0002 || tagFlags & 0x80) data = unsync(data);
    }
    try {
      frame(type, id, data, meta);
    } catch {
      // one damaged frame does not spoil the rest
    }
  }
}

/** "(17)", "(17)Rock", "17", "Rock", "(RX)" */
function genres(text) {
  const name = (n) => (n === 'RX' ? 'Remix' : n === 'CR' ? 'Cover' : GENRES[Number(n)] || n);
  const out = [];
  let rest = text;
  for (let m; (m = /^\((\d+|RX|CR)\)/.exec(rest)); rest = rest.slice(m[0].length)) out.push(name(m[1]));
  if (rest.startsWith('((')) rest = rest.slice(1);
  if (rest) out.push(/^\d+$/.test(rest) ? name(rest) : rest);
  return out;
}

function frame(type, id, d, meta) {
  const key = FRAMES[id];

  if (id === 'APIC' || id === 'PIC') {
    const enc = d[0];
    let format;
    let o;
    if (id === 'PIC') {
      format = { JPG: 'image/jpeg', PNG: 'image/png' }[d.toString('latin1', 1, 4).toUpperCase()];
      o = 4;
    } else {
      const mime = cstring(d, 1, 0);
      format = mime.text.toLowerCase().replace('image/jpg', 'image/jpeg');
      o = mime.next;
    }
    const kind = d[o];
    const desc = cstring(d, o + 1, enc);
    const data = d.subarray(desc.next);
    if (format === '-->') return; // a link, not an image
    meta.picture(type, { format: imageType(data) || format || 'image/jpeg', data, description: desc.text, kind });
    return;
  }

  if (id === 'COMM' || id === 'USLT' || id === 'COM' || id === 'ULT') {
    const enc = d[0];
    const desc = cstring(d, 4, enc); // after the 3-letter language
    const text = decode(d.subarray(desc.next), enc).replace(/\0+$/, '').replace(/^﻿/, '');
    if (id[0] === 'C' && /^iTun/.test(desc.text)) return meta.raw(type, `${id}:${desc.text}`, text); // iTunes gapless data, not a comment
    return meta.tag(type, id, text.trim(), key);
  }

  if (id === 'TXXX' || id === 'TXX' || id === 'WXXX' || id === 'WXX') {
    const enc = d[0];
    const desc = cstring(d, 1, enc);
    const value = clean(decode(d.subarray(desc.next), id[0] === 'W' ? 0 : enc));
    return meta.tag(type, `${id}:${desc.text}`, value, id[0] === 'T' ? USER_TEXT[desc.text.toUpperCase()] : undefined);
  }

  if (id[0] === 'T') {
    // v2.4 allows several values, separated by NUL
    const values = decode(d.subarray(1), d[0]).split('\0').map(clean).filter(Boolean);
    for (const v of values) {
      meta.raw(type, id, v);
      if (key === 'genre') for (const g of genres(v)) meta.set(type, 'genre', g);
      else if (key) meta.set(type, key, v);
    }
    return;
  }

  if (id[0] === 'W') meta.raw(type, id, clean(d.toString('latin1')));
}

/** The 128-byte tag at the very end of the file. Returns true when present. */
export async function readId3v1(src, meta) {
  if (src.size < 128) return false;
  const b = await src.read(src.size - 128, 128);
  if (b.length < 128 || b.toString('latin1', 0, 3) !== 'TAG') return false;
  const field = (id, key, from, to) => {
    const v = clean(b.toString('latin1', from, to));
    if (v) meta.tag('ID3v1', id, v, key);
  };
  const v11 = b[125] === 0 && b[126] !== 0; // v1.1 keeps a track number in the last comment byte
  field('title', 'title', 3, 33);
  field('artist', 'artist', 33, 63);
  field('album', 'album', 63, 93);
  field('year', 'year', 93, 97);
  field('comment', 'comment', 97, v11 ? 125 : 127);
  if (v11) meta.tag('ID3v1', 'track', b[126], 'track');
  if (GENRES[b[127]]) meta.tag('ID3v1', 'genre', GENRES[b[127]], 'genre');
  return true;
}
