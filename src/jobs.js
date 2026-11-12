// Job store, worker queue, storage quota and cleanup.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { processTrack, resolveSource } from './pipeline.js';
import { insideDir, PublicError, publicMessage } from './security.js';

/** @type {Map<string, any>} */
export const jobs = new Map();
const pending = [];
let active = 0;

const gb = (bytes) => `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
const isOpen = (job) => job.status === 'queued' || job.status === 'running';

// ------------------------------------------------------------ storage accounting

/** Bytes waiting to be downloaded for one visitor (by IP address). */
export function usageFor(ip) {
  let sum = 0;
  for (const job of jobs.values()) if (job.ip === ip) for (const t of job.tracks) if (t.file) sum += t.size || 0;
  return sum;
}

/** Everything on disk, including the small previews the in-page player uses. */
function totalUsage() {
  let sum = 0;
  for (const job of jobs.values()) for (const t of job.tracks) sum += (t.file ? t.size || 0 : 0) + (t.previewFile ? t.previewSize || 0 : 0);
  return sum;
}

// ------------------------------------------------------------ queue

/**
 * @param {{sources: {site: string, kind: string, id: string, url: string}[]}} o
 *   one checked link (a song or a playlist), or several songs pasted together
 */
export function createJob({ sid, ip, sources, format, options, asAlbum, wantLyrics, syncedLyrics, normalize }) {
  if (usageFor(ip) >= config.quotaBytes) {
    throw new PublicError(`You have ${gb(config.quotaBytes)} waiting. Download your files to free up space, then carry on.`, 409);
  }
  let mine = 0;
  for (const job of jobs.values()) if (job.ip === ip && isOpen(job)) mine++;
  if (mine >= config.maxJobsPerClient) {
    throw new PublicError('You already have a few links in progress. Let one finish first.', 429);
  }
  if (pending.length >= config.maxQueued) throw new PublicError('The queue is full right now. Try again in a minute.', 503);

  const id = randomUUID();
  const kind = sources.length > 1 ? 'batch' : sources[0].kind;
  const job = {
    id,
    sid,
    ip,
    kind,
    site: sources[0].site,
    sources,
    format,
    options,
    asAlbum,
    wantLyrics,
    syncedLyrics: !!(wantLyrics && syncedLyrics),
    normalize: !!normalize,
    status: 'queued',
    title: kind === 'playlist' ? 'Playlist' : kind === 'batch' ? `${sources.length} songs` : 'Loading…',
    tracks: [],
    createdAt: Date.now(),
    finishedAt: null,
    dir: insideDir(config.dataDir, `job-${id}`),
    abort: new AbortController(),
    cancelled: false,
    room: () => config.quotaBytes - usageFor(ip), // bytes this visitor may still add
  };
  jobs.set(id, job);
  pending.push(job);
  pump();
  return job;
}

function pump() {
  while (active < config.maxConcurrent && pending.length) {
    const job = pending.shift();
    if (job.cancelled) continue;
    active++;
    runJob(job).finally(() => {
      active--;
      pump();
    });
  }
}

async function runJob(job) {
  const full = `Your ${gb(config.quotaBytes)} of space is full. Download what is ready, then add this one again.`;
  try {
    await fs.mkdir(job.dir, { recursive: true });
    job.status = 'running';
    await resolveSource(job);
    for (let i = 0; i < job.tracks.length; i++) {
      if (job.cancelled) return;
      const track = job.tracks[i];
      if (usageFor(job.ip) >= config.quotaBytes) {
        track.status = 'error';
        track.error = full;
        continue;
      }
      if (totalUsage() >= config.totalBytes) {
        track.status = 'error';
        track.error = 'The server is full right now. Try again in a few minutes.';
        continue;
      }
      await processTrack(job, track, i);
      if (track.file && usageFor(job.ip) > config.quotaBytes) {
        await fs.rm(insideDir(job.dir, track.file), { force: true }).catch(() => {});
        Object.assign(track, { file: null, size: 0, status: 'error', error: full });
      }
    }
    job.status = job.tracks.some((t) => t.status === 'done') ? 'done' : 'error';
    if (job.status === 'error') job.error = job.tracks[0]?.error || 'Nothing could be processed.';
  } catch (e) {
    job.status = 'error';
    job.error = publicMessage(e);
    if (e?.kind !== 'aborted') console.error(`[job ${job.id}] failed: ${e?.kind || ''} ${e?.detail || e?.message || e}`);
  } finally {
    job.finishedAt = Date.now();
  }
}

// ------------------------------------------------------------ removal

export async function removeJob(job) {
  job.cancelled = true;
  job.abort.abort();
  const i = pending.indexOf(job);
  if (i >= 0) pending.splice(i, 1);
  jobs.delete(job.id);
  await fs.rm(job.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

/** Called once a file has been fully sent: delete it from disk straight away. */
export async function collectTrack(job, track) {
  if (!track.file) return;
  const file = track.file;
  track.file = null;
  track.size = 0;
  track.status = 'collected';
  await fs.rm(insideDir(job.dir, file), { force: true }).catch(() => {});
  // When nothing is left to download, the whole job goes shortly after.
  if (job.finishedAt && !job.tracks.some((t) => t.file)) leaveSoon(job);
}

/**
 * Remove a fully downloaded job after a short pause. While the visitor is
 * listening to one of its previews it stays (until the usual expiry at most).
 */
function leaveSoon(job) {
  setTimeout(() => {
    if (!jobs.has(job.id) || job.tracks.some((t) => t.file)) return;
    if (Date.now() - (job.playedAt || 0) < 45_000) return leaveSoon(job);
    removeJob(job);
  }, 12_000).unref();
}

// ------------------------------------------------------------ public view

export function publicJob(job) {
  return {
    id: job.id,
    format: job.format,
    asAlbum: job.asAlbum,
    status: job.status,
    title: job.title,
    error: job.error,
    createdAt: job.createdAt,
    expiresAt: job.finishedAt ? job.finishedAt + config.fileTtlMs : null,
    tracks: job.tracks.map((t) => ({
      title: t.title,
      status: t.status,
      progress: t.progress,
      error: t.error,
      ready: !!t.file,
      size: t.size || 0,
      cover: t.coverFile ? t.coverFile.slice(0, 8) : null, // changes when the artwork does, so the page reloads it
      preview: !!t.previewFile,
      lrc: !!t.lrcFile,
      gain: t.gain ?? null,
      editable: !!(t.file && t.fmt),
      site: t.site,
      source: t.source,
      match: t.match,
      meta: t.meta,
    })),
  };
}

// ------------------------------------------------------------ cleanup

async function sweep() {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    const expired = job.finishedAt && now - job.finishedAt > config.fileTtlMs;
    const stuck = now - job.createdAt > 6 * 3600_000;
    if (expired || stuck) await removeJob(job);
  }
  // Anything in the data folder that no live job owns and that is older than
  // 15 minutes is residue (crash, failed upload): remove it.
  const entries = await fs.readdir(config.dataDir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const m = /^job-([0-9a-f-]{36})$/.exec(e.name);
    if (m ? jobs.has(m[1]) : !/^upload-[0-9a-f-]{36}$/.test(e.name)) continue;
    const full = insideDir(config.dataDir, e.name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat && now - stat.mtimeMs > 15 * 60_000) await fs.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

export async function initStorage() {
  await fs.mkdir(config.dataDir, { recursive: true });
  // Jobs live in memory, so anything left from a previous run is orphaned.
  const entries = await fs.readdir(config.dataDir).catch(() => []);
  for (const name of entries) {
    if (/^(job|upload)-[0-9a-f-]{36}$/.test(name)) {
      await fs.rm(insideDir(config.dataDir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
  setInterval(() => sweep().catch((e) => console.error('[sweep]', e.message)), 60_000).unref();
}

export async function shutdown() {
  for (const job of [...jobs.values()]) await removeJob(job);
}
