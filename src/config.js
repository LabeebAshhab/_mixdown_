// All settings in one place. Every value comes from an environment variable
// (see .env.example) and is range-checked before use.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function text(name, def, max = 80) {
  const v = process.env[name];
  // eslint-disable-next-line no-control-regex
  return v === undefined ? def : v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

export const config = {
  root,
  port: num('PORT', 8080, 1, 65535),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(root, 'data')),
  ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ytdlpExtra: (process.env.YTDLP_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),

  // Network / proxy
  trustProxy: process.env.TRUST_PROXY || '',
  cookieSecure: process.env.COOKIE_SECURE === '1',
  accessPassword: process.env.ACCESS_PASSWORD || '',

  // Storage limits
  quotaBytes: Math.round(num('QUOTA_GB', 3, 0.05, 1000) * GIB), // per visitor, waiting to be downloaded
  totalBytes: Math.round(num('TOTAL_STORAGE_GB', 20, 0.1, 100000) * GIB), // whole server
  fileTtlMs: num('FILE_TTL_MINUTES', 15, 1, 1440) * 60_000,
  maxSourceBytes: num('MAX_SOURCE_MB', 500, 1, 100000) * MIB,
  maxUploadBytes: num('MAX_UPLOAD_MB', 100, 1, 10000) * MIB,

  // Work limits
  maxTracks: num('MAX_TRACKS', 100, 1, 1000),
  maxTrackSeconds: num('MAX_TRACK_MINUTES', 90, 1, 720) * 60,
  maxConcurrent: num('MAX_CONCURRENT', 2, 1, 16),
  maxQueued: num('MAX_QUEUED', 30, 1, 1000),
  maxJobsPerClient: num('MAX_JOBS_PER_CLIENT', 3, 1, 100),
  timeouts: {
    lookup: 60_000,
    download: num('DOWNLOAD_TIMEOUT_SEC', 600, 10, 7200) * 1000,
    convert: num('CONVERT_TIMEOUT_SEC', 900, 10, 7200) * 1000,
  },

  // Requests per minute, per IP address
  rate: {
    global: num('RATE_GLOBAL_PER_MIN', 300, 10, 100000),
    convert: num('RATE_CONVERT_PER_MIN', 5, 1, 1000),
    inspect: num('RATE_INSPECT_PER_MIN', 10, 1, 1000),
    login: 5,
  },

  // Metadata
  lookup: (process.env.METADATA_LOOKUP || 'on').toLowerCase() !== 'off',
  lyrics: (process.env.LYRICS || 'on').toLowerCase() !== 'off',
  itunesCountry: /^[A-Za-z]{2}$/.test(process.env.ITUNES_COUNTRY || '') ? process.env.ITUNES_COUNTRY.toUpperCase() : 'US',
  userAgent: text('LOOKUP_USER_AGENT', 'mixdown/2.0 (self-hosted)', 120),

  // Shown in the footer
  credits: {
    name: text('CREDIT_NAME', 'Labeeb Ashhab'),
    github: httpsUrl('CREDIT_GITHUB', 'https://github.com/LabeebAshhab'),
    website: httpsUrl('CREDIT_WEBSITE', 'https://me.astroit.org'),
  },
};
