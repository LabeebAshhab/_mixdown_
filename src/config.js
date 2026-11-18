// All settings in one place. Every value comes from an environment variable
// (see .env.example) and is range-checked before use.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSPECT_TYPES, TYPE_ALIASES } from './inspect-types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function num(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

function httpsUrl(name, def) {
  try {
    const u = new URL(process.env[name] || def);
    return u.protocol === 'https:' ? u.toString() : def;
  } catch {
    return def;
  }
}

/** Scheme and host of an https address, nothing else; empty when unset or invalid. */
function httpsOrigin(name) {
  try {
    const u = new URL(process.env[name] || '');
    return u.protocol === 'https:' && !u.username && !u.password ? u.origin : '';
  } catch {
    return '';
  }
}

function text(name, def, max = 80) {
  const v = process.env[name];
  // eslint-disable-next-line no-control-regex
  return v === undefined ? def : v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

/**
 * A key for one of the catalogues that need one. It travels in a request
 * header or address, so only the characters such keys are made of are let
 * through; anything else counts as "not set".
 */
function secret(name) {
  const v = (process.env[name] || '').trim();
  return /^[A-Za-z0-9_.~=+/-]{8,200}$/.test(v) ? v : '';
}

// The catalogues a song can be looked up in, and the settings each one needs.
// The first three are open; the others answer only with a key of the server's own.
const keys = {
  tidal: { id: secret('TIDAL_CLIENT_ID'), secret: secret('TIDAL_CLIENT_SECRET') },
  spotify: { id: secret('SPOTIFY_CLIENT_ID'), secret: secret('SPOTIFY_CLIENT_SECRET') },
  discogs: { token: secret('DISCOGS_TOKEN') },
  lastfm: { key: secret('LASTFM_API_KEY') },
};
const CATALOGUE_READY = {
  itunes: true,
  deezer: true,
  tidal: !!(keys.tidal.id && keys.tidal.secret),
  spotify: !!(keys.spotify.id && keys.spotify.secret),
  musicbrainz: true,
  discogs: !!keys.discogs.token,
  lastfm: !!keys.lastfm.key,
};

/**
 * The catalogues to ask, in order. CATALOGUES may reorder them or leave some
 * out; unknown words are dropped, and one without its key is never asked.
 */
function catalogueOrder() {
  const all = Object.keys(CATALOGUE_READY);
  const wanted = String(process.env.CATALOGUES || '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((w) => w.replace(/[^a-z]/g, ''))
    .filter((w, i, list) => all.includes(w) && list.indexOf(w) === i);
  return (wanted.length ? wanted : all).filter((id) => CATALOGUE_READY[id]);
}

/**
 * A list of the inspector's file kinds ("mp3, flac wav"). Unknown words are
 * dropped; a list with nothing usable in it falls back to every kind.
 */
function fileKinds(name) {
  const all = Object.keys(INSPECT_TYPES);
  const wanted = String(process.env[name] || '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((w) => TYPE_ALIASES[w.replace(/^\./, '')] || w.replace(/^\./, ''))
    .filter((w) => all.includes(w));
  return wanted.length ? all.filter((id) => wanted.includes(id)) : all;
}

export const config = {
  root,
  port: num('PORT', 8080, 1, 65535),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ytdlpExtra: (process.env.YTDLP_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),

  // Network / proxy
  // The site's public address (https://music.example.com), used only to give
  // shared links an absolute preview image. Empty = relative addresses.
  publicUrl: httpsOrigin('PUBLIC_URL'),
  trustProxy: process.env.TRUST_PROXY || '',
  cookieSecure: process.env.COOKIE_SECURE === '1',
  accessPassword: process.env.ACCESS_PASSWORD || '',

  // Storage limits
  quotaBytes: Math.round(num('QUOTA_GB', 3, 0.05, 1000) * GIB), // per browser, waiting to be downloaded
  // All browsers at one IP address together: twice the browser's share unless set, never less than it.
  ipQuotaBytes: Math.round(Math.max(num('QUOTA_GB', 3, 0.05, 1000), num('IP_QUOTA_GB', num('QUOTA_GB', 3, 0.05, 1000) * 2, 0.05, 100000)) * GIB),
  maxJobBytes: Math.round(num('MAX_PLAYLIST_GB', 30, 0.05, 100000) * GIB), // finished files one link may add up to, over all its parts
  totalBytes: Math.round(num('TOTAL_STORAGE_GB', 20, 0.1, 100000) * GIB), // whole server
  fileTtlMs: num('FILE_TTL_MINUTES', 15, 1, 1440) * 60_000,
  maxSourceBytes: num('MAX_SOURCE_MB', 500, 1, 100000) * MIB,
  maxUploadBytes: num('MAX_UPLOAD_MB', 678, 1, 10000) * MIB, // largest file the inspector takes
  // A file is sent in pieces of this size, so that it also passes a proxy that caps one request (Cloudflare: 100 MB).
  uploadChunkBytes: num('UPLOAD_CHUNK_MB', 8, 1, 90) * MIB,
  maxCoverBytes: num('MAX_COVER_MB', 10, 1, 50) * MIB, // an image a visitor uploads as artwork

  // Work limits
  maxTracks: num('MAX_TRACKS', 100, 1, 1000),
  maxLinks: num('MAX_LINKS', 25, 1, 200), // links pasted together in one go
  maxTrackSeconds: num('MAX_TRACK_MINUTES', 90, 1, 720) * 60,
  maxConcurrent: num('MAX_CONCURRENT', 2, 1, 16),
  maxQueued: num('MAX_QUEUED', 30, 1, 1000),
  maxJobsPerClient: num('MAX_JOBS_PER_CLIENT', 3, 1, 100),
  timeouts: {
    lookup: 60_000,
    download: num('DOWNLOAD_TIMEOUT_SEC', 600, 10, 7200) * 1000,
    convert: num('CONVERT_TIMEOUT_SEC', 900, 10, 7200) * 1000,
    upload: num('UPLOAD_TIMEOUT_SEC', 120, 5, 3600) * 1000, // each piece of an inspector upload has to arrive within this
    uploadTotal: num('UPLOAD_TOTAL_MINUTES', 30, 1, 240) * 60_000, // and the whole file within this
  },

  // Requests per minute, per IP address
  rate: {
    global: num('RATE_GLOBAL_PER_MIN', 300, 10, 100000),
    convert: num('RATE_CONVERT_PER_MIN', 5, 1, 1000),
    inspect: num('RATE_INSPECT_PER_MIN', 10, 1, 1000), // files offered to the inspector
    piece: num('RATE_UPLOAD_PIECES_PER_MIN', 240, 10, 10000), // pieces of those files
    search: num('RATE_SEARCH_PER_MIN', 10, 1, 1000),
    edit: num('RATE_EDIT_PER_MIN', 20, 1, 1000),
    login: 5,
  },

  // Extras
  search: (process.env.SEARCH || 'on').toLowerCase() !== 'off', // search by song name
  inspect: (process.env.INSPECT || 'on').toLowerCase() !== 'off', // the metadata inspector (file uploads)
  inspectTypes: fileKinds('INSPECT_TYPES'), // kinds of file it accepts, judged by their bytes
  // on = an inspected file may be kept to have its tags edited and be downloaded again; off = read and deleted, as before
  inspectEdit: (process.env.INSPECT_EDIT || 'on').toLowerCase() !== 'off',
  online: (process.env.ONLINE_COUNT || 'on').toLowerCase() !== 'off', // "people here now" number in the header
  preview: (process.env.PREVIEW || 'on').toLowerCase() !== 'off', // in-page player
  previewSeconds: num('PREVIEW_MINUTES', 10, 1, 60) * 60, // longest preview kept per track
  // SoundCloud only gives a 30-second clip of some songs; fetch the full song from YouTube instead
  soundcloudFallback: (process.env.SOUNDCLOUD_FALLBACK || 'on').toLowerCase() !== 'off',
  loudnessTarget: num('LOUDNESS_LUFS', -14, -30, -8), // level aimed for when "even out the loudness" is on

  // Metadata
  lookup: (process.env.METADATA_LOOKUP || 'on').toLowerCase() !== 'off',
  lyrics: (process.env.LYRICS || 'on').toLowerCase() !== 'off',
  catalogues: catalogueOrder(), // ids, in the order they are asked
  keys, // never logged, never sent to a page
  // The country whose stores are searched (iTunes, Tidal, Spotify).
  itunesCountry: /^[A-Za-z]{2}$/.test(process.env.ITUNES_COUNTRY || '') ? process.env.ITUNES_COUNTRY.toUpperCase() : 'US',
  userAgent: text('LOOKUP_USER_AGENT', 'mixdown/2.0 (self-hosted)', 120),

  // Shown in the footer
  credits: {
    name: text('CREDIT_NAME', 'Labeeb Ashhab'),
    github: httpsUrl('CREDIT_GITHUB', 'https://github.com/LabeebAshhab'),
    website: httpsUrl('CREDIT_WEBSITE', 'https://me.astroit.org'),
  },
};
