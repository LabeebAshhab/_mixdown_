// The work done for one track: download, identify, fetch artwork and lyrics,
// convert, tag, verify. Also: search by song name, and writing a finished
// file's tags again after the visitor corrects them. Everything on disk uses
// random UUID names inside the job's own folder; titles and artist names never
// become file paths.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { copyArgs, estimateBytes, FORMATS, originalFormat } from './formats.js';
import { findLyrics } from './lyrics.js';
import { cleanTitle, norm, resolveMetadata, searchNorm, versions } from './metadata.js';
import { safeFetch } from './net.js';
import { run } from './proc.js';
import { readAudio } from './reader/index.js';
import { cleanText, insideDir, PublicError, publicMessage } from './security.js';
import { EXTRACTORS, parseEntry, SITES } from './sources.js';
import { appendAiffId3, appendDsfId3, appendWavId3, buildId3, ffmetadata, vorbisPictureBlock, writeMp3WithId3 } from './tags.js';

const DSD_SCRIPT = fileURLToPath(new URL('./dsd.js', import.meta.url));
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function ytdlp(...args) {
  // --use-extractors: only the sites in src/sources.js, never the generic
  // extractor that would fetch any address.
  const base = ['--ignore-config', '--no-cache-dir', '--no-warnings', '--socket-timeout', '20', '--retries', '2', '--use-extractors', EXTRACTORS, ...config.ytdlpExtra];
  if (process.env.FFMPEG_PATH) base.push('--ffmpeg-location', config.ffmpeg);
  return [...base, ...args];
}

/** @param {{site: string, url: string}} source a checked link (see src/sources.js) */
export const newTrack = (source, title) => ({
  site: source.site,
  url: source.url,
  title: cleanText(title, 200) || 'Loading…',
  status: 'queued',
  progress: 0,
});

/** Work out which songs a job covers. Only playlists need a lookup. */
export async function resolveSource(job) {
  if (job.kind !== 'playlist') {
    job.tracks = job.sources.map((s) => newTrack(s, ''));
    return;
  }
  const out = await run(
    config.ytdlp,
    ytdlp('-J', '--flat-playlist', '--playlist-end', String(config.maxTracks), '--', job.sources[0].url),
    { timeout: config.timeouts.lookup, signal: job.abort.signal },
  );
  const info = JSON.parse(out);
  const entries = (Array.isArray(info.entries) ? info.entries : [])
    .map((e) => ({ source: parseEntry(job.site, e), title: e?.title }))
    .filter((e) => e.source)
    .slice(0, config.maxTracks);
  if (!entries.length) throw new PublicError('That playlist is empty or private.');
  job.title = cleanText(info.title, 200) || 'Playlist';
  job.tracks = entries.map((e) => newTrack(e.source, e.title));
}

// ------------------------------------------------------------ search by name

const searchCache = new Map(); // query -> { at, results }
let searching = 0;

/** The first few YouTube videos for some words, as yt-dlp lists them: no live streams, nothing too long. */
async function youtubeSearch(query, signal) {
  const out = await run(config.ytdlp, ytdlp('-J', '--flat-playlist', '--playlist-end', '8', '--', `ytsearch8:${query}`), {
    timeout: 30_000,
    maxOutput: 4 * 1024 * 1024,
    signal,
  });
  const info = JSON.parse(out);
  return (Array.isArray(info.entries) ? info.entries : []).filter(
    (e) => e && VIDEO_ID.test(e.id || '') && e.live_status !== 'is_live' && !(e.duration > config.maxTrackSeconds),
  );
}

/**
 * Songs on YouTube matching a few words. The words only ever travel as the
 * text of a search (after "ytsearch8:"), never as an address or an option.
 * @returns {Promise<{url: string, title: string, by: string, duration: number|null}[]>}
 */
