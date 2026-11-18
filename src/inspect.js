// The metadata inspector: a stranger's file comes in, a description of it
// goes out, and, when the visitor wants to correct its tags, the file stays
// for a short while and goes back to them. The layers, in the order an upload
// meets them:
//   1. before a byte is sent the browser says how large the file is. That
//      much room is set aside under the same limits as a download (per
//      browser, per address, whole server), one file per browser at a time
//   2. the file arrives in pieces, each of them raw bytes of exactly the size
//      and at exactly the place the server expects, each within a time limit.
//      Pieces keep one request small enough for any proxy in front
//   3. the first piece already has to start like an audio file this server
//      accepts, or the upload ends there
//   4. the file is written under a random name; its own name never arrives
//   5. it is read by a separate, locked-down process (src/inspect-child.js),
//      which accepts only the kinds of file listed in INSPECT_TYPES, judged by
//      the file's bytes
//   6. every field of that process's answer is checked against a strict
//      schema before it is used or sent to the page, which shows it as text
//   7. a file that is only looked at is deleted at once. One kept for editing
//      becomes a job of its own browser (src/jobs.js). Its tags are written
//      again from text and its picture is re-encoded, never copied over as
//      bytes; ffmpeg, which copies the audio, is told what kind of file it is
//      and may open nothing but files (EDIT below, src/pipeline.js)
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { INSPECT_TYPES, sniff } from './inspect-types.js';
import { adoptUpload, holdsUpload, publicJob, releaseUpload, reserveUpload } from './jobs.js';
import { downloadName } from './pipeline.js';
import { run } from './proc.js';
import { cleanText, insideDir, PublicError } from './security.js';
import { KEPT_KEYS } from './tags.js';

const CHILD = fileURLToPath(new URL('./inspect-child.js', import.meta.url));
const SRC_DIR = path.dirname(CHILD);
const READ_TIMEOUT = 30_000; // the reading process is killed after this
const MAX_ANSWER = 6 * 1024 * 1024; // its answer, artwork included
const MAX_ANSWER_KEEP = 26 * 1024 * 1024; // the same, when the file's own picture comes along for editing
const MAX_READERS = 2; // reading processes at the same time
const MAX_UPLOADS = 6; // files on their way in at the same time, all visitors together
const MAX_UPLOADS_PER_ADDRESS = 2;

/** The kinds this server accepts, for the page: [{ label, ext }]. */
export const acceptedTypes = () => config.inspectTypes.map((id) => ({ label: INSPECT_TYPES[id].label, ext: INSPECT_TYPES[id].ext }));

const typeNames = () => {
  const names = config.inspectTypes.map((id) => INSPECT_TYPES[id].label);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};
const notAccepted = () => new PublicError(`That kind of file is not accepted here. The inspector reads ${typeNames()} files.`, 415);
const notAudio = () => new PublicError('That does not look like an audio file.', 415);

// How a kept file is written again, by kind. `demuxer` is the one way ffmpeg
// may read it: without it ffmpeg would guess from the bytes, and among its
// guesses are playlist formats that make it open other files and addresses.
// DSF is not read by ffmpeg at all (its tag is replaced in place).
const EDIT = {
  mp3: { ext: 'mp3', tags: 'id3', cover: 'id3', demuxer: 'mp3' },
  flac: { ext: 'flac', tags: 'ffmpeg', numbering: 'split', cover: 'attach', demuxer: 'flac' },
  wav: { ext: 'wav', tags: 'id3', cover: 'id3', demuxer: 'wav' },
  aiff: { ext: 'aiff', tags: 'id3', cover: 'id3', demuxer: 'aiff' },
  m4a: { ext: 'm4a', tags: 'ffmpeg', numbering: 'slash', cover: 'attach', demuxer: 'mov' },
  ogg: { ext: 'ogg', tags: 'ffmpeg', numbering: 'split', cover: 'vorbis', demuxer: 'ogg' },
  opus: { ext: 'opus', tags: 'ffmpeg', numbering: 'split', cover: 'vorbis', demuxer: 'ogg' },
  dsf: { ext: 'dsf', tags: 'id3', cover: 'id3', special: 'dsd' },
  mka: { ext: 'mka', tags: 'ffmpeg', numbering: 'slash', cover: null, demuxer: 'matroska' },
};
const inputArgs = (spec) => (spec.demuxer ? ['-f', spec.demuxer, '-protocol_whitelist', 'file', '-max_streams', '32'] : []);

// ------------------------------------------------------------ the request

export const tooLarge = (max) => new PublicError(`That file is larger than ${Math.round(max / 1048576)} MB.`, 413);

