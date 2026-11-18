// Job store, worker queue, storage quota and cleanup.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { estimateBytes } from './formats.js';
import { processTrack, resolveSource } from './pipeline.js';
import { insideDir, PublicError, publicMessage } from './security.js';

/** @type {Map<string, any>} */
export const jobs = new Map();
const pending = [];
let active = 0;
let closing = false; // the server is shutting down: nothing new is started

const gb = (bytes) => `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
// "waiting" is a job paused until its visitor downloads what is ready.
const isWorking = (job) => job.status === 'queued' || job.status === 'running';
const isOpen = (job) => isWorking(job) || job.status === 'waiting';

// ------------------------------------------------------------ storage accounting
//
// Space is counted twice. Each browser (its session id) has its own allowance,
// so people behind one address do not use up each other's space. A browser can
// throw its cookie away and come back as a new one, so everything held from
// one IP address is capped as well.

// A file on its way in to the inspector (src/inspect.js) has its whole size set
// aside from its first byte, under the same two limits, so that uploads
// cannot be used to fill the disk past them.
/** @type {Map<string, {sid: string, ip: string, bytes: number}>} */
const reserved = new Map();

function held(match) {
  let sum = 0;
  for (const job of jobs.values()) if (match(job)) for (const t of job.tracks) if (t.file) sum += t.size || 0;
  for (const r of reserved.values()) if (match(r)) sum += r.bytes;
  return sum;
}

/** Bytes waiting to be downloaded by one browser. */
export const usageFor = (sid) => held((job) => job.sid === sid);
/** Bytes waiting to be downloaded by every browser at one address. */
const usageAt = (ip) => held((job) => job.ip === ip);
/** Bytes this browser may still add: the smaller of what is left for it and for its address. */
const roomFor = (sid, ip) => Math.min(config.quotaBytes - usageFor(sid), config.ipQuotaBytes - usageAt(ip));

// The other browsers at this address hold all of the address's space. The
// page links this message to its explanation on the Privacy & Policy page.
const addressFull = (status) =>
  new PublicError('The space shared by everyone at your network address is full right now. Try again in a few minutes.', status, 'shared-space');

/**
 * Can a file of this size be added for this job's visitor?
 * true: yes. false: not now, but it will once they download what is ready.
 * Throws when waiting would never help.
 */
function fits(job, bytes) {
  if (bytes > Math.min(config.quotaBytes, config.ipQuotaBytes)) {
    throw new PublicError(`This one is larger than your ${gb(config.quotaBytes)} of space, so it cannot be made here.`);
  }
  if (bytes <= roomFor(job.sid, job.ip)) return true;
  // Nothing of their own to download means the space is held by other
  // browsers at the same address: this visitor cannot free it.
  if (usageFor(job.sid) <= 0) throw addressFull();
  return false;
}

/** Sessions with a link queued or in progress, for the count of people online (src/presence.js). */
export function workingSessions() {
  const out = [];
  for (const job of jobs.values()) if (isWorking(job)) out.push({ sid: job.sid, ip: job.ip });
  return out;
}

/** Everything on disk, including the small previews the in-page player uses. */
function totalUsage() {
  let sum = 0;
  for (const job of jobs.values()) for (const t of job.tracks) sum += (t.file ? t.size || 0 : 0) + (t.previewFile ? t.previewSize || 0 : 0);
  for (const r of reserved.values()) sum += r.bytes;
  return sum;
}

// ------------------------------------------------------------ a visitor's own file (the inspector)

/**
 * Set aside room for a file that is about to be uploaded. Throws, with a
 * sentence for the visitor, when it does not fit.
 * @param {string} id the upload's id
 */
export function reserveUpload(id, { sid, ip, bytes }) {
  if (closing) throw new PublicError('The server is restarting. Try again in a moment.', 503);
  if (bytes > Math.min(config.quotaBytes, config.ipQuotaBytes)) {
    throw new PublicError(`That file is larger than your ${gb(config.quotaBytes)} of space.`, 413);
  }
  if (bytes > config.quotaBytes - usageFor(sid)) {
    throw new PublicError('There is not enough of your space left for that file. Download or remove what is waiting, then try again.', 409);
  }
  if (bytes > config.ipQuotaBytes - usageAt(ip)) throw addressFull(409);
  if (totalUsage() + bytes > config.totalBytes) throw new PublicError('The server is full right now. Try again in a few minutes.', 503);
  reserved.set(id, { sid, ip, bytes });
}

/** Give the room back: the upload was dropped, or its file was read and deleted. */
export function releaseUpload(id) {
  if (reserved.delete(id)) wake();
}

/** Does this browser already hold a file of its own that it has not downloaded or removed? */
export const holdsUpload = (sid) => [...jobs.values()].some((job) => job.kind === 'upload' && job.sid === sid && job.tracks.some((t) => t.file));

/**
 * An uploaded file that is kept for editing becomes a finished job of one
 * track, so that everything a download has applies to it too: only its own
 * browser can reach it, it counts against that browser's and that address's
 * space, it is deleted when downloaded, removed or left for too long.
 * The room set aside for the upload passes to the job in the same step.
 * @param {{id: string, sid: string, ip: string, dir: string, format: string, track: object}} o
 */
export function adoptUpload({ id, sid, ip, dir, format, track }) {
  const now = Date.now();
  const job = {
    id,
    sid,
    ip,
    kind: 'upload',
    site: null,
    sources: [],
    format,
    options: {},
    asAlbum: false,
    wantLyrics: false,
    syncedLyrics: false,
    normalize: false,
    status: 'done',
    title: track.title,
    tracks: [track],
    createdAt: now,
    finishedAt: now,
    dir,
    abort: new AbortController(),
    cancelled: false,
    listed: true,
    next: 1,
    made: track.size,
    part: 0,
    zips: 0,
    waitFrom: null,
    fresh: true,
    rev: 1, // goes up each time the file is written again, so the page knows to read its details again
    fits: () => true,
  };
  reserved.delete(id);
  jobs.set(id, job);
  return job;
}

// ------------------------------------------------------------ queue

/**
 * @param {{sources: {site: string, kind: string, id: string, url: string}[]}} o
 *   one checked link (a song or a playlist), or several songs pasted together
 */
export function createJob({ sid, ip, sources, format, options, asAlbum, wantLyrics, syncedLyrics, normalize }) {
  if (usageFor(sid) >= config.quotaBytes) {
    throw new PublicError(`You have ${gb(config.quotaBytes)} waiting. Download your files to free up space, then carry on.`, 409);
  }
  if (usageAt(ip) >= config.ipQuotaBytes) throw addressFull(409);
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
    listed: false, // the songs it covers have been worked out
    next: 0, // index of the track to do next
    made: 0, // bytes of finished files so far
    part: 0, // times it has stopped to wait for space
    zips: 0, // zips of it sent in full
    waitFrom: null, // when the current wait started counting
    fresh: true, // the visitor has downloaded something since the last wait
    fits: (bytes) => fits(job, bytes),
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

/**
 * A guess at a finished file's size before anything is fetched: what the last
 * try measured, or the length the playlist itself gives for the song.
 */
function expected(job, track) {
  if (track.need) return track.need;
  if (!(track.seconds > 0)) return 1;
  const guess = estimateBytes(job.format, job.options, { duration: track.seconds, sourceRate: 48000, sourceBytes: track.seconds * 20_000 });
  return Math.max(1, Math.round(guess) || 1);
}

/** Delete everything a finished track left on disk and forget what was learned about it. */
async function discard(job, track) {
  for (const key of ['file', 'coverBig', 'coverFile', 'previewFile', 'lrcFile']) {
    if (track[key]) await fs.rm(insideDir(job.dir, track[key]), { force: true }).catch(() => {});
    track[key] = null;
  }
  Object.assign(track, { status: 'queued', size: 0, previewSize: 0, meta: null, match: null, fmt: null, tags: null, lyrics: null, gain: null, progress: 0 });
}

/**
 * Stop a job until its visitor has made room. It gives its place among the
 * workers back, so a paused playlist never holds up anyone else, and nothing
 * more is fetched for it in the meantime.
 */
function pause(job) {
  job.status = 'waiting';
  job.part++;
  // The wait is timed from the visitor's last download. A job that was only
  // woken by other files expiring does not get its time back.
  if (job.fresh || !job.waitFrom) job.waitFrom = Date.now();
  job.fresh = false;
  for (let i = job.next; i < job.tracks.length; i++) {
    const t = job.tracks[i];
    if (t.status === 'queued' || t.status === 'waiting') Object.assign(t, { status: 'waiting', progress: 0 });
  }
}

/** Space was freed: every waiting job whose next song now fits goes to the back of the queue. */
function wake() {
  if (closing) return;
  for (const job of jobs.values()) {
    if (job.status !== 'waiting' || job.cancelled) continue;
    const track = job.tracks[job.next];
    if (track && roomFor(job.sid, job.ip) < expected(job, track)) continue;
    job.status = 'queued';
    for (let i = job.next; i < job.tracks.length; i++) if (job.tracks[i].status === 'waiting') job.tracks[i].status = 'queued';
    pending.push(job);
  }
  pump();
}

async function runJob(job) {
  const fail = (track, e) => Object.assign(track, { status: 'error', error: publicMessage(e), why: e?.why || null, progress: 0 });
  try {
    job.status = 'running';
    if (!job.listed) {
      await fs.mkdir(job.dir, { recursive: true });
      await resolveSource(job);
      job.listed = true;
    }
    for (; job.next < job.tracks.length; job.next++) {
      if (job.cancelled) return;
      const i = job.next;
      const track = job.tracks[i];
      if (totalUsage() >= config.totalBytes) {
        fail(track, new PublicError('The server is full right now. Try again in a few minutes.'));
        continue;
      }
      if (job.made >= config.maxJobBytes) {
        fail(track, new PublicError(`This link reached the server's limit of ${gb(config.maxJobBytes)} for one playlist.`));
        continue;
      }
      // No room for the next song: wait for the visitor instead of failing.
      try {
        if (!fits(job, expected(job, track))) return pause(job);
      } catch (e) {
        fail(track, e);
        continue;
      }
      track.status = 'queued';
      await processTrack(job, track, i);
      if (job.cancelled) return;
      // It turned out not to fit once its real length was known.
      if (track.status === 'waiting') return pause(job);
      if (!track.file) continue;
      if (roomFor(job.sid, job.ip) < 0) {
        // The finished file came out larger than expected and went over the limit.
        const size = track.size;
        await discard(job, track);
        try {
          if (track.overshot) throw new PublicError(`Your ${gb(config.quotaBytes)} of space is full. Download what is ready, then add this one again.`);
          track.overshot = true;
          track.need = size;
          if (!fits(job, size)) return pause(job);
          job.next--; // room appeared in the meantime: make it again
        } catch (e) {
          fail(track, e);
        }
        continue;
      }
      job.made += track.size;
    }
    job.status = job.tracks.some((t) => t.status === 'done' || t.status === 'collected') ? 'done' : 'error';
    if (job.status === 'error') job.error = job.tracks[0]?.error || 'Nothing could be processed.';
    job.finishedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.error = publicMessage(e);
    job.finishedAt = Date.now();
    if (e?.kind !== 'aborted') console.error(`[job ${job.id}] failed: ${e?.kind || ''} ${e?.detail || e?.message || e}`);
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
  wake();
}

