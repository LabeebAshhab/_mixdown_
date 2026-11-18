// Reads one uploaded file and prints what it found as a single line of JSON.
//
// This runs as its own short-lived process, started by src/inspect.js for
// every upload, so that a hostile file meets as little as possible:
//   - the process may read this folder and the one uploaded file, and nothing
//     else; it may not write, start programs or load native code (Node's
//     permission model, when the runtime has it)
//   - its memory is capped and it is killed when it runs too long
//   - it cannot build code from text (no eval)
// A file that crashes it, hangs it or fills its memory takes down only this
// process. The server checks every field of what is printed here before
// passing it on (the schema in src/inspect.js).
//
// usage: node inspect-child.js <file> <allowed type ids, comma separated> [keep]
//
// With "keep" the answer also holds what is needed to write the file's tags
// again after the visitor edits them: its lyrics, the common tags the editor
// does not show, and its picture. All of it leaves this process as plain text
// (the picture as base64); the server checks it like the rest.
import fs from 'node:fs/promises';
import { sniff, typeOf } from './inspect-types.js';
import { readAudio } from './reader/index.js';

const MAX_TEXT = 300;
const MAX_LYRICS = 100_000;
const MAX_KEPT_PICTURE = 12 * 1024 * 1024;
// Must match KEPT_KEYS in src/tags.js, which this process may not import from
// (it reads only what it needs). The server's schema refuses any other name.
const KEPT = ['composer', 'comment', 'copyright', 'grouping', 'compilation', 'bpm', 'label', 'isrc', 'subtitle', 'lyricist', 'conductor', 'remixer', 'language', 'key', 'media', 'mood'];

/** Plain text: no control characters, no characters that reorder or hide text, cut to length. */
function plain(value, max = MAX_TEXT) {
  const s = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​‎‏‪-‮⁠⁦-⁩﻿]+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** What an embedded picture really is, from its first bytes (not from what the tag claims). */
function imageType(data) {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (data.length > 6 && /^GIF8[79]a$/.test(data.toString('latin1', 0, 6))) return 'image/gif';
  if (data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function describe({ format, common, native }) {
  const tags = {};
  for (const [k, v] of Object.entries(common)) {
    if (k === 'picture' || v === null || v === undefined) continue;
    if (k === 'lyrics') {
      if (Array.isArray(v) && v.length) tags.lyrics = 'embedded';
    } else if (typeof v === 'string') tags[k] = plain(v);
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) tags[k] = v;
    } else if (typeof v === 'boolean') tags[k] = v;
    else if (Array.isArray(v)) {
      const list = v.filter((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))).slice(0, 20);
      tags[k] = list.map((x) => (typeof x === 'string' ? plain(x) : x));
    } else if (k === 'track' || k === 'disk') tags[k] = { no: number(v.no) ?? null, of: number(v.of) ?? null };
  }

  const raw = {};
  for (const [type, list] of Object.entries(native || {})) {
    raw[type] = list
      .filter((t) => typeof t.value === 'string' || typeof t.value === 'number')
      .slice(0, 80)
      .map((t) => ({ id: plain(t.id, 60), value: plain(t.value) }));
  }

  const pic = common.picture?.[0];
  const data = pic && Buffer.isBuffer(pic.data) ? pic.data : pic?.data ? Buffer.from(pic.data) : null;
  const mime = data ? imageType(data) : null;
  return {
    format: {
      container: format.container === undefined ? undefined : plain(format.container, 40),
      codec: format.codec === undefined ? undefined : plain(format.codec, 60),
      lossless: typeof format.lossless === 'boolean' ? format.lossless : undefined,
      sampleRate: number(format.sampleRate),
      bitsPerSample: number(format.bitsPerSample),
      numberOfChannels: number(format.numberOfChannels),
      bitrate: number(format.bitrate),
      duration: number(format.duration),
      tagTypes: (Array.isArray(format.tagTypes) ? format.tagTypes : []).slice(0, 20).map((t) => plain(t, 40)),
    },
    tags,
    raw,
    picture: data
      ? {
          format: mime || 'unknown',
          bytes: data.length,
          // Shown in the page only when the bytes really are a picture a browser draws.
          dataUrl: mime && data.length < 3_000_000 ? `data:${mime};base64,${data.toString('base64')}` : null,
        }
      : null,
  };
}

/** Text that may span lines (lyrics): the same cleaning, line breaks kept. */
function lines(value, max) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]+/g, ' ')
    .trim()
    .slice(0, max);
}

/** What has to survive an edit: lyrics, the common tags the editor does not show, the picture. */
function keepable({ common }) {
  const kept = {};
  for (const key of KEPT) {
    const v = common[key];
    let text = '';
    if (typeof v === 'boolean') text = v ? '1' : '';
    else if (Array.isArray(v)) text = v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => plain(x)).filter(Boolean).slice(0, 10).join('; ');
    else if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) text = plain(v, key === 'comment' ? 2000 : MAX_TEXT);
    if (text) kept[key] = text.slice(0, 2000);
  }
  const words = Array.isArray(common.lyrics) ? common.lyrics.find((x) => typeof x === 'string' && x.trim()) : null;
  const pic = common.picture?.[0];
  const data = pic && Buffer.isBuffer(pic.data) ? pic.data : null;
  // Only a picture the server can re-encode travels on: JPEG, PNG or WebP of a sensible size.
  const usable = data && ['image/jpeg', 'image/png', 'image/webp'].includes(imageType(data)) && data.length <= MAX_KEPT_PICTURE;
  return {
    kept,
    lyrics: words ? lines(words, MAX_LYRICS) : null,
    picture: usable ? data.toString('base64') : null,
    pictureLost: !!data && !usable,
  };
}

async function main() {
  const [file, list, mode] = process.argv.slice(2);
  const allowed = new Set(String(list || '').split(','));

  // 1. The first bytes decide whether this is worth reading at all.
  const fh = await fs.open(file, 'r');
  let head;
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(64), 0, 64, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const first = sniff(head);
  if (!first) return { ok: false, code: 'not-audio' };
  if (!allowed.has(first)) return { ok: false, code: 'type' };

  // 2. Read it, then check again: what counts is what the reader really found.
  const result = await readAudio(file, { timeoutMs: 20_000 });
  const type = typeOf(result.format);
  if (!type || !allowed.has(type)) return { ok: false, code: 'type' };
  const answer = { ok: true, type, report: describe(result) };
  if (mode === 'keep') answer.keep = keepable(result);
  return answer;
}

let answer;
try {
  answer = await main();
} catch (e) {
  answer = { ok: false, code: ['unsupported', 'corrupt', 'limit'].includes(e?.code) ? e.code : 'failed' };
}
process.stdout.write(JSON.stringify(answer), () => process.exit(0));
