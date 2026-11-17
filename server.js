import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './src/config.js';
import { initInspector } from './src/inspect.js';
import { initStorage, shutdown } from './src/jobs.js';
import { onlineWindowSeconds } from './src/presence.js';
import { run } from './src/proc.js';
import { apiRouter } from './src/routes.js';
import { noStore, rateLimit, sameOrigin, securityHeaders, session } from './src/security.js';

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
// Plain "a=b" query strings only: no nested objects built from what a visitor types in an address.
app.set('query parser', 'simple');
if (config.trustProxy) {
  // Behind a reverse proxy, this makes req.ip the visitor's address.
  app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
}

// Are the external tools present? Checked once at start, shown in the interface.
let toolsReady = false;
async function checkTools() {
  const version = (cmd, arg) => run(cmd, [arg], { timeout: 15_000 }).then((o) => o.split('\n')[0].trim(), () => null);
  const [ytdlp, ffmpeg] = await Promise.all([version(config.ytdlp, '--version'), version(config.ffmpeg, '-version')]);
  toolsReady = !!(ytdlp && ffmpeg);
  console.log(`yt-dlp: ${ytdlp || 'MISSING'} | ffmpeg: ${ffmpeg ? ffmpeg.split(' ').slice(0, 3).join(' ') : 'MISSING'}`);
}

app.use(securityHeaders);
app.use(rateLimit(config.rate.global));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// The page is one static file. Its link-preview tags need the site's full
// address, so %ORIGIN% in it is replaced once, at start, with PUBLIC_URL (an
// https origin checked in config.js, or nothing). No request data is involved.
const page = (await fs.readFile(path.join(config.root, 'public', 'index.html'), 'utf8')).replaceAll('%ORIGIN%', config.publicUrl);
app.get(['/', '/index.html'], (_req, res) => res.set('Cache-Control', 'public, max-age=300').type('html').send(page));
// Privacy and the usage policy are one static page, "Privacy & Policy". The
// words between percent signs in it are replaced once, at start, with this
// server's own settings, so it states the real numbers. Every value is escaped;
// no request data is involved, and the page calls no API, so reading it sets
// no cookie. The policy's old address leads to its part of the page.
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const facts = {
  ORIGIN: config.publicUrl,
  TTL_MINUTES: Math.round(config.fileTtlMs / 60_000),
  QUOTA_GB: Math.round((config.quotaBytes / 1024 ** 3) * 10) / 10,
  IP_QUOTA_GB: Math.round((config.ipQuotaBytes / 1024 ** 3) * 10) / 10,
  MAX_PLAYLIST_GB: Math.round((config.maxJobBytes / 1024 ** 3) * 10) / 10,
  PREVIEW_MINUTES: Math.round(config.previewSeconds / 60),
  MAX_TRACKS: config.maxTracks,
  MAX_LINKS: config.maxLinks,
  MAX_TRACK_MINUTES: Math.round(config.maxTrackSeconds / 60),
  MAX_JOBS: config.maxJobsPerClient,
  MAX_UPLOAD_MB: Math.round(config.maxUploadBytes / 1024 ** 2),
  MAX_COVER_MB: Math.round(config.maxCoverBytes / 1024 ** 2),
  RATE_CONVERT: config.rate.convert,
  RATE_SEARCH: config.rate.search,
  ONLINE_SECONDS: onlineWindowSeconds,
  CREDIT_NAME: config.credits.name,
  CREDIT_GITHUB: config.credits.github,
  CREDIT_WEBSITE: config.credits.website,
};
const legal = (await fs.readFile(path.join(config.root, 'public', 'privacy.html'), 'utf8')).replace(/%([A-Z_]+)%/g, (all, key) =>
  key in facts ? escapeHtml(facts[key]) : all,
);
app.get(['/privacy', '/privacy.html'], (_req, res) => res.set('Cache-Control', 'public, max-age=300').type('html').send(legal));
app.get(['/policy', '/policy.html'], (_req, res) => res.redirect(302, '/privacy#policy'));
// The service worker is checked for updates on every visit.
app.get('/sw.js', (_req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(path.join(config.root, 'public'), { dotfiles: 'ignore', index: 'index.html', maxAge: '5m' }));
app.use('/api', noStore, session, sameOrigin, apiRouter({ ready: () => toolsReady }));
app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

// Errors: visitors get a short sentence; details stay in the server log.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (res.headersSent) return res.destroy();
  if (err?.public) return res.status(err.status || 400).json(err.why ? { error: err.message, why: err.why } : { error: err.message });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That request was too large.' });
  if (err?.type?.startsWith?.('entity.') || err instanceof SyntaxError) return res.status(400).json({ error: 'That request could not be read.' });
  console.error(`[http] ${req.method} ${req.path}:`, err);
  res.status(500).json({ error: 'Something went wrong on our side.' });
});

await initStorage();
await checkTools();
console.log(`inspector: ${await initInspector()}`);

const server = app.listen(config.port, () => {
  console.log(`mixdown listening on http://localhost:${config.port}`);
  console.log(
    `storage: ${config.dataDir} | limit ${(config.quotaBytes / 1024 ** 3).toFixed(1)} GB per browser, ${(config.ipQuotaBytes / 1024 ** 3).toFixed(1)} GB per address | files kept ${config.fileTtlMs / 60_000} min`,
  );
  // Without the Secure flag the session cookie, which decides whose files are whose, could travel over plain http.
  if (config.publicUrl && !config.cookieSecure) console.warn('PUBLIC_URL is an https address but COOKIE_SECURE is not 1: set it so the session cookie is only ever sent over https.');
  if (config.accessPassword) console.log('access password: enabled');
});
server.headersTimeout = 20_000;
server.requestTimeout = 10 * 60_000; // long enough for an inspector upload
server.keepAliveTimeout = 30_000;

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    await shutdown();
    process.exit(0);
  });
}