/**
 * Refuse an upload from its headers alone, before a byte of it is read. The
 * body has to be raw bytes (the page sends application/octet-stream), not a
 * form and not compressed, and it has to say how long it is.
 */
export function checkUpload(req, max) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream') throw new PublicError('That upload was not sent the way this page sends files.', 415);
  const encoding = String(req.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') throw new PublicError('Compressed uploads are not accepted.', 415);
  const declared = String(req.headers['content-length'] ?? '');
  if (!/^\d{1,15}$/.test(declared)) throw new PublicError('That upload did not say how large it is.', 411);
  const size = Number(declared);
  if (size > max) throw tooLarge(max);
  if (size < 1) throw new PublicError('That file is empty.');
  return size;
}

/** Lets `max` bytes through and counts them; one more is an error. */
function byteLimit(max, count) {
  return new Transform({
    transform(chunk, _enc, cb) {
      count.bytes += chunk.length;
      cb(count.bytes > max ? tooLarge(max) : null, chunk);
    },
  });
}

/** Write one piece into `file` at `offset`, giving up when it is not exactly `bytes` long or takes longer than `ms`. */
async function receive(req, file, offset, bytes, ms) {
  const count = { bytes: 0 };
  try {
    await pipeline(req, byteLimit(bytes, count), createWriteStream(file, { flags: 'r+', start: offset }), { signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e?.public) throw e;
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ABORT_ERR') {
      throw new PublicError('That upload took too long, so it was stopped.', 408);
    }
    throw new PublicError('That upload did not arrive in one piece. Try again.');
  }
  if (count.bytes !== bytes) throw new PublicError('That upload did not arrive in one piece. Try again.');
}

// ------------------------------------------------------------ the answer's shape

