// HTTP API. Every input is validated against a strict schema before use.
import archiver from 'archiver';
import express from 'express';
import { fileTypeFromFile } from 'file-type';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { config } from './config.js';
import { FORMAT_IDS, publicFormats, resolveOptions } from './formats.js';
import { collectTrack, createJob, jobs, publicJob, removeJob, usageFor } from './jobs.js';
import { readAudio } from './reader/index.js';
import {
  contentDisposition,
  insideDir,
  isLocked,
  isUnlocked,
  PublicError,
  rateLimit,
  requireUnlocked,
  tryUnlock,
} from './security.js';

// ------------------------------------------------------------ schemas

const jobBody = z
  .object({
    url: z.string().min(10).max(300),
    format: z.enum(FORMAT_IDS),
    options: z.record(z.string().max(24), z.union([z.string().max(24), z.number()])).default({}),
    album: z.boolean().default(false),
    lyrics: z.boolean().default(true),
  })
  .strict();
const loginBody = z.object({ password: z.string().min(1).max(200) }).strict();
const idParam = z.string().uuid();
const indexParam = z.coerce.number().int().min(0).max(5000);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{12,80}$/;

/**
 * Accept only YouTube links, and keep nothing of what was typed except the
 * video or playlist id. The URL passed on is rebuilt from that id.
 */
export function parseYouTubeUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const video = (id) => (VIDEO_ID.test(id || '') ? { kind: 'video', id, url: `https://www.youtube.com/watch?v=${id}` } : null);
  const list = (id) => (LIST_ID.test(id || '') ? { kind: 'playlist', id, url: `https://www.youtube.com/playlist?list=${id}` } : null);

  if (host === 'youtu.be') return video(u.pathname.split('/')[1]);
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
  if (u.pathname === '/watch') return video(u.searchParams.get('v'));
  if (u.pathname === '/playlist') return list(u.searchParams.get('list'));
  const m = /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/.exec(u.pathname);
  return m ? video(m[1]) : null;
}

function parse(schema, value) {
  const r = schema.safeParse(value);
  if (!r.success) throw new PublicError('That request was not valid.');
  return r.data;
}

/** Find a job by id, but only if it belongs to the caller's session. */
function ownedJob(req) {
  const job = jobs.get(parse(idParam, req.params.id));
  if (!job || job.sid !== req.sid) throw new PublicError('That item is gone.', 404);
  return job;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------ uploads (inspector)

// The formats src/reader understands, as file-type names them (Matroska audio is reported as "mkv").
const AUDIO_TYPES = new Set(['mp3', 'flac', 'wav', 'aif', 'm4a', 'mp4', 'm4b', 'ogg', 'oga', 'opus', 'dsf', 'mka', 'mkv', 'webm']);
const UNSUPPORTED = 'That format is not supported. The inspector reads MP3, FLAC, WAV, AIFF, M4A, Ogg, Opus, DSF and Matroska files.';
let inspecting = 0;

function byteLimit(max) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      cb(seen > max ? new PublicError(`That file is larger than ${Math.round(max / 1048576)} MB.`, 413) : null, chunk);
    },
  });
}

function describe({ format, common, native }) {
  const short = (v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v);
  const pic = common.picture?.[0];
  const tags = {};
  for (const [k, v] of Object.entries(common)) {
    if (k === 'picture' || v === null || v === undefined) continue;
    if (k === 'lyrics') tags.lyrics = Array.isArray(v) && v.length ? 'embedded' : undefined;
    else if (typeof v !== 'object') tags[k] = short(v);
    else if (Array.isArray(v)) tags[k] = v.filter((x) => typeof x !== 'object').map(short).slice(0, 20);
    else if (k === 'track' || k === 'disk') tags[k] = { no: v.no, of: v.of };
  }
  const raw = {};
  for (const [type, list] of Object.entries(native || {})) {
    raw[type] = list
      .filter((t) => typeof t.value === 'string' || typeof t.value === 'number')
      .slice(0, 80)
      .map((t) => ({ id: String(t.id).slice(0, 60), value: short(String(t.value)) }));
  }
  return {
    format: {
      container: format.container,
      codec: format.codec,
      lossless: format.lossless,
      sampleRate: format.sampleRate,
      bitsPerSample: format.bitsPerSample,
      numberOfChannels: format.numberOfChannels,
      bitrate: format.bitrate,
      duration: format.duration,
      tagTypes: format.tagTypes,
    },
    tags,
    raw,
    picture: pic
      ? {
          format: /^image\/(jpeg|png|webp|gif)$/.test(pic.format) ? pic.format : 'image/jpeg',
          bytes: pic.data.length,
          dataUrl:
            pic.data.length < 3_000_000 && /^image\/(jpeg|png|webp|gif)$/.test(pic.format)
              ? `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}`
              : null,
        }
      : null,
  };
}

// ------------------------------------------------------------ router