/** Called once a file has been fully sent: delete it from disk straight away. */
export async function collectTrack(job, track) {
  if (!track.file) return;
  const file = track.file;
  track.file = null;
  track.size = 0;
  track.status = 'collected';
  await fs.rm(insideDir(job.dir, file), { force: true }).catch(() => {});
  // A real download: the visitor is there, so their waiting jobs get their full time again.
  const now = Date.now();
  for (const other of jobs.values()) {
    if (other.sid !== job.sid) continue;
    other.fresh = true;
    if (other.status === 'waiting') other.waitFrom = now;
  }
  wake();
  // When nothing is left to download, the whole job goes shortly after.
  if (job.finishedAt && !job.tracks.some((t) => t.file)) leaveSoon(job);
}

/**
 * Remove a fully downloaded job after a short pause, long enough to see that
 * every song got its check mark. While the visitor is listening to one of its
 * previews it stays (until the usual expiry at most).
 */
function leaveSoon(job) {
  setTimeout(() => {
    if (!jobs.has(job.id) || job.tracks.some((t) => t.file)) return;
    if (Date.now() - (job.playedAt || 0) < 45_000) return leaveSoon(job);
    removeJob(job);
  }, 45_000).unref();
}

/**
 * A waiting job whose ready part was not downloaded in time is cancelled as a
 * whole: its files go, and the songs still to come are never fetched. The
 * empty job stays listed for a while so the visitor can see what happened.
 */
