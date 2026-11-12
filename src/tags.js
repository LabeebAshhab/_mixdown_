// Tag writing helpers.
//   - ffmetadata text for containers whose tags ffmpeg writes well
//     (FLAC, Ogg, Opus, MP4)
//   - a small ID3v2.3 writer for containers where ffmpeg cannot write lyrics
//     or artwork (MP3, WAV, AIFF, DSF)
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

// ------------------------------------------------------------ ffmetadata

const esc = (s) => String(s).replace(/([=;#\\\n])/g, '\\$1');

/**
 * @param {object} t neutral tags
 * @param {'split'|'slash'} numbering  Vorbis keeps totals in their own fields
 * @param {{lyrics?: string, pictureBlock?: string}} [extra]
 */
export function ffmetadata(t, numbering, { lyrics, pictureBlock } = {}) {
  const pairs = [
    ['title', t.title],
    ['artist', t.artist],
    ['album', t.album],
    ['album_artist', t.albumArtist],
    ['date', t.date],
    ['genre', t.genre],
  ];
  if (numbering === 'split') {
    pairs.push(['track', t.track], ['TRACKTOTAL', t.trackTotal], ['disc', t.disc], ['DISCTOTAL', t.discTotal]);
  } else {
    pairs.push(['track', t.track && t.trackTotal ? `${t.track}/${t.trackTotal}` : t.track]);
    pairs.push(['disc', t.disc && t.discTotal ? `${t.disc}/${t.discTotal}` : t.disc]);
  }
  if (lyrics) pairs.push(['lyrics', lyrics]);
  if (pictureBlock) pairs.push(['METADATA_BLOCK_PICTURE', pictureBlock]);
  const lines = [';FFMETADATA1'];
  for (const [k, v] of pairs) if (v !== null && v !== undefined && v !== '') lines.push(`${k}=${esc(v)}`);
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------ pictures

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) i += 2;
    else i += 2 + buf.readUInt16BE(i + 2);
  }
  return { width: 0, height: 0 };
}

/** base64 FLAC picture block, the way Ogg Vorbis and Opus carry cover art. */
export function vorbisPictureBlock(jpeg) {
  const { width, height } = jpegSize(jpeg);
  const mime = Buffer.from('image/jpeg');
  const head = Buffer.alloc(8 + mime.length + 4 + 20);
  let o = 0;
  o = head.writeUInt32BE(3, o); // front cover
  o = head.writeUInt32BE(mime.length, o);
  o += mime.copy(head, o);
  o = head.writeUInt32BE(0, o); // description length
  o = head.writeUInt32BE(width, o);
  o = head.writeUInt32BE(height, o);
  o = head.writeUInt32BE(24, o); // colour depth
  o = head.writeUInt32BE(0, o); // palette size
  head.writeUInt32BE(jpeg.length, o);
  return Buffer.concat([head, jpeg]).toString('base64');
}

// ------------------------------------------------------------ ID3v2.3

const utf16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(s), 'utf16le')]);
const NUL16 = Buffer.from([0, 0]);

function frame(id, body) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}
const textFrame = (id, value) => frame(id, Buffer.concat([Buffer.from([1]), utf16(value)]));