// What the reading process may say. Anything else, a field too many or a text
// too long, and the whole answer is thrown away.
const text = z.string().max(302);
const count = z.number().finite().nonnegative();
const key = z.string().regex(/^[A-Za-z0-9 _.:-]{1,40}$/);
const position = z.object({ no: count.nullable(), of: count.nullable() }).strict();
const reportSchema = z
  .object({
    format: z
      .object({
        container: z.string().max(42).optional(),
        codec: z.string().max(62).optional(),
        lossless: z.boolean().optional(),
        sampleRate: count.optional(),
        bitsPerSample: count.optional(),
        numberOfChannels: count.optional(),
        bitrate: count.optional(),
        duration: count.optional(),
        tagTypes: z.array(z.string().max(42)).max(20),
      })
      .strict(),
    tags: z.record(key, z.union([text, z.number().finite(), z.boolean(), z.array(z.union([text, z.number().finite()])).max(20), position])),
    raw: z.record(key, z.array(z.object({ id: z.string().max(62), value: text }).strict()).max(80)),
    picture: z
      .object({
        format: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'unknown']),
        bytes: count,
        dataUrl: z
          .string()
          .max(4_100_000)
          .regex(/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
// What comes along for editing: lyrics, the common tags the editor does not
// show (only the names in KEPT_KEYS), and the file's own picture as base64.
const keepSchema = z
  .object({
    kept: z.record(z.enum(KEPT_KEYS), z.string().min(1).max(2000)),
    lyrics: z.string().max(100_000).nullable(),
    picture: z
      .string()
      .max(16_100_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .nullable(),
    pictureLost: z.boolean(),
  })
  .strict();
const answerSchema = z.union([
  z.object({ ok: z.literal(true), type: z.enum(Object.keys(INSPECT_TYPES)), report: reportSchema, keep: keepSchema.optional() }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['not-audio', 'type', 'unsupported', 'corrupt', 'limit', 'failed']) }).strict(),
]);

// ------------------------------------------------------------ the reading process

// How the reading process is confined. Decided once at start by trying it
// (see initInspector): Node's permission model under its current name, then
// under its older one, then without it on a runtime that has neither.
let confinement; // undefined = not tried yet, null = inspector unavailable, '' = this runtime has no permission model

function nodeArgs(flag, file, keep) {
  // Carrying a picture of up to 12 MB out as text needs more room than a plain reading.
  const args = [`--max-old-space-size=${keep ? 384 : 256}`, '--disallow-code-generation-from-strings', '--no-warnings'];
  if (flag) {
    args.push(flag, `--allow-fs-read=${path.join(SRC_DIR, '*')}`, `--allow-fs-read=${path.join(config.root, 'package.json')}`, `--allow-fs-read=${file}`);
  }
  return args;
}

async function ask(flag, file, types, keep = false) {
  const out = await run(process.execPath, [...nodeArgs(flag, file, keep), CHILD, file, types.join(','), ...(keep ? ['keep'] : [])], {
    timeout: READ_TIMEOUT,
    maxOutput: keep ? MAX_ANSWER_KEEP : MAX_ANSWER,
  });
  return answerSchema.parse(JSON.parse(out));
}

// At most MAX_READERS reading processes run at once; the next file waits its turn.
let reading = 0;
const waiting = [];
async function withReader(work) {
  if (reading >= MAX_READERS) await new Promise((go) => waiting.push(go));
  reading++;
  try {
    return await work();
  } finally {
    reading--;
    waiting.shift()?.();
  }
}

/** Read one file and turn every way it can go wrong into a sentence for the visitor. */
async function describe(file, types, keep) {
  let answer;
  try {
    answer = await withReader(() => ask(confinement, file, types, keep));
  } catch (e) {
    if (e?.kind === 'timeout') throw new PublicError('That file took too long to read.');
    console.warn(`[inspect] reading failed: ${e?.kind || e?.name || 'error'}`);
    throw new PublicError('That file could not be read.');
  }
  if (answer.ok) return answer;
  if (answer.code === 'not-audio') throw notAudio();
  if (answer.code === 'type' || answer.code === 'unsupported') throw notAccepted();
  if (answer.code === 'limit') throw new PublicError('That file took too long to read.');
  throw new PublicError('That file could not be read. It may be damaged.');
}

/** A second of silence as a WAV file: the smallest thing the reader can be tried on. */
function sampleWav() {
  const samples = Buffer.alloc(16000);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + samples.length, 4);
  head.write('WAVEfmt ', 8, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(8000, 24);
  head.writeUInt32LE(16000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(samples.length, 40);
  return Buffer.concat([head, samples]);
}

/**
 * Try the reading process once, at start, to learn how it can be confined on
 * this runtime. Returns a short description for the log.
 */
export async function initInspector() {
  if (!config.inspect) {
    confinement = null;
    return 'off';
  }
  const file = insideDir(config.dataDir, `upload-${randomUUID()}`);
  await fs.writeFile(file, sampleWav(), { flag: 'wx', mode: 0o600 });
  try {
    for (const flag of ['--permission', '--experimental-permission', '']) {
      try {
        const answer = await ask(flag, file, Object.keys(INSPECT_TYPES));
        if (answer.ok && answer.type === 'wav') {
          confinement = flag;
          setInterval(() => sweep().catch(() => {}), 20_000).unref();
          return `on (${config.inspectTypes.join(', ')}; files up to ${Math.round(config.maxUploadBytes / 1048576)} MB${config.inspectEdit ? ', tags can be edited' : ', read only'}), read in a separate process${flag ? ' with file access limited to the upload' : ''}`;
        }
      } catch {
        /* this runtime does not know the flag, or refuses it: try the next */
      }
    }
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
  confinement = null;
  return 'UNAVAILABLE (the reading process could not be started)';
}

// ------------------------------------------------------------ files on their way in

/**
 * @typedef {{id: string, sid: string, ip: string, size: number, keep: boolean, received: number, file: string,
 *   startedAt: number, touchedAt: number, busy: boolean, gone: boolean}} Upload
 * @type {Map<string, Upload>}
 */
const uploads = new Map();

/** Forget an upload: its file is deleted and the room set aside for it is given back. */
async function drop(up) {
  if (up.gone) return;
  up.gone = true;
  uploads.delete(up.id);
  await fs.rm(up.file, { force: true }).catch(() => {});
  releaseUpload(up.id);
}

/** An upload nobody is sending any more, or one that has taken too long as a whole, is dropped. */
async function sweep() {
  const now = Date.now();
  for (const up of [...uploads.values()]) {
    if (up.busy) continue;
    if (now - up.touchedAt > config.timeouts.upload + 30_000 || now - up.startedAt > config.timeouts.uploadTotal) await drop(up);
  }
}

function ready() {
  if (!config.inspect || confinement === null) throw new PublicError('The inspector is switched off on this server.', 404);
  if (confinement === undefined) throw new PublicError('The inspector is not ready yet. Try again in a moment.', 503);
}

/**
 * Step one: the browser says how large its file is and whether it wants to
 * edit it afterwards. Nothing of the file has been sent yet.
 * @returns {Promise<{id: string, piece: number}>} the id to send the pieces under, and how large a piece is
 */
export async function startUpload(req, { size, keep }) {
  ready();
  if (size > config.maxUploadBytes) throw tooLarge(config.maxUploadBytes);
  if (size < 64) throw notAudio();
  const who = req.ip || 'unknown';
  // One file per browser at a time: the one it is still working on comes first.
  if (holdsUpload(req.sid)) {
    throw new PublicError('You still have a file here. Download it or remove it, then inspect the next one.', 409);
  }
  // A new file from the same browser takes the place of one it stopped sending.
  for (const old of [...uploads.values()]) {
    if (old.sid !== req.sid) continue;
    if (old.busy) throw new PublicError('One file at a time: wait for the last one to finish.', 429);
    await drop(old);
  }
  let here = 0;
  for (const up of uploads.values()) if (up.ip === who) here++;
  if (here >= MAX_UPLOADS_PER_ADDRESS) throw new PublicError('Too many files are being sent from your network address. Try again in a moment.', 429);
  if (uploads.size >= MAX_UPLOADS) throw new PublicError('The inspector is busy. Try again in a moment.', 503);

  const id = randomUUID();
  reserveUpload(id, { sid: req.sid, ip: who, bytes: size });
  const file = insideDir(config.dataDir, `upload-${id}`);
  const now = Date.now();
  const up = { id, sid: req.sid, ip: who, size, keep: !!keep && config.inspectEdit, received: 0, file, startedAt: now, touchedAt: now, busy: false, gone: false };
  uploads.set(id, up);
  try {
    await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
  } catch {
    await drop(up);
    throw new PublicError('Something went wrong on our side.', 500);
  }
  return { id, piece: config.uploadChunkBytes };
}

/**
 * Step two, once per piece: `at` is where the piece belongs. Pieces come in
 * order, one at a time. The answer to the last one is the file's description.
 * @returns {Promise<{received: number} | {done: true, report: object, job: object|null}>}
 */
export async function receivePiece(req, id, at) {
  ready();
  const up = uploads.get(id);
  // Somebody else's upload looks exactly like one that does not exist.
  if (!up || up.sid !== req.sid) throw new PublicError('That upload is gone. Choose the file again.', 404);
  if (up.busy) throw new PublicError('One piece at a time.', 409);
  if (at !== up.received) throw new PublicError('That piece arrived out of turn. Choose the file again.', 409);
  const bytes = Math.min(config.uploadChunkBytes, up.size - up.received);
  if (checkUpload(req, bytes) !== bytes) throw new PublicError('That piece is not the size it should be.', 400);

  up.busy = true;
  up.touchedAt = Date.now();
  let keepForRetry = true; // a piece that got lost on the way may be sent again
  try {
    await receive(req, up.file, up.received, bytes, config.timeouts.upload);
    if (up.gone) throw new PublicError('That upload is gone. Choose the file again.', 404);
    keepForRetry = false;

    // The first piece has to start like one of the kinds of file accepted here.
    if (up.received === 0) {
      const fh = await fs.open(up.file, 'r');
      let head;
      try {
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(64), 0, 64, 0);
        head = buffer.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      const kind = sniff(head);
      if (!kind) throw notAudio();
      if (!config.inspectTypes.includes(kind)) throw notAccepted();
    }
    up.received += bytes;
    up.touchedAt = Date.now();
    if (up.received < up.size) {
      keepForRetry = true;
      return { received: up.received };
    }
    return await finish(up);
  } catch (e) {
    if (!keepForRetry || e?.status === 413 || e?.status === 415) await drop(up);
    throw e;
  } finally {
    up.busy = false;
  }
}

/** The visitor changed their mind: stop and delete what has arrived. */
export async function cancelUpload(req, id) {
  const up = uploads.get(id);
  if (!up || up.sid !== req.sid) return;
  // A piece in flight notices that the upload is gone and stops by itself.
  await drop(up);
}

// ------------------------------------------------------------ the whole file is here

/** The description without its picture, to keep in memory with a job. */
const forMemory = (report) => ({ ...report, picture: report.picture ? { ...report.picture, dataUrl: null } : null });

/** What the job list shows of a file, from its description. */
function metaOf(report) {
  const f = report.format;
  const t = report.tags;
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  return {
    container: f.container,
    codec: f.codec,
    lossless: !!f.lossless,
    sampleRate: f.sampleRate,
    bitsPerSample: f.bitsPerSample,
    channels: f.numberOfChannels,
    bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : null,
    duration: f.duration,
    title: typeof t.title === 'string' ? t.title : undefined,
    artist: typeof t.artist === 'string' ? t.artist : undefined,
    album: typeof t.album === 'string' ? t.album : undefined,
    albumArtist: typeof t.albumartist === 'string' ? t.albumartist : undefined,
    year: typeof t.year === 'number' ? t.year : undefined,
    track: t.track?.no ?? null,
    trackTotal: t.track?.of ?? null,
    disc: t.disk?.no ?? null,
    genre: typeof first(t.genre) === 'string' ? first(t.genre) : undefined,
    cover: !!report.picture,
    lyrics: t.lyrics === 'embedded',
  };
}

const small = (v) => (Number.isInteger(v) && v > 0 && v < 1000 ? v : null);

/** The tags the editor starts from, in the shape the tag writers take. */
function tagsOf(report) {
  const t = report.tags;
  const m = metaOf(report);
  const date = typeof t.date === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(t.date) ? t.date : m.year ? String(m.year) : '';
  return {
    title: cleanText(m.title, 200) || 'Untitled',
    artist: cleanText(m.artist, 200),
    album: cleanText(m.album, 200),
    albumArtist: cleanText(m.albumArtist, 200),
    date,
    genre: cleanText(m.genre, 60),
    track: small(m.track),
    trackTotal: small(m.trackTotal),
    disc: small(m.disc),
    discTotal: small(t.disk?.of),
  };
}

async function finish(up) {
  const { size } = await fs.stat(up.file);
  if (size !== up.size) throw new PublicError('That upload did not arrive in one piece. Try again.');
  const answer = await describe(up.file, config.inspectTypes, up.keep);
  const spec = EDIT[answer.type];
  if (!up.keep || !answer.keep || !spec) {
    await drop(up);
    return { done: true, report: answer.report, job: null };
  }
  if (up.gone) throw new PublicError('That upload is gone. Choose the file again.', 404);
  // Still one file per browser, also when two were sent at the same moment.
  if (holdsUpload(up.sid)) throw new PublicError('You still have a file here. Download it or remove it, then inspect the next one.', 409);

  // Kept for editing: the file moves into a folder of its own and becomes a job.
  const dir = insideDir(config.dataDir, `job-${up.id}`);
  const diskName = `${randomUUID()}.${spec.ext}`;
  let job;
  try {
    await fs.mkdir(dir);
    await fs.rename(up.file, insideDir(dir, diskName));
    // Its own picture waits as it is, and is re-encoded when the file is first written again.
    let rawCover = null;
    if (answer.keep.picture) {
      rawCover = `${randomUUID()}.pic`;
      await fs.writeFile(insideDir(dir, rawCover), Buffer.from(answer.keep.picture, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    const tags = tagsOf(answer.report);
    const fmt = { ext: spec.ext, tags: spec.tags, numbering: spec.numbering, cover: spec.cover, special: spec.special };
    const track = {
      site: null,
      url: null,
      title: tags.title,
      status: 'done',
      progress: 100,
      seconds: answer.report.format.duration || null,
      file: diskName,
      size,
      fmt,
      tags,
      kept: answer.keep.kept,
      lyrics: answer.keep.lyrics ? { plain: cleanText(answer.keep.lyrics, 100_000, true), synced: null } : null,
      rawCover,
      coverLost: answer.keep.pictureLost,
      coverBig: null,
      coverFile: null,
      meta: metaOf(answer.report),
      match: { source: 'Your file', upload: true, matched: false },
      report: forMemory(answer.report),
    };
    track.name = downloadName({ tracks: [track] }, 0, tags, spec.ext);
    up.gone = true; // from here on the file belongs to the job
    uploads.delete(up.id);
    job = adoptUpload({ id: up.id, sid: up.sid, ip: up.ip, dir, format: INSPECT_TYPES[answer.type].label, track });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await drop(up);
    releaseUpload(up.id);
    if (e?.public) throw e;
    console.error(`[inspect] keeping a file failed: ${e?.code || e?.name || 'error'}`);
    throw new PublicError('Something went wrong on our side.', 500);
  }

  // How the file is opened when it is written again, and how the result is checked.
  job.inputArgs = inputArgs(spec);
  let next = null;
  job.readBack = async (file) => {
    const again = await withReader(() => ask(confinement, file, [answer.type], false));
    if (!again.ok) throw new Error('the rewritten file could not be read back');
    next = forMemory(again.report);
    return metaOf(again.report);
  };
  job.afterEdit = (track) => {
    if (next) track.report = next;
    next = null;
    job.rev++;
    job.finishedAt = Date.now(); // working on the file keeps it a while longer
  };
  console.log(`[job ${job.id}] a visitor's own file kept for editing (${spec.ext}, ${size} bytes)`);
  return { done: true, report: answer.report, job: publicJob(job) };
}