export async function searchSongs(query) {
  const key = query.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.results;
  if (searching >= 3) throw new PublicError('Search is busy right now. Try again in a moment.', 503);
  searching++;
  try {
    const results = (await youtubeSearch(query))
      .slice(0, 6)
      .map((e) => ({
        url: `https://www.youtube.com/watch?v=${e.id}`,
        title: cleanText(e.title, 200) || 'Untitled',
        by: cleanText(e.channel || e.uploader, 100),
        duration: Number.isFinite(e.duration) ? Math.round(e.duration) : null,
      }));
    searchCache.set(key, { at: Date.now(), results });
    while (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
    return results;
  } finally {
    searching--;
  }
}

// ------------------------------------------------------------ artwork

/** Identify an image by its first bytes; returns the matching ffmpeg demuxer. */
export function imageDemuxer(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg_pipe';
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png_pipe';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp_pipe';
  return null;
}

async function fetchCover(url) {
  const urls = [url];
  if (/\/front-1200$/.test(url)) urls.push(url.replace(/-1200$/, '-500'));
  let last;
  for (const u of urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt) await new Promise((r) => setTimeout(r, attempt * 1500));
        const res = await safeFetch(u, { timeout: 25_000, maxBytes: 15 * 1024 * 1024, accept: 'image/*' });
        if (res.status === 404) break;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!imageDemuxer(res.body)) throw new Error('not an image');
        return res.body;
      } catch (e) {
        last = e;
      }
    }
  }
  throw last || new Error('cover not found');
}

// Tracks from the same album share one artwork download. Small and short-lived.
const coverCache = new Map(); // url -> { at, data: Buffer | Promise<Buffer> }
async function downloadCover(url) {
  const hit = coverCache.get(url);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.data;
  const pending = fetchCover(url);
  coverCache.set(url, { at: Date.now(), data: pending });
  try {
    const data = await pending;
    coverCache.set(url, { at: Date.now(), data });
    while (coverCache.size > 24) coverCache.delete(coverCache.keys().next().value);
    return data;
  } catch (e) {
    coverCache.delete(url);
    throw e;
  }
}

/**
 * Take the first candidate that works (catalogue artwork, the video
 * thumbnail, or an image the visitor uploaded), check that it really is an
 * image, and re-encode it into two clean JPEGs in the job's folder: a large
 * square one to embed and a small one for the interface. Re-encoding means
 * nothing from the original file except its pixels is kept.
 * @param {{url?: string, file?: string, data?: Buffer, label: string}[]} candidates
 */
async function prepareCover(job, work, candidates) {
  for (const c of candidates) {
    try {
      const data = c.data || (c.url ? await downloadCover(c.url) : await fs.readFile(c.file));
      const demuxer = imageDemuxer(data);
      if (!demuxer) throw new Error('not an image');
      const raw = path.join(work, `cover-${randomUUID()}.raw`);
      await fs.writeFile(raw, data);
      const bigName = `${randomUUID()}.jpg`;
      const smallName = `${randomUUID()}.jpg`;
      try {
        await run(
          config.ffmpeg,
          [
            '-nostdin', '-y', '-v', 'error', '-f', demuxer, '-i', raw,
            '-filter_complex',
            "[0:v]crop='min(iw,ih)':'min(iw,ih)',split[a][b];[a]scale='min(1400,iw)':'min(1400,ih)'[big];[b]scale=256:256[small]",
            '-map', '[big]', '-frames:v', '1', '-q:v', '2', '-pix_fmt', 'yuvj420p', insideDir(job.dir, bigName),
            '-map', '[small]', '-frames:v', '1', '-q:v', '4', '-pix_fmt', 'yuvj420p', insideDir(job.dir, smallName),
          ],
          { timeout: 60_000, signal: job.abort.signal },
        );
      } catch (e) {
        await Promise.all([bigName, smallName].map((n) => fs.rm(insideDir(job.dir, n), { force: true }).catch(() => {})));
        throw e;
      }
      return { big: bigName, small: smallName, label: c.label };
    } catch (e) {
      console.warn(`[job ${job.id}] cover (${c.label}) failed: ${e.kind || e.message}`);
    }
  }
  return { big: null, small: null, label: null };
}