/** LRC text ("[01:02.30]line") as [milliseconds, line] pairs, in order. */
export function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const stamps = [];
    let rest = raw.trim();
    for (let m; (m = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(rest)); rest = rest.slice(m[0].length)) {
      const fraction = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      stamps.push(Number(m[1]) * 60_000 + Number(m[2]) * 1000 + fraction);
    }
    for (const ms of stamps) out.push([ms, rest.trim()]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** ID3 SYLT frame: lyrics with a time for every line, for players that scroll them. */
function syncedFrame(lrc) {
  const lines = parseLrc(lrc);
  if (lines.length < 3) return null;
  const parts = [Buffer.from([1]), Buffer.from('eng', 'latin1'), Buffer.from([2, 1]), utf16(''), NUL16]; // times in ms, content = lyrics
  for (const [ms, line] of lines) {
    const at = Buffer.alloc(4);
    at.writeUInt32BE(Math.min(ms, 0xffffffff));
    parts.push(utf16(line), NUL16, at);
  }
  return frame('SYLT', Buffer.concat(parts));
}

/**
 * @param {object} t neutral tags
 * @param {{lyrics?: string, synced?: string, cover?: Buffer}} [extra] `synced` is LRC text
 * @returns {Buffer} a complete ID3v2.3 tag
 */
export function buildId3(t, { lyrics, synced, cover } = {}) {
  const frames = [];
  const add = (id, v) => {
    if (v !== null && v !== undefined && v !== '') frames.push(textFrame(id, v));
  };
  add('TIT2', t.title);
  add('TPE1', t.artist);
  add('TALB', t.album);
  add('TPE2', t.albumArtist);
  add('TYER', String(t.date || '').slice(0, 4));
  add('TRCK', t.track && t.trackTotal ? `${t.track}/${t.trackTotal}` : t.track);
  add('TPOS', t.disc && t.discTotal ? `${t.disc}/${t.discTotal}` : t.disc);
  add('TCON', t.genre);
  if (lyrics) {
    frames.push(frame('USLT', Buffer.concat([Buffer.from([1]), Buffer.from('eng', 'latin1'), utf16(''), NUL16, utf16(lyrics)])));
  }
  const timed = synced ? syncedFrame(synced) : null;
  if (timed) frames.push(timed);
  if (cover) {
    frames.push(frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0', 'latin1'), Buffer.from([3, 0]), cover])));
  }
  const body = Buffer.concat(frames);
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 'latin1');
  head[3] = 3; // version 2.3.0
  const n = body.length; // sync-safe size
  head[6] = (n >>> 21) & 0x7f;
  head[7] = (n >>> 14) & 0x7f;
  head[8] = (n >>> 7) & 0x7f;
  head[9] = n & 0x7f;
  return Buffer.concat([head, body]);
}

/** MP3: the tag goes in front of the audio. Writes `dest`, removes `src`. */
export async function writeMp3WithId3(src, dest, tag) {
  const out = createWriteStream(dest);
  out.write(tag);
  // When `src` already starts with a tag (a file being re-tagged), skip it.
  await pipeline(createReadStream(src, { start: await id3Length(src) }), out);
  await fs.rm(src, { force: true });
}

/** Length in bytes of the ID3v2 tag at the start of a file, or 0 when there is none. */
async function id3Length(file) {
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(10);
    const { bytesRead } = await fh.read(head, 0, 10, 0);
    if (bytesRead < 10 || head.toString('latin1', 0, 3) !== 'ID3' || head[6] > 127 || head[7] > 127 || head[8] > 127 || head[9] > 127) return 0;
    const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
    const total = 10 + size + (head[5] & 0x10 ? 10 : 0);
    return total < (await fh.stat()).size ? total : 0;
  } finally {
    await fh.close();
  }
}

async function appendChunk(file, magic, chunkId, sizeIsBigEndian, tag) {
  const fh = await fs.open(file, 'r+');
  try {
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    const { size } = await fh.stat();
    const pad = tag.length % 2;
    const total = size + 8 + tag.length + pad;
    // Plain RIFF/FORM only: sizes are 32-bit. Larger files keep their basic tags.
    if (head.toString('latin1', 0, 4) !== magic || total - 8 > 0xffffffff) return false;
    const chunkHead = Buffer.alloc(8);
    chunkHead.write(chunkId, 0, 'latin1');
    if (sizeIsBigEndian) chunkHead.writeUInt32BE(tag.length, 4);
    else chunkHead.writeUInt32LE(tag.length, 4);
    await fh.write(Buffer.concat([chunkHead, tag, Buffer.alloc(pad)]), 0, 8 + tag.length + pad, size);
    const formSize = Buffer.alloc(4);
    if (sizeIsBigEndian) formSize.writeUInt32BE(total - 8);
    else formSize.writeUInt32LE(total - 8);
    await fh.write(formSize, 0, 4, 4);
    return true;
  } finally {
    await fh.close();
  }
}

/** WAV: ID3 tag in an "id3 " chunk at the end of the RIFF file. */
export const appendWavId3 = (file, tag) => appendChunk(file, 'RIFF', 'id3 ', false, tag);
/** AIFF: ID3 tag in an "ID3 " chunk at the end of the FORM file. */
export const appendAiffId3 = (file, tag) => appendChunk(file, 'FORM', 'ID3 ', true, tag);

/** DSF: the ID3 tag sits at the end and the header points to it. */
export async function appendDsfId3(file, tag) {
  const fh = await fs.open(file, 'r+');
  try {
    const head = Buffer.alloc(28);
    await fh.read(head, 0, 28, 0);
    if (head.toString('latin1', 0, 4) !== 'DSD ') return false;
    // A file being re-tagged already has a tag at the end: cut it off first.
    const old = head.readBigUInt64LE(20);
    if (old >= 28n && old < BigInt((await fh.stat()).size)) await fh.truncate(Number(old));
    const { size } = await fh.stat();
    await fh.write(tag, 0, tag.length, size);
    const fields = Buffer.alloc(16);
    fields.writeBigUInt64LE(BigInt(size + tag.length), 0); // total file size
    fields.writeBigUInt64LE(BigInt(size), 8); // pointer to the tag
    await fh.write(fields, 0, 16, 12);
    return true;
  } finally {
    await fh.close();
  }
}