export function apiRouter({ ready }) {
  const r = express.Router();
  const json = express.json({ limit: '4kb', strict: true });

  r.get('/bootstrap', (req, res) => {
    res.json({
      ready: ready(),
      locked: isLocked(),
      unlocked: isUnlocked(req),
      credits: config.credits,
      formats: publicFormats(),
      limits: {
        quotaBytes: config.quotaBytes,
        ttlMinutes: Math.round(config.fileTtlMs / 60_000),
        maxTracks: config.maxTracks,
        maxUploadBytes: config.maxUploadBytes,
      },
    });
  });

  r.post('/login', rateLimit(config.rate.login), json, (req, res) => {
    const { password } = parse(loginBody, req.body);
    if (!tryUnlock(req, password)) throw new PublicError('That password is not right.', 401);
    res.json({ ok: true });
  });

  r.use(requireUnlocked);

  r.get('/jobs', (req, res) => {
    const mine = [...jobs.values()].filter((j) => j.sid === req.sid).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ jobs: mine.map(publicJob), usage: { used: usageFor(req.ip), quota: config.quotaBytes } });
  });

  r.post('/jobs', rateLimit(config.rate.convert), json, (req, res) => {
    const body = parse(jobBody, req.body);
    const source = parseYouTubeUrl(body.url);
    if (!source) throw new PublicError('That does not look like a YouTube link. Paste a video or playlist link.');
    const options = resolveOptions(body.format, body.options);
    const job = createJob({
      sid: req.sid,
      ip: req.ip,
      source,
      format: body.format,
      options,
      asAlbum: body.album,
      wantLyrics: body.lyrics,
    });
    res.status(201).json(publicJob(job));
  });

  // One file. It is deleted from the server as soon as it has been sent in full.
  r.get('/jobs/:id/files/:index', (req, res, next) => {
    if (req.method !== 'GET') return res.status(405).end();
    const job = ownedJob(req);
    const track = job.tracks[parse(indexParam, req.params.index)];
    if (!track?.file) throw new PublicError('That file is gone. It may already have been downloaded.', 404);
    if (track.sending) throw new PublicError('That file is already downloading.', 409);
    track.sending = true;
    res.sendFile(
      insideDir(job.dir, track.file),
      {
        acceptRanges: false,
        etag: false,
        lastModified: false,
        cacheControl: false,
        dotfiles: 'deny',
        headers: { 'Content-Disposition': contentDisposition(track.name), 'Cache-Control': 'no-store' },
      },
      (err) => {
        track.sending = false;
        if (!err && res.writableFinished) collectTrack(job, track).catch(() => {});
        else if (err && !res.headersSent) next(new PublicError('That file could not be sent.', 500));
      },
    );
  });

  // Small artwork preview for the interface.
  r.get('/jobs/:id/cover/:index', (req, res, next) => {
    const job = ownedJob(req);
    const track = job.tracks[parse(indexParam, req.params.index)];
    if (!track?.coverFile) throw new PublicError('No artwork.', 404);
    res.sendFile(
      insideDir(job.dir, track.coverFile),
      { dotfiles: 'deny', cacheControl: false, headers: { 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'image/jpeg' } },
      (err) => err && !res.headersSent && next(new PublicError('No artwork.', 404)),
    );
  });

  // Whole playlist as one zip with an album folder. Files are deleted once sent.
  r.get('/jobs/:id/zip', (req, res) => {
    if (req.method !== 'GET') return res.status(405).end();
    const job = ownedJob(req);
    const ready = job.tracks.filter((t) => t.file && !t.sending);
    if (!ready.length) throw new PublicError('Nothing is ready to download yet.', 404);
    const folder = job.title.replace(/^Album\s+-\s+/, '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\.{2,}/g, '.').trim().slice(0, 120) || 'Playlist';
    for (const t of ready) t.sending = true;
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': contentDisposition(`${folder}.zip`), 'Cache-Control': 'no-store' });

    const zip = archiver('zip', { store: true });
    let failed = false;
    zip.on('error', () => {
      failed = true;
      res.destroy();
    });
    res.on('close', () => {
      for (const t of ready) t.sending = false;
      if (!failed && res.writableFinished) for (const t of ready) collectTrack(job, t).catch(() => {});
      else zip.abort();
    });
    zip.pipe(res);
    for (const t of ready) {
      const name = String(t.name).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\.{2,}/g, '.').trim() || 'track';
      zip.file(insideDir(job.dir, t.file), { name: `${folder}/${name}` });
    }
    zip.finalize();
  });

  r.delete('/jobs/:id', wrap(async (req, res) => {
    await removeJob(ownedJob(req));
    res.status(204).end();
  }));

  // Metadata inspector: the upload is saved under a random name, checked by
  // its first bytes (not its name or declared type), read, and deleted.
  r.post('/inspect', rateLimit(config.rate.inspect), wrap(async (req, res) => {
    if (Number(req.headers['content-length']) > config.maxUploadBytes) {
      throw new PublicError(`That file is larger than ${Math.round(config.maxUploadBytes / 1048576)} MB.`, 413);
    }
    if (inspecting >= 2) throw new PublicError('The inspector is busy. Try again in a moment.', 503);
    inspecting++;
    const tmp = insideDir(config.dataDir, `upload-${randomUUID()}`);
    try {
      await pipeline(req, byteLimit(config.maxUploadBytes), createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      const type = await fileTypeFromFile(tmp);
      if (!type || (!type.mime.startsWith('audio/') && !AUDIO_TYPES.has(type.ext))) throw new PublicError('That does not look like an audio file.', 415);
      if (!AUDIO_TYPES.has(type.ext)) throw new PublicError(UNSUPPORTED, 415);
      res.json(describe(await readAudio(tmp, { timeoutMs: 30_000 })));
    } catch (e) {
      if (e?.public) throw e;
      if (e?.code === 'unsupported') throw new PublicError(UNSUPPORTED, 415);
      if (e?.code === 'limit') throw new PublicError('That file took too long to read.');
      console.warn(`[inspect] failed: ${e?.code || e?.message}`);
      throw new PublicError('That file could not be read.');
    } finally {
      inspecting--;
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }));

  r.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  return r;
}
