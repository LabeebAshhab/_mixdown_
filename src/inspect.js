// The metadata inspector: a stranger's file comes in, a description of it
// goes out. The layers, in the order an upload meets them:
//   1. the request: the inspector must be switched on, the body must be raw
//      bytes with a declared length inside the limit, and it must arrive in
//      time (checkUpload and receive, used by src/routes.js)
//   2. the file is written under a random name; its own name never arrives
//   3. it is read by a separate, locked-down process (src/inspect-child.js),
//      which accepts only the kinds of file listed in INSPECT_TYPES, judged by
//      the file's bytes
//   4. every field of that process's answer is checked against a strict
//      schema before it is sent to the page, which shows it as text only
//   5. the file is deleted, whatever happened
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { INSPECT_TYPES } from './inspect-types.js';
import { run } from './proc.js';
import { insideDir, PublicError } from './security.js';

const CHILD = fileURLToPath(new URL('./inspect-child.js', import.meta.url));
const SRC_DIR = path.dirname(CHILD);
const READ_TIMEOUT = 30_000; // the reading process is killed after this
const MAX_ANSWER = 6 * 1024 * 1024; // its answer, artwork included

/** The kinds this server accepts, for the page: [{ label, ext }]. */
export const acceptedTypes = () => config.inspectTypes.map((id) => ({ label: INSPECT_TYPES[id].label, ext: INSPECT_TYPES[id].ext }));

const typeNames = () => {
  const names = config.inspectTypes.map((id) => INSPECT_TYPES[id].label);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};
const notAccepted = () => new PublicError(`That kind of file is not accepted here. The inspector reads ${typeNames()} files.`, 415);

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

function byteLimit(max) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      cb(seen > max ? tooLarge(max) : null, chunk);
    },
  });
}

/** Write the body to `file`, giving up when it passes `max` bytes or takes longer than `ms`. */
async function receive(req, file, max, ms) {
  try {
    await pipeline(req, byteLimit(max), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e?.public) throw e;
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ABORT_ERR') {
      throw new PublicError('That upload took too long, so it was stopped.', 408);
    }
    throw new PublicError('That upload did not arrive in one piece. Try again.');
  }
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
const answerSchema = z.union([
  z.object({ ok: z.literal(true), type: z.string().max(10), report: reportSchema }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['not-audio', 'type', 'unsupported', 'corrupt', 'limit', 'failed']) }).strict(),
]);

// ------------------------------------------------------------ the reading process

// How the reading process is confined. Decided once at start by trying it
// (see initInspector): Node's permission model under its current name, then
// under its older one, then without it on a runtime that has neither.
let confinement; // undefined = not tried yet, null = inspector unavailable, '' = this runtime has no permission model

function nodeArgs(flag, file) {
  const args = ['--max-old-space-size=256', '--disallow-code-generation-from-strings', '--no-warnings'];
  if (flag) {
    args.push(flag, `--allow-fs-read=${path.join(SRC_DIR, '*')}`, `--allow-fs-read=${path.join(config.root, 'package.json')}`, `--allow-fs-read=${file}`);
  }
  return args;
}

async function ask(flag, file, types) {
  const out = await run(process.execPath, [...nodeArgs(flag, file), CHILD, file, types.join(',')], { timeout: READ_TIMEOUT, maxOutput: MAX_ANSWER });
  return answerSchema.parse(JSON.parse(out));
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
          return `on (${config.inspectTypes.join(', ')}), read in a separate process${flag ? ' with file access limited to the upload' : ''}`;
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

// ------------------------------------------------------------ one upload

let busy = 0;
const busyFor = new Map(); // address -> uploads being handled

/**
 * Receive one upload and describe it. The file is deleted before this returns.
 * @returns {Promise<object>} the report for the page (see reportSchema)
 */
export async function inspectUpload(req) {
  if (!config.inspect || confinement === null) throw new PublicError('The inspector is switched off on this server.', 404);
  if (confinement === undefined) throw new PublicError('The inspector is not ready yet. Try again in a moment.', 503);
  const declared = checkUpload(req, config.maxUploadBytes);
  const who = req.ip || 'unknown';
  if (busy >= 2) throw new PublicError('The inspector is busy. Try again in a moment.', 503);
  if (busyFor.get(who)) throw new PublicError('One file at a time: wait for the last one to finish.', 429);

  busy++;
  busyFor.set(who, 1);
  const file = insideDir(config.dataDir, `upload-${randomUUID()}`);
  try {
    await receive(req, file, config.maxUploadBytes, config.timeouts.upload);
    const { size } = await fs.stat(file);
    if (size !== declared) throw new PublicError('That upload did not arrive in one piece. Try again.');
    if (size < 64) throw new PublicError('That does not look like an audio file.', 415);

    let answer;
    try {
      answer = await ask(confinement, file, config.inspectTypes);
    } catch (e) {
      if (e?.kind === 'timeout') throw new PublicError('That file took too long to read.');
      console.warn(`[inspect] reading failed: ${e?.kind || e?.name || 'error'}`);
      throw new PublicError('That file could not be read.');
    }
    if (answer.ok) return answer.report;
    if (answer.code === 'not-audio') throw new PublicError('That does not look like an audio file.', 415);
    if (answer.code === 'type' || answer.code === 'unsupported') throw notAccepted();
    if (answer.code === 'limit') throw new PublicError('That file took too long to read.');
    throw new PublicError('That file could not be read. It may be damaged.');
  } finally {
    busy--;
    busyFor.delete(who);
    await fs.rm(file, { force: true }).catch(() => {});
  }
}
