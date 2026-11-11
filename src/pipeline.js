// The work done for one track: download, identify, fetch artwork and lyrics,
// convert, tag, verify. Everything on disk uses random UUID names inside the
// job's own folder; titles and artist names never become file paths.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { estimateBytes, FORMATS, originalFormat } from './formats.js';
import { findLyrics } from './lyrics.js';
import { resolveMetadata } from './metadata.js';
import { safeFetch } from './net.js';
import { run } from './proc.js';
import { readAudio } from './reader/index.js';
import { cleanText, insideDir, PublicError, publicMessage } from './security.js';
import { appendAiffId3, appendDsfId3, appendWavId3, buildId3, ffmetadata, vorbisPictureBlock, writeMp3WithId3 } from './tags.js';

const DSD_SCRIPT = fileURLToPath(new URL('./dsd.js', import.meta.url));
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function ytdlp(...args) {
  const base = ['--ignore-config', '--no-cache-dir', '--no-warnings', '--socket-timeout', '20', '--retries', '2', ...config.ytdlpExtra];
  if (process.env.FFMPEG_PATH) base.push('--ffmpeg-location', config.ffmpeg);
  return [...base, ...args];
}

export const newTrack = (videoId, title) => ({
  videoId,
  title: cleanText(title, 200) || 'Loading…',
  status: 'queued',
  progress: 0,
});

/** Work out which videos a job covers. Only playlists need a lookup. */
export async function resolveSource(job) {
  if (job.kind === 'video') {
    job.tracks = [newTrack(job.sourceId, '')];
    return;
  }
  const out = await run(
    config.ytdlp,
    ytdlp('-J', '--flat-playlist', '--playlist-end', String(config.maxTracks), '--', job.url),
    { timeout: config.timeouts.lookup, signal: job.abort.signal },
  );
  const info = JSON.parse(out);
  const entries = (Array.isArray(info.entries) ? info.entries : []).filter((e) => e && VIDEO_ID.test(e.id || '')).slice(0, config.maxTracks);
  if (!entries.length) throw new PublicError('That playlist is empty or private.');
  job.title = cleanText(info.title, 200) || 'Playlist';
  job.tracks = entries.map((e) => newTrack(e.id, e.title));
}

// ------------------------------------------------------------ artwork

