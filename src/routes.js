// HTTP API. Every input is validated against a strict schema before use.
import archiver from 'archiver';
import express from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { FORMAT_IDS, publicFormats, resolveOptions } from './formats.js';
import { acceptedTypes, checkUpload, inspectUpload, tooLarge } from './inspect.js';
import { collectTrack, createJob, jobs, publicJob, removeJob, usageFor } from './jobs.js';
import { imageDemuxer, lookupSong, retagTrack, searchSongs, uploadCover } from './pipeline.js';
import {
  cleanQuery,
  cleanText,
  contentDisposition,
  insideDir,
  isLocked,
  isUnlocked,
  PublicError,
  publicMessage,
  rateLimit,
  requireUnlocked,
  tryUnlock,
} from './security.js';
import { parseSource, SITES } from './sources.js';

// ------------------------------------------------------------ schemas

const link = z.string().min(10).max(300);
const jobBody = z
  .object({
    url: link.optional(),
    urls: z.array(link).min(1).max(config.maxLinks).optional(), // several songs pasted together
    format: z.enum(FORMAT_IDS),
    options: z.record(z.string().max(24), z.union([z.string().max(24), z.number()])).default({}),
    album: z.boolean().default(false),
    lyrics: z.boolean().default(true),
    synced: z.boolean().default(false),
    normalize: z.boolean().default(false),
  })
  .strict();
const loginBody = z.object({ password: z.string().min(1).max(200) }).strict();
const searchQuery = z.string().trim().min(2).max(100);
const tagText = z.string().max(200);
const tagNumber = z.number().int().min(1).max(999).nullable();
const tagBody = z
  .object({
    title: z.string().min(1).max(200),
    artist: tagText,
    album: tagText,
    albumArtist: tagText,
    year: z.string().regex(/^(\d{4})?$/),
    track: tagNumber,
    trackTotal: tagNumber,
    genre: z.string().max(60),
    suggestedCover: z.boolean().default(false), // use the artwork the last catalogue lookup found
  })
  .strict();
const lookupBody = z.object({ title: z.string().min(1).max(200), artist: z.string().min(1).max(200) }).strict();
const idParam = z.string().uuid();
const indexParam = z.coerce.number().int().min(0).max(5000);

const SITE_NAMES = Object.values(SITES)
  .map((s) => s.label)
  .join(', ')
  .replace(/, ([^,]+)$/, ' or $1');

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

function ownedTrack(req) {
  const job = ownedJob(req);
  const index = parse(indexParam, req.params.index);
  return { job, index, track: job.tracks[index] };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** A name safe to use inside a zip. */
const zipName = (s, fallback) => String(s).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\.{2,}/g, '.').trim() || fallback;

// ------------------------------------------------------------ uploads (artwork)

/** A small upload held in memory, refused as soon as it passes `max` bytes. */
async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw tooLarge(max);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------ editing a finished track

let editing = 0;

/**
 * Run one change to a finished file. Only one thing may touch a file at a
 * time: it cannot be edited while it is downloading, or downloaded while it
 * is being edited.
 */
async function withTrack(req, work) {
  const { job, index, track } = ownedTrack(req);
  if (!track?.file || !track.fmt) throw new PublicError('That file is gone. It may already have been downloaded.', 404);
  if (track.sending) throw new PublicError('That file is downloading. Try again when it has finished.', 409);
  if (track.editing) throw new PublicError('That file is already being updated.', 409);
  if (editing >= 2) throw new PublicError('The server is busy. Try again in a moment.', 503);
  editing++;
  track.editing = true;
  try {
    await work(job, track, index);
  } catch (e) {
    if (e?.public) throw e;
    console.error(`[job ${job.id}] edit failed: ${e?.kind || ''} ${e?.detail || e?.message || e}`);
    throw new PublicError('That change could not be saved. The file is as it was.', 500);
  } finally {
    editing--;
    track.editing = false;
  }
  return job;
}

// ------------------------------------------------------------ router