async function giveUp(job) {
  job.cancelled = true;
  job.abort.abort();
  await fs.rm(job.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  for (const t of job.tracks) {
    if (t.status !== 'collected') Object.assign(t, { status: 'cancelled', error: null, progress: 0 });
    Object.assign(t, { file: null, size: 0, coverBig: null, coverFile: null, previewFile: null, previewSize: 0, lrcFile: null });
  }
  job.status = 'error';
  job.expired = true;
  job.waitFrom = null;
  job.finishedAt = Date.now();
  wake();
}

// ------------------------------------------------------------ public view

export function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind, // "upload": a file of the visitor's own, kept by the inspector for editing
    rev: job.rev || 0,
    format: job.format,
    asAlbum: job.asAlbum,
    status: job.status,
    title: job.title,
    error: job.error,
    part: job.part, // times it has stopped to wait for space
    zips: job.zips, // parts already downloaded as a zip
    expired: !!job.expired, // cancelled because a ready part was not downloaded in time
    skipped: job.skipped || 0, // playlist videos left out because they are private or deleted
    createdAt: job.createdAt,
    expiresAt: job.finishedAt ? job.finishedAt + config.fileTtlMs : job.status === 'waiting' ? job.waitFrom + config.fileTtlMs : null,
    tracks: job.tracks.map((t) => ({
      title: t.title,
      status: t.status,
      progress: t.progress,
      error: t.error,
      why: t.why || null, // which part of the Privacy & Policy page explains the error
      ready: !!t.file,
      size: t.size || 0,
      cover: t.coverFile ? t.coverFile.slice(0, 8) : null, // changes when the artwork does, so the page reloads it
      preview: !!t.previewFile,
      lrc: !!t.lrcFile,
      gain: t.gain ?? null,
      editable: !!(t.file && t.fmt),
      coverLost: !!t.coverLost, // its own picture cannot be kept when it is written again
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
    // A file is never pulled out from under a download in progress.
    if (job.tracks.some((t) => t.sending)) continue;
    const expired = job.finishedAt && now - job.finishedAt > config.fileTtlMs;
    const stuck = now - job.createdAt > 6 * 3600_000;
    if (expired || stuck) await removeJob(job);
    else if (job.status === 'waiting' && now - job.waitFrom > config.fileTtlMs) await giveUp(job);
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
  closing = true;
  for (const job of [...jobs.values()]) await removeJob(job);
}