/** Put new artwork on a track and remove the files of the old one. */
async function swapCover(job, track, cover) {
  const old = [track.coverBig, track.coverFile].filter(Boolean);
  track.coverBig = cover.big;
  track.coverFile = cover.small;
  if (track.match) track.match.cover = cover.label;
  await Promise.all(old.map((n) => fs.rm(insideDir(job.dir, n), { force: true }).catch(() => {})));
}

// ------------------------------------------------------------ loudness, preview

/**
 * How many dB to turn a song up or down so it sits at the target loudness
 * (EBU R 128, -14 LUFS by default), without its peaks passing -1 dBTP. One
 * fixed gain for the whole song, so its dynamics are untouched. Null when it
 * cannot be measured (silence, or an ffmpeg without the filter).
 */
async function loudnessGain(source, signal) {
  const log = await run(
    config.ffmpeg,
    ['-nostdin', '-hide_banner', '-nostats', '-i', source, '-map', '0:a:0', '-af', `loudnorm=I=${config.loudnessTarget}:TP=-1:LRA=11:print_format=json`, '-f', 'null', '-'],
    { timeout: config.timeouts.convert, signal, stderr: true },
  );
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(log);
  if (!m) return null;
  const measured = JSON.parse(m[0]);
  const loudness = Number(measured.input_i);
  const peak = Number(measured.input_tp);
  if (!Number.isFinite(loudness) || !Number.isFinite(peak)) return null;
  const gain = Math.round(Math.min(config.loudnessTarget - loudness, -1 - peak) * 10) / 10;
  return Math.max(-30, Math.min(30, gain));
}

/** A small MP3 every browser can play, for the in-page player. Never fatal. */
async function makePreview(job, source, gain, signal) {
  if (!config.preview) return null;
  const name = `${randomUUID()}.mp3`;
  try {
    await run(
      config.ffmpeg,
      [
        '-nostdin', '-y', '-hide_banner', '-v', 'error', '-i', source, '-map', '0:a:0', '-map_metadata', '-1',
        '-t', String(config.previewSeconds), ...(gain ? ['-af', `volume=${gain.toFixed(1)}dB`] : []),
        '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', '-id3v2_version', '0', insideDir(job.dir, name),
      ],
      { timeout: config.timeouts.convert, signal },
    );
    return name;
  } catch (e) {
    await fs.rm(insideDir(job.dir, name), { force: true }).catch(() => {});
    if (e?.kind !== 'aborted') console.warn(`[job ${job.id}] preview failed: ${e?.kind || e?.message}`);
    return null;
  }
}

// ------------------------------------------------------------ writing the file

/**
 * Write one tagged file. The audio comes from `input`: converted with
 * `audioArgs` the first time, copied unchanged (see copyArgs) when a finished
 * file is tagged again.
 * @param {{job: object, work: string, input: string, outPath: string, fmt: object, audioArgs: string[],
 *   dsd?: {rate: string, gain: number}, tags: object, lyrics: string|null, synced: string|null, coverBig: string|null}} o
 */
