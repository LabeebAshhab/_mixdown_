// Outbound HTTP with SSRF protection. Every request the server makes on its
// own (catalogue lookups, artwork, lyrics) goes through safeFetch():
//   - https only, no credentials, default port only
//   - the host must be on a fixed allowlist
//   - DNS is resolved by our own lookup at connect time and the connection is
//     refused if any address is loopback, private, link-local or multicast,
//     which also defeats DNS rebinding
//   - redirects are followed by hand, at most three, each one re-validated
//   - time and response size are capped
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch } from 'undici';
import { config } from './config.js';

const ALLOWED_HOSTS = [
  'itunes.apple.com',
  'mzstatic.com', // iTunes artwork
  'api.deezer.com',
  'dzcdn.net', // Deezer artwork
  'musicbrainz.org',
  'coverartarchive.org',
  'archive.org', // Cover Art Archive storage
  'lrclib.net',
];

export function hostAllowed(hostname) {
  const h = String(hostname).toLowerCase();
  if (net.isIP(h)) return false;
  return ALLOWED_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local (cloud metadata lives here)
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && c === 100) return false; // documentation
    if (a === 203 && b === 0 && c === 113) return false; // documentation
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return false;
    if (s.startsWith('::ffff:')) {
      const v4 = s.slice(7);
      return net.isIPv4(v4) ? isPublicAddress(v4) : false; // IPv4-mapped
    }
    if (/^f[cd]/.test(s)) return false; // unique local fc00::/7
    if (/^fe[89ab]/.test(s)) return false; // link-local fe80::/10
    if (s.startsWith('ff')) return false; // multicast
    if (s.startsWith('64:ff9b:') || s.startsWith('2001:db8:') || s.startsWith('2002:')) return false; // NAT64, docs, 6to4
    return true;
  }
  return false;
}

function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(Object.assign(new Error('address not allowed'), { code: 'EBLOCKED' }));
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

const agent = new Agent({
  connect: { lookup: guardedLookup, timeout: 10_000 },
  headersTimeout: 15_000,
  bodyTimeout: 30_000,
});

function assertSafeUrl(u) {
  if (u.protocol !== 'https:') throw new Error('only https is allowed');
  if (u.username || u.password) throw new Error('credentials in URL');
  if (u.port && u.port !== '443') throw new Error('port not allowed');
  if (!hostAllowed(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`);
}

/**
 * @param {string} url
 * @param {{timeout?: number, maxBytes?: number, accept?: string}} [opts]
 * @returns {Promise<{ok: boolean, status: number, type: string, body: Buffer}>}
 */
export async function safeFetch(url, { timeout = 10_000, maxBytes = 5 * 1024 * 1024, accept = '*/*' } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop <= 3; hop++) {
    assertSafeUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(current, {
        dispatcher: agent,
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: accept, 'User-Agent': config.userAgent },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) throw new Error('redirect without location');
        current = new URL(location, current);
        continue;
      }
      const chunks = [];
      let size = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > maxBytes) {
            controller.abort();
            throw new Error('response too large');
          }
          chunks.push(chunk);
        }
      }
      return { ok: res.ok, status: res.status, type: res.headers.get('content-type') || '', body: Buffer.concat(chunks) };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too many redirects');
}

export async function safeJson(url, opts = {}) {
  const res = await safeFetch(url, { accept: 'application/json', ...opts });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return JSON.parse(res.body.toString('utf8'));
}