/** Identify an image by its first bytes; returns the matching ffmpeg demuxer. */
function imageDemuxer(buf) {
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
 * Fetch the album artwork (or fall back to the video thumbnail), check that it
 * really is an image, and re-encode it into two clean JPEGs: a large square
 * one to embed and a small one for the interface.
 */
async function prepareCover(job, work, match, thumbPath) {
  const candidates = [];
  if (match.coverUrl) candidates.push({ url: match.coverUrl, label: `${match.source} album art` });
  if (thumbPath) candidates.push({ file: thumbPath, label: 'YouTube thumbnail' });

  for (const c of candidates) {
    try {
      const data = c.url ? await downloadCover(c.url) : await fs.readFile(c.file);
      const demuxer = imageDemuxer(data);
      if (!demuxer) throw new Error('not an image');
      const raw = path.join(work, 'cover.raw');
      await fs.writeFile(raw, data);
      const big = path.join(work, 'cover.jpg');
      const smallName = `${randomUUID()}.jpg`;
      await run(
        config.ffmpeg,
        [
          '-nostdin', '-y', '-v', 'error', '-f', demuxer, '-i', raw,
          '-filter_complex',
          "[0:v]crop='min(iw,ih)':'min(iw,ih)',split[a][b];[a]scale='min(1400,iw)':'min(1400,ih)'[big];[b]scale=256:256[small]",
          '-map', '[big]', '-frames:v', '1', '-q:v', '2', '-pix_fmt', 'yuvj420p', big,
          '-map', '[small]', '-frames:v', '1', '-q:v', '4', '-pix_fmt', 'yuvj420p', insideDir(job.dir, smallName),
        ],
        { timeout: 60_000, signal: job.abort.signal },
      );
      return { big, small: smallName, label: c.label };
    } catch (e) {
      console.warn(`[job ${job.id}] cover (${c.label}) failed: ${e.kind || e.message}`);
    }
  }
  return { big: null, small: null, label: null };
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

// ------------------------------------------------------------ one track

export async function processTrack(job, track, index) {
  const signal = job.abort.signal;
  const work = insideDir(job.dir, `work-${randomUUID()}`);
  await fs.mkdir(work, { recursive: true });

  try {
    // 1. Download the best audio stream, its info and thumbnail. The URL is
    //    rebuilt from a validated 11-character video id.
    track.status = 'downloading';
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
        '-o', path.join(work, 'src.%(ext)s'),
        '--', `https://www.youtube.com/watch?v=${track.videoId}`,
      ),
      {
        timeout: config.timeouts.download,
        signal,
        onLine: (line) => {
          const m = /PROGRESS\s+([\d.]+)%/.exec(line);
          if (m) track.progress = Math.min(80, Math.round(parseFloat(m[1]) * 0.8));
        },
      },
    );

    const files = await fs.readdir(work);
    const srcName = files.find((f) => /^src\.[a-z0-9]{1,5}$/i.test(f) && !/\.(json|jpg|jpeg|png|webp|part|ytdl)$/i.test(f));
    if (!srcName || !files.includes('src.info.json')) {
      throw new PublicError(`This one is a live stream, longer than ${Math.round(config.maxTrackSeconds / 60)} minutes, or too large.`);
    }
    const source = path.join(work, srcName);
    const info = JSON.parse(await fs.readFile(path.join(work, 'src.info.json'), 'utf8'));
    track.title = cleanText(info.title, 200) || track.title;
    if (job.tracks.length === 1) job.title = track.title;
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
    const match = await resolveMetadata(info);
    const tags = match.tags;
    if (job.asAlbum && job.tracks.length > 1) {
      tags.album = job.title.replace(/^Album\s+-\s+/, '');
      tags.albumArtist = 'Various Artists';
      tags.track = index + 1;
      tags.trackTotal = job.tracks.length;
      tags.disc = 1;
      tags.discTotal = null;
    }
    const [lyrics, cover] = await Promise.all([
      job.wantLyrics
        ? findLyrics({ title: tags.title, artist: tags.artist, album: tags.album, duration: info.duration }).catch(() => null)
        : null,
      prepareCover(job, work, match, files.includes('src.jpg') ? path.join(work, 'src.jpg') : null),
    ]);
    track.coverFile = cover.small;
    track.match = { source: match.source, confidence: match.confidence, cover: cover.label, lookupFailed: match.lookupFailed };

    // 3. Convert and tag.
    track.status = 'converting';
    track.progress = 88;
    let fmt = FORMATS[job.format];
    if (fmt.special === 'original') fmt = originalFormat(path.extname(srcName).slice(1).toLowerCase());
    const diskName = `${randomUUID()}.${fmt.ext}`;
    const outPath = insideDir(job.dir, diskName);
    const coverData = cover.big && (fmt.cover === 'id3' || fmt.cover === 'vorbis') ? await fs.readFile(cover.big) : null;
    const id3 = () => buildId3(tags, { lyrics, cover: coverData });

    if (fmt.special === 'dsd') {
      await run(process.execPath, [DSD_SCRIPT, config.ffmpeg, source, outPath, job.options.rate], {
        timeout: config.timeouts.convert,
        signal,
      });
      await appendDsfId3(outPath, id3());
    } else {
      const metaFile = path.join(work, 'meta.txt');
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

      const attach = fmt.cover === 'attach' && cover.big;
      const ffOut = fmt.ext === 'mp3' ? path.join(work, 'audio.mp3') : outPath;
      const args = ['-nostdin', '-y', '-hide_banner', '-v', 'error', '-i', source];
      if (attach) args.push('-i', cover.big);
      args.push('-f', 'ffmetadata', '-i', metaFile, '-map', '0:a:0');
      if (attach) {
        args.push(
          '-map', '1:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
          '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)',
        );
      }
      args.push('-map_metadata', attach ? '2' : '1', '-map_metadata:s:a', '-1', '-map_chapters', '-1', ...fmt.args(job.options), ffOut);
      await run(config.ffmpeg, args, { timeout: config.timeouts.convert, signal });

      if (fmt.ext === 'mp3') await writeMp3WithId3(ffOut, outPath, id3());
      else if (fmt.ext === 'wav') await appendWavId3(outPath, id3());
      else if (fmt.ext === 'aiff') await appendAiffId3(outPath, id3());
    }

    // 4. Read the finished file back to verify what was written.
    track.meta = await readMeta(outPath);
    track.title = track.meta.title || tags.title;
    const prefix = job.tracks.length > 1 ? `${String(index + 1).padStart(2, '0')} - ` : '';
    track.name = `${prefix}${tags.artist ? `${tags.artist} - ` : ''}${tags.title}.${fmt.ext}`;
    track.size = (await fs.stat(outPath)).size;
    track.file = diskName;
    track.progress = 100;
    track.status = 'done';
    console.log(`[job ${job.id}] track ${index + 1}/${job.tracks.length} done (${match.source}, ${fmt.ext}, ${track.size} bytes)`);
  } catch (e) {
    track.status = 'error';
    track.error = publicMessage(e);
    if (e?.kind !== 'aborted') console.error(`[job ${job.id}] track ${index + 1} failed: ${e?.kind || ''} ${e?.detail || e?.message || e}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