export function apiRouter({ ready }) {
  const r = express.Router();
  const json = express.json({ limit: '16kb', strict: true });

  r.get('/bootstrap', (req, res) => {
    res.json({
      ready: ready(),
      locked: isLocked(),
      unlocked: isUnlocked(req),
      credits: config.credits,
      formats: publicFormats(),
      sites: Object.values(SITES).map((s) => s.label),
      features: { search: config.search, preview: config.preview, inspect: config.inspect },
      inspectTypes: config.inspect ? acceptedTypes() : [],
      limits: {
        quotaBytes: config.quotaBytes,
        ttlMinutes: Math.round(config.fileTtlMs / 60_000),
        maxTracks: config.maxTracks,
        maxLinks: config.maxLinks,
        maxUploadBytes: config.maxUploadBytes,
        maxCoverBytes: config.maxCoverBytes,
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
    // The page names the job it is playing a preview of, which keeps that job
    // around after its files have been downloaded (see leaveSoon in jobs.js).
    const playing = idParam.safeParse(req.query.playing);
    const heard = playing.success ? jobs.get(playing.data) : null;
    if (heard && heard.sid === req.sid) heard.playedAt = Date.now();
    const mine = [...jobs.values()].filter((j) => j.sid === req.sid).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ jobs: mine.map(publicJob), usage: { used: usageFor(req.ip), quota: config.quotaBytes } });
  });

  r.post('/jobs', rateLimit(config.rate.convert), json, (req, res) => {
    const body = parse(jobBody, req.body);
    const typed = body.urls || (body.url ? [body.url] : []);
    if (!typed.length) throw new PublicError('Paste a link first.');
    // Each link is reduced to its checked parts; duplicates are dropped.
    const sources = new Map();
    for (const text of typed) {
      const source = parseSource(text);
      if (!source) {
        throw new PublicError(
          typed.length > 1
            ? `One of those is not a link I can use. Paste ${SITE_NAMES} links.`
            : `That does not look like a link I can use. Paste a ${SITE_NAMES} link.`,
        );
      }
      sources.set(source.url, source);
    }
    const list = [...sources.values()];
    if (list.length > 1 && list.some((s) => s.kind !== 'video')) {
      throw new PublicError('When you paste several links, each one has to be a single song, not a playlist.');
    }
    const options = resolveOptions(body.format, body.options);
    const job = createJob({
      sid: req.sid,
      ip: req.ip,
      sources: list,
      format: body.format,
      options,
      asAlbum: body.album,
      wantLyrics: body.lyrics,
      syncedLyrics: body.synced,
      normalize: body.normalize,
    });
    res.status(201).json(publicJob(job));
  });

  // Search by song name. The words are only ever used as search text.
  r.get('/search', rateLimit(config.rate.search), wrap(async (req, res) => {
    if (!config.search) throw new PublicError('Search is switched off on this server.', 404);
    const q = cleanQuery(parse(searchQuery, req.query.q));
    try {
      res.json({ results: await searchSongs(q) });
    } catch (e) {
      if (e?.public) throw e;
      console.warn(`[search] failed: ${e?.kind || e?.message}`);
      throw new PublicError(e?.kind === 'not-installed' ? publicMessage(e) : 'The search did not work. Try again in a moment.', 502);
    }
  }));

  // One file. It is deleted from the server as soon as it has been sent in full.
  r.get('/jobs/:id/files/:index', (req, res, next) => {
    if (req.method !== 'GET') return res.status(405).end();
    const { job, track } = ownedTrack(req);
    if (!track?.file) throw new PublicError('That file is gone. It may already have been downloaded.', 404);
    if (track.sending) throw new PublicError('That file is already downloading.', 409);
    if (track.editing) throw new PublicError('That file is being updated. Try again in a moment.', 409);
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
    const { job, track } = ownedTrack(req);
    if (!track?.coverFile) throw new PublicError('No artwork.', 404);
    res.sendFile(
      insideDir(job.dir, track.coverFile),
      { dotfiles: 'deny', cacheControl: false, headers: { 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'image/jpeg' } },
      (err) => err && !res.headersSent && next(new PublicError('No artwork.', 404)),
    );
  });

  // The in-page player: a small MP3 made next to the real file. Ranges are
  // allowed so the browser can seek. Listening keeps a downloaded job around.
  r.get('/jobs/:id/preview/:index', (req, res, next) => {
    const { job, track } = ownedTrack(req);
    if (!track?.previewFile) throw new PublicError('Nothing to play.', 404);
    job.playedAt = Date.now();
    res.sendFile(
      insideDir(job.dir, track.previewFile),
      { dotfiles: 'deny', cacheControl: false, etag: false, headers: { 'Cache-Control': 'private, max-age=600', 'Content-Type': 'audio/mpeg' } },
      (err) => err && !res.headersSent && next(new PublicError('Nothing to play.', 404)),
    );
  });

  // Time-synced lyrics as a .lrc file with the same name as the song.
  r.get('/jobs/:id/lrc/:index', (req, res, next) => {
    const { job, track } = ownedTrack(req);
    if (!track?.lrcFile) throw new PublicError('No synced lyrics for this one.', 404);
    res.sendFile(
      insideDir(job.dir, track.lrcFile),
      {
        dotfiles: 'deny',
        cacheControl: false,
        etag: false,
        headers: {
          'Content-Disposition': contentDisposition(String(track.name).replace(/\.[A-Za-z0-9]{1,5}$/, '.lrc')),
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
      (err) => err && !res.headersSent && next(new PublicError('No synced lyrics for this one.', 404)),
    );
  });

  // Whole playlist as one zip with an album folder. Files are deleted once sent.
  r.get('/jobs/:id/zip', (req, res) => {
    if (req.method !== 'GET') return res.status(405).end();
    const job = ownedJob(req);
    const ready = job.tracks.filter((t) => t.file && !t.sending && !t.editing);
    if (!ready.length) throw new PublicError('Nothing is ready to download yet.', 404);
    const folder = zipName(job.title.replace(/^Album\s+-\s+/, ''), 'Playlist').slice(0, 120);
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
      const name = zipName(t.name, 'track');
      zip.file(insideDir(job.dir, t.file), { name: `${folder}/${name}` });
      if (t.lrcFile) zip.file(insideDir(job.dir, t.lrcFile), { name: `${folder}/${name.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.lrc` });
    }
    zip.finalize();
  });

  r.delete('/jobs/:id', wrap(async (req, res) => {
    await removeJob(ownedJob(req));
    res.status(204).end();
  }));

  // ---- fixing a match: look the song up again, change its tags, replace its artwork

  // Search the catalogues with a title and artist the visitor typed. The
  // artwork address it finds stays on the server; the page only learns that
  // there is one.
  r.post('/jobs/:id/tracks/:index/lookup', rateLimit(config.rate.edit), json, wrap(async (req, res) => {
    const { track } = ownedTrack(req);
    if (!track?.file || !track.fmt) throw new PublicError('That file is gone. It may already have been downloaded.', 404);
    const body = parse(lookupBody, req.body);
    const title = cleanText(body.title, 200);
    const artist = cleanText(body.artist, 200);
    if (!title || !artist) throw new PublicError('Type a title and an artist first.');
    const found = await lookupSong({ title, artist, duration: track.meta?.duration });
    if (found?.failed) throw new PublicError('The catalogues could not be reached. Try again in a moment.', 502);
    if (!found) throw new PublicError('No catalogue has a good match for that title and artist.', 404);
    track.suggest = found.coverUrl ? { url: found.coverUrl, label: `${found.source} album art` } : null;
    const t = found.tags;
    res.json({
      source: found.source,
      cover: !!found.coverUrl,
      tags: {
        title: t.title,
        artist: t.artist,
        album: t.album,
        albumArtist: t.albumArtist,
        year: String(t.date || '').slice(0, 4),
        track: t.track,
        trackTotal: t.trackTotal,
        genre: t.genre,
      },
    });
  }));

  // New tags for a finished file. The audio is copied, never converted again.
  r.patch('/jobs/:id/tracks/:index', rateLimit(config.rate.edit), json, wrap(async (req, res) => {
    const body = parse(tagBody, req.body);
    const title = cleanText(body.title, 200);
    if (!title) throw new PublicError('A song needs a title.');
    const job = await withTrack(req, async (j, track, index) => {
      const tags = {
        title,
        artist: cleanText(body.artist, 200),
        album: cleanText(body.album, 200),
        albumArtist: cleanText(body.albumArtist, 200),
        // Keep the full release date when the year was left alone.
        date: body.year && String(track.tags.date || '').startsWith(body.year) ? track.tags.date : body.year,
        track: body.track,
        trackTotal: body.track ? body.trackTotal : null,
        genre: cleanText(body.genre, 60),
      };
      const cover = body.suggestedCover && track.suggest ? track.suggest : undefined;
      await retagTrack(j, track, index, { tags, cover });
      track.suggest = null;
    });
    res.json(publicJob(job));
  }));

  // New artwork from an image the visitor uploads. It is identified by its
  // first bytes, re-encoded by ffmpeg, and only the re-encoded copy is kept.
  r.put('/jobs/:id/tracks/:index/cover', rateLimit(config.rate.edit), wrap(async (req, res) => {
    // Refuse before reading the upload if the track is not the caller's, has
    // nothing to edit, or the server is already busy with other edits.
    const { track } = ownedTrack(req);
    if (!track?.file || !track.fmt) throw new PublicError('That file is gone. It may already have been downloaded.', 404);
    if (editing >= 2) throw new PublicError('The server is busy. Try again in a moment.', 503);
    checkUpload(req, config.maxCoverBytes);
    const data = await readBody(req, config.maxCoverBytes);
    if (!imageDemuxer(data)) throw new PublicError('That does not look like a picture. Use a JPEG, PNG or WebP image.', 415);
    const job = await withTrack(req, async (j, track, index) => {
      await uploadCover(j, track, data);
      await retagTrack(j, track, index, { tags: {} });
    });
    res.json(publicJob(job));
  }));

  // Metadata inspector. Everything that protects the server from a hostile
  // upload is in src/inspect.js.
  r.post('/inspect', rateLimit(config.rate.inspect), wrap(async (req, res) => {
    res.json(await inspectUpload(req));
  }));

  r.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  return r;
}