async function writeTagged({ job, work, input, outPath, fmt, audioArgs, dsd, tags, lyrics, synced, coverBig }) {
  const signal = job.abort.signal;
  const coverData = coverBig && (fmt.cover === 'id3' || fmt.cover === 'vorbis') ? await fs.readFile(coverBig) : null;
  const id3 = () => buildId3(tags, { lyrics, synced, cover: coverData });

  if (fmt.special === 'dsd') {
    if (dsd) {
      await run(process.execPath, [DSD_SCRIPT, config.ffmpeg, input, outPath, dsd.rate, String(dsd.gain || 0)], { timeout: config.timeouts.convert, signal });
    } else {
      await fs.copyFile(input, outPath); // tagging again: same audio, the old tag is cut off below
    }
    await appendDsfId3(outPath, id3());
    return;
  }

  const metaFile = path.join(work, `meta-${randomUUID()}.txt`);
  let meta = ';FFMETADATA1\n';
  if (fmt.tags === 'ffmpeg') {
    meta = ffmetadata(tags, fmt.numbering, {
      lyrics,
      pictureBlock: fmt.cover === 'vorbis' && coverData ? vorbisPictureBlock(coverData) : null,
    });
  } else if (fmt.ext === 'wav') {
    meta = ffmetadata(tags, 'slash'); // basic RIFF INFO for players that ignore ID3 in WAV
  }
  await fs.writeFile(metaFile, meta);

  const attach = fmt.cover === 'attach' && coverBig;
  const ffOut = fmt.ext === 'mp3' ? path.join(work, `audio-${randomUUID()}.mp3`) : outPath;
  const args = ['-nostdin', '-y', '-hide_banner', '-v', 'error', '-i', input];
  if (attach) args.push('-i', coverBig);
  args.push('-f', 'ffmetadata', '-i', metaFile, '-map', '0:a:0');
  if (attach) {
    args.push(
      '-map', '1:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
      '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)',
    );
  }
  args.push('-map_metadata', attach ? '2' : '1', '-map_metadata:s:a', '-1', '-map_chapters', '-1', ...audioArgs, ffOut);
  await run(config.ffmpeg, args, { timeout: config.timeouts.convert, signal });

  if (fmt.ext === 'mp3') await writeMp3WithId3(ffOut, outPath, id3());
  else if (fmt.ext === 'wav') await appendWavId3(outPath, id3());
  else if (fmt.ext === 'aiff') await appendAiffId3(outPath, id3());
}

/** Which lyrics text goes into the file, and whether a separate timed form exists. */
function lyricsFor(job, lyrics) {
  const timed = job.syncedLyrics && lyrics?.synced ? lyrics.synced : null;
  return { embed: timed || lyrics?.plain || null, synced: timed };
}

/** Keep the time-synced lyrics next to the song as a .lrc file the visitor can download. */
async function saveLrc(job, track, synced) {
  const old = track.lrcFile;
  track.lrcFile = null;
  if (old) await fs.rm(insideDir(job.dir, old), { force: true }).catch(() => {});
  if (!synced) return;
  const name = `${randomUUID()}.lrc`;
  await fs.writeFile(insideDir(job.dir, name), `${synced}\n`, { mode: 0o600 });
  track.lrcFile = name;
}

/** The name suggested to the browser; the name on disk stays a UUID. */
function downloadName(job, index, tags, ext) {
  const prefix = job.tracks.length > 1 ? `${String(index + 1).padStart(2, '0')} - ` : '';
  return `${prefix}${tags.artist ? `${tags.artist} - ` : ''}${tags.title}.${ext}`;
}

// ------------------------------------------------------------ verification

async function readMeta(file) {
  const { format, common } = await readAudio(file);
  return {
    container: format.container,
    codec: format.codec,
    lossless: !!format.lossless,
    sampleRate: format.sampleRate,
    bitsPerSample: format.bitsPerSample,
    channels: format.numberOfChannels,
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
    duration: format.duration,
    title: common.title,
    artist: common.artist,
    album: common.album,
    albumArtist: common.albumartist,
    year: common.year,
    track: common.track?.no ?? null,
    trackTotal: common.track?.of ?? null,
    disc: common.disk?.no ?? null,
    genre: common.genre?.[0],
    cover: !!common.picture?.length,
    lyrics: !!common.lyrics?.length,
  };
}

// ------------------------------------------------------------ SoundCloud previews

