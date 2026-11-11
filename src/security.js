// HTTP-side protections: headers, rate limiting, anonymous sessions, optional
// password, same-origin checks, safe download names, path containment and
// error messages that never leak internals.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { ProcError } from './proc.js';

// ------------------------------------------------------------ headers

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Permitted-Cross-Domain-Policies': 'none',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

export function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

// ------------------------------------------------------------ rate limiting (token bucket per IP)

export function rateLimit(perMinute, burst = perMinute) {
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, b] of buckets) if (b.at < cutoff) buckets.delete(key);
  }, 60_000).unref();

  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const b = buckets.get(key) || { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 60_000) * perMinute);
    b.at = now;
    if (buckets.size > 100_000) buckets.clear(); // memory guard under a flood of addresses
    buckets.set(key, b);
    if (b.tokens < 1) {
      res.set('Retry-After', String(Math.ceil(((1 - b.tokens) / perMinute) * 60)));
      return res.status(429).json({ error: 'That was a lot of requests. Give it a moment and try again.' });
    }
    b.tokens -= 1;
    next();
  };
}

// ------------------------------------------------------------ anonymous session

// Each browser gets a random, unguessable id in an HttpOnly cookie. It only
// decides which jobs that browser may see and download.
export function session(req, res, next) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  if (m) {
    req.sid = m[1];
  } else {
    req.sid = randomBytes(32).toString('hex');
    const secure = config.cookieSecure || req.secure ? '; Secure' : '';
    res.append('Set-Cookie', `sid=${req.sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`);
  }
  next();
}

// ------------------------------------------------------------ optional shared password

const unlocked = new Set();
const digest = (s) => createHash('sha256').update(String(s)).digest();

export const isLocked = () => config.accessPassword !== '';
export const isUnlocked = (req) => !isLocked() || unlocked.has(req.sid);

export function tryUnlock(req, password) {
  if (!isLocked()) return true;
  if (!timingSafeEqual(digest(password), digest(config.accessPassword))) return false;
  if (unlocked.size > 10_000) unlocked.clear();
  unlocked.add(req.sid);
  return true;
}

export function requireUnlocked(req, res, next) {
  if (isUnlocked(req)) return next();
  res.status(401).json({ error: 'This server needs a password.', locked: true });
}

// ------------------------------------------------------------ same-origin check for writes

export function sameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'Cross-site request refused.' });
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* invalid origin */
    }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request refused.' });
  }
  next();
}

// ------------------------------------------------------------ files and names

/** Throws unless `target` is inside `base`. Returns the resolved path. */
export function insideDir(base, target) {
  const root = path.resolve(base);
  const full = path.resolve(root, target);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('path escapes base directory');
  return full;
}

/** Remove control characters and trim. Newlines survive only when asked. */
export function cleanText(value, max = 300, keepNewlines = false) {
  let s = String(value ?? '').normalize('NFC');
  // eslint-disable-next-line no-control-regex
  s = keepNewlines ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return s.trim().slice(0, max);
}

/**
 * Content-Disposition for a download. The on-disk name is always a UUID; this
 * is only the name suggested to the browser. Path characters, control
 * characters and quotes are removed; the plain-ASCII fallback keeps only a
 * small safe set, and the real (Unicode) name travels percent-encoded.
 */
export function contentDisposition(name) {
  const clean =
    String(name)
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
      .replace(/\.{2,}/g, '.')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 180) || 'audio';
  const ascii =
    clean
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9 ._()&,+-]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'audio';
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ------------------------------------------------------------ errors

/** Thrown on purpose with a message that is safe to show to a visitor. */
export class PublicError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.public = true;
  }
}

/** Turn any failure into a short sentence with no paths, commands or tool output. */
export function publicMessage(e) {
  if (e?.public) return e.message;
  if (e instanceof ProcError) {
    const d = e.detail || '';
    if (e.kind === 'timeout') return 'That took too long, so it was stopped.';
    if (e.kind === 'aborted') return 'Cancelled.';
    if (e.kind === 'not-installed') return 'The server is missing a required tool.';
    if (/private video|sign in|login required|members-only/i.test(d)) return 'This video is private or needs a sign-in.';
    if (/age[- ]restricted|confirm your age/i.test(d)) return 'This video is age-restricted.';
    if (/unavailable|removed|does not exist|not available|terminated/i.test(d)) return 'This video is not available.';
    if (/copyright|blocked/i.test(d)) return 'This video is blocked.';
    return 'That one could not be processed.';
  }
  return 'Something went wrong on our side.';
}