// Without a Go+ subscription SoundCloud plays only a 30-second clip of some
// songs (mostly label releases); yt-dlp names those streams "preview". A clip
// is never handed over as if it were the song: the full song is looked for on
// YouTube instead, and when it cannot be found the track fails with a reason.
// A song shorter than the clip is already whole.
const isPreview = (info) => /preview/i.test(String(info.format_id || '')) && !(info.duration < 29);

const OTHER_KIND = /\b(cover|karaoke|tribute|reaction|tutorial|lesson|mashup|parody|bass boosted|reverb|full album|compilation)\b/i;
const squash = (s) => norm(s).replace(/ /g, '');

/** Share of the words of `want` found in `text`, 0..1. */
function covered(want, text) {
  const words = norm(want).split(' ').filter(Boolean);
  if (!words.length) return 0;
  const have = new Set(searchNorm(text).split(' '));
  return words.filter((w) => have.has(w)).length / words.length;
}

/**
 * How well a YouTube search result fits a song, 0 when it is not that song.
 * The title and artist have to be there and the kind of recording (live,
 * remix, ...) has to agree; the artist's own channel, an audio-only upload and
 * the right length then decide between the ones left.
 */
function scoreVideo(e, want, rank) {
  const length = Number(e.duration);
  if (!(length >= 40)) return 0;
  const title = String(e.title || '');
  const channel = String(e.channel || e.uploader || '');
  if (covered(want.core, title) < 0.8) return 0;
  if (want.artist && covered(want.artist, `${channel} ${title}`) < 0.8) return 0;
  const kinds = versions(title);
  if (kinds.size !== want.kinds.size || [...kinds].some((k) => !want.kinds.has(k))) return 0;
  if (OTHER_KIND.test(title) && !OTHER_KIND.test(want.text)) return 0;

  let s = 0.5 - rank * 0.02;
  const name = channel.replace(/ - Topic$/, '').replace(/\s*VEVO$/i, '');
  if (want.artist && squash(name) === squash(want.artist)) s += 0.2;
  if (/ - Topic$/.test(channel) || /\baudio\b/i.test(title)) s += 0.1;
  if (e.channel_is_verified) s += 0.05;
  if (want.duration) {
    const diff = Math.abs(length - want.duration);
    s += diff <= 3 ? 0.3 : diff <= 8 ? 0.15 : diff <= 20 ? 0 : -0.3;
  }
  return s;
}

/**
 * The same song on YouTube, or null. The words only ever travel as the text
 * of a search, and the address is rebuilt from the checked video id.
 * @param {{title: string, artist: string, duration: number|null}} song
 * @param {string} listed the title as the other site shows it
 */
async function findOnYouTube(song, listed, signal) {
  const text = `${listed} ${song.title}`;
  const want = {
    artist: song.artist,
    core: norm(cleanTitle(song.title).replace(/[([][^)\]]*[)\]]/g, ' ')) || norm(song.title),
    kinds: versions(text),
    text,
    duration: song.duration,
  };
  const query = cleanText(`${song.artist} ${song.title}`, 150);
  if (!want.core || query.length < 2) return null;
  let best = null;
  (await youtubeSearch(query, signal)).forEach((e, rank) => {
    const s = scoreVideo(e, want, rank);
    if (s > 0.25 && (!best || s > best.s)) best = { s, id: e.id };
  });
  return best && { site: 'youtube', url: `https://www.youtube.com/watch?v=${best.id}` };
}

/**
 * Called when SoundCloud gave only its clip: identify the song from what
 * SoundCloud says about it, then download the whole of it from YouTube.
 * @returns {Promise<{got: object, match: object}>} the new download and the catalogue match
 */
async function fullSong(job, track, work, clip) {
  const only = 'SoundCloud only gives a 30-second preview of this song';
  if (!config.soundcloudFallback) throw new PublicError(`${only}. The whole song needs a SoundCloud Go+ subscription.`);
  // The clip's length says nothing about the song's, so it is left out of the lookup.
  const match = await resolveMetadata({ ...clip, duration: undefined });
  const video = await findOnYouTube({ ...match.tags, duration: match.duration }, String(clip.title || ''), job.abort.signal).catch((e) => {
    if (e?.kind === 'aborted') throw e;
    console.warn(`[job ${job.id}] YouTube search for the full song failed: ${e?.kind || e?.message}`);
    return null;
  });
  if (!video) throw new PublicError(`${only}, and I could not find the whole song on YouTube.`);
  const dir = path.join(work, 'full');
  await fs.mkdir(dir);
  track.progress = 0;
  return { got: await download(job, track, dir, video.url), match };
}

// ------------------------------------------------------------ one track

/** Download the best audio stream of one checked address into `dir`, with its info and thumbnail. */
async function download(job, track, dir, url) {
  await run(
    config.ytdlp,
    ytdlp(
      '-f', 'bestaudio/best',
      '--no-playlist',
      '--max-filesize', `${Math.floor(config.maxSourceBytes / 1048576)}M`,
      '--match-filter', `duration <=? ${config.maxTrackSeconds} & !is_live`,
      '--newline',
      '--write-info-json',
      '--write-thumbnail',
      '--convert-thumbnails', 'jpg',
      '--progress-template', 'download:PROGRESS %(progress._percent_str)s',
      '-o', path.join(dir, 'src.%(ext)s'),
      '--', url,
    ),
    {
      timeout: config.timeouts.download,
      signal: job.abort.signal,
      onLine: (line) => {
        const m = /PROGRESS\s+([\d.]+)%/.exec(line);
        if (m) track.progress = Math.min(80, Math.round(parseFloat(m[1]) * 0.8));
      },
    },
  );
  const files = await fs.readdir(dir);
  const srcName = files.find((f) => /^src\.[a-z0-9]{1,5}$/i.test(f) && !/\.(json|jpg|jpeg|png|webp|part|ytdl)$/i.test(f));
  if (!srcName || !files.includes('src.info.json')) {
    throw new PublicError(`This one is a live stream, longer than ${Math.round(config.maxTrackSeconds / 60)} minutes, or too large.`);
  }
  return {
    source: path.join(dir, srcName),
    ext: path.extname(srcName).slice(1).toLowerCase(),
    info: JSON.parse(await fs.readFile(path.join(dir, 'src.info.json'), 'utf8')),
    thumbnail: files.includes('src.jpg') ? path.join(dir, 'src.jpg') : null,
  };
}

export async function processTrack(job, track, index) {
  const signal = job.abort.signal;
  const work = insideDir(job.dir, `work-${randomUUID()}`);
  await fs.mkdir(work, { recursive: true });
  const site = SITES[track.site] || SITES.youtube;

  try {
    // 1. Download the best audio stream, its info and thumbnail. The address
    //    was rebuilt from checked parts (src/sources.js).
    track.status = 'downloading';
    let got = await download(job, track, work, track.url);
    const listed = got.info; // what the pasted site says about the song
    const thumbnail = got.thumbnail;
    track.title = cleanText(listed.title, 200) || track.title;
    if (job.tracks.length === 1) job.title = track.title;

    // SoundCloud's 30-second clip is swapped for the whole song from YouTube.
    let found = null;
    if (track.site === 'soundcloud' && isPreview(listed)) {
      ({ got, match: found } = await fullSong(job, track, work, listed));
    }
    const { source, info } = got; // `info` describes the audio that will be converted
    track.source = { codec: cleanText(info.acodec, 20), bitrate: Number.isFinite(info.abr) ? Math.round(info.abr) : null };

    // Refuse before converting if the result would not fit in the visitor's space.
    const estimate = estimateBytes(job.format, job.options, {
      duration: Number(info.duration) || 0,
      sourceRate: Number(info.asr) || 48000,
      sourceBytes: (await fs.stat(source)).size,
    });
    if (estimate > job.room()) {
      throw new PublicError('There is not enough of your space left for this one. Download what is ready, then add it again.');
    }

    // 2. Identify the song: catalogue tags, album artwork, lyrics.
    track.status = 'tagging';
    track.progress = 82;
    const match = found || (await resolveMetadata(listed));
    const matched = match.confidence !== null;
    const tags = match.tags;
    if (job.asAlbum && job.kind === 'playlist' && job.tracks.length > 1) {
      tags.album = job.title.replace(/^Album\s+-\s+/, '');
      tags.albumArtist = 'Various Artists';
      tags.track = index + 1;
      tags.trackTotal = job.tracks.length;
      tags.disc = 1;
      tags.discTotal = null;
    }
    const candidates = [];
    if (match.coverUrl) candidates.push({ url: match.coverUrl, label: `${match.source} album art` });
    if (thumbnail) candidates.push({ file: thumbnail, label: site.artwork });
    const [lyrics, cover] = await Promise.all([
      job.wantLyrics
        ? findLyrics({ title: tags.title, artist: tags.artist, album: tags.album, duration: info.duration }).catch(() => null)
        : null,
      prepareCover(job, work, candidates),
    ]);
    track.coverBig = cover.big;
    track.coverFile = cover.small;
    track.match = {
      source: matched ? match.source : site.label,
      matched,
      confidence: match.confidence,
      cover: cover.label,
      lookupFailed: match.lookupFailed,
      fullFrom: found ? SITES.youtube.label : undefined, // the site had only a clip of it
    };

    // 3. Convert and tag.
    track.status = 'converting';
    track.progress = 86;
    let fmt = FORMATS[job.format];
    const copied = fmt.special === 'original';
    if (copied) fmt = originalFormat(got.ext);

    // Loudness: measured first, then applied as one fixed gain while converting.
    // "Original" copies the stream as it is, so there is nothing to apply it to.
    let gain = 0;
    if (job.normalize && !copied) {
      gain = (await loudnessGain(source, signal).catch((e) => {
        if (e?.kind === 'aborted') throw e;
        console.warn(`[job ${job.id}] loudness could not be measured: ${e?.kind || e?.message}`);
        return null;
      })) || 0;
      track.gain = gain;
    }
    track.progress = 90;

    const diskName = `${randomUUID()}.${fmt.ext}`;
    const outPath = insideDir(job.dir, diskName);
    const { embed, synced } = lyricsFor(job, lyrics);
    await writeTagged({
      job,
      work,
      input: source,
      outPath,
      fmt,
      audioArgs: fmt.special === 'dsd' ? [] : [...(gain ? ['-af', `volume=${gain.toFixed(1)}dB`] : []), ...fmt.args(job.options)],
      dsd: fmt.special === 'dsd' ? { rate: job.options.rate, gain } : null,
      tags,
      lyrics: embed,
      synced,
      coverBig: cover.big ? insideDir(job.dir, cover.big) : null,
    });
    await saveLrc(job, track, synced);
    track.progress = 96;
    track.previewFile = await makePreview(job, source, gain, signal);
    if (track.previewFile) track.previewSize = (await fs.stat(insideDir(job.dir, track.previewFile))).size;

    // 4. Read the finished file back to verify what was written.
    track.meta = await readMeta(outPath);
    track.title = track.meta.title || tags.title;
    track.name = downloadName(job, index, tags, fmt.ext);
    track.size = (await fs.stat(outPath)).size;
    // Kept so the tags can be written again if the visitor corrects them.
    track.tags = tags;
    track.lyrics = lyrics;
    track.fmt = { ext: fmt.ext, tags: fmt.tags, numbering: fmt.numbering, cover: fmt.cover, special: fmt.special === 'dsd' ? 'dsd' : undefined };
    track.file = diskName;
    track.progress = 100;
    track.status = 'done';
    console.log(`[job ${job.id}] track ${index + 1}/${job.tracks.length} done (${track.match.source}${found ? ', full song from YouTube' : ''}, ${fmt.ext}, ${track.size} bytes)`);
  } catch (e) {
    track.status = 'error';
    track.error = publicMessage(e);
    for (const key of ['coverBig', 'previewFile', 'lrcFile']) {
      if (track[key]) await fs.rm(insideDir(job.dir, track[key]), { force: true }).catch(() => {});
      track[key] = null;
    }
    if (e?.kind !== 'aborted') console.error(`[job ${job.id}] track ${index + 1} failed: ${e?.kind || ''} ${e?.detail || e?.message || e}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

// ------------------------------------------------------------ fixing a match

/**
 * Look a song up in the catalogues again, this time from a title and artist
 * the visitor typed. Returns null when nothing matches well enough.
 */
export async function lookupSong({ title, artist, duration }) {
  const match = await resolveMetadata({ track: title, artist, artists: [artist], title: `${artist} - ${title}`, duration });
  if (match.confidence === null) return match.lookupFailed ? { failed: true } : null;
  return { source: match.source, tags: match.tags, coverUrl: match.coverUrl };
}

/** New artwork for a finished track from an image the visitor uploaded. */
export async function uploadCover(job, track, data) {
  const work = insideDir(job.dir, `work-${randomUUID()}`);
  await fs.mkdir(work, { recursive: true });
  try {
    const cover = await prepareCover(job, work, [{ data, label: 'Your image' }]);
    if (!cover.small) throw new PublicError('That image could not be read. Use a JPEG, PNG or WebP picture.', 415);
    await swapCover(job, track, cover);
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/**
 * Write a finished file again with corrected tags (and the track's current
 * artwork). The audio is copied bit for bit, never converted a second time.
 * @param {{tags: object, cover?: {url: string, label: string}}} edit `cover.url` only ever comes from a catalogue lookup
 */
export async function retagTrack(job, track, index, edit) {
  const work = insideDir(job.dir, `work-${randomUUID()}`);
  await fs.mkdir(work, { recursive: true });
  const fmt = track.fmt;
  const diskName = `${randomUUID()}.${fmt.ext}`;
  const outPath = insideDir(job.dir, diskName);
  try {
    const tags = { ...track.tags, ...edit.tags };
    if (edit.cover) {
      const cover = await prepareCover(job, work, [edit.cover]);
      if (cover.small) await swapCover(job, track, cover);
    }
    // A corrected name is a second chance to find lyrics that were missed.
    let lyrics = track.lyrics;
    if (job.wantLyrics && !lyrics && (tags.title !== track.tags.title || tags.artist !== track.tags.artist)) {
      lyrics = await findLyrics({ title: tags.title, artist: tags.artist, album: tags.album, duration: track.meta?.duration }).catch(() => null);
    }
    const { embed, synced } = lyricsFor(job, lyrics);
    const old = insideDir(job.dir, track.file);
    await writeTagged({
      job,
      work,
      input: old,
      outPath,
      fmt,
      audioArgs: copyArgs(fmt.ext),
      tags,
      lyrics: embed,
      synced,
      coverBig: track.coverBig ? insideDir(job.dir, track.coverBig) : null,
    });
    const meta = await readMeta(outPath);
    const size = (await fs.stat(outPath)).size;
    if (!track.file || job.cancelled) throw new PublicError('That file is gone.', 404);
    await saveLrc(job, track, synced);
    Object.assign(track, { meta, size, tags, lyrics, file: diskName, title: meta.title || tags.title, name: downloadName(job, index, tags, fmt.ext) });
    if (job.tracks.length === 1) job.title = track.title;
    track.match = { ...track.match, edited: true };
    await fs.rm(old, { force: true }).catch(() => {});
  } catch (e) {
    await fs.rm(outPath, { force: true }).catch(() => {});
    throw e;
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
