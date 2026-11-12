// Which links are accepted, and what is kept of them.
//
// Only the sites listed here are allowed. A pasted link is never passed on as
// typed: it is reduced to the few parts that identify the song (a video id, or
// an account and a slug), each part is checked against a strict pattern, and
// the address is rebuilt from those parts. Query strings, fragments, ports and
// credentials are dropped. yt-dlp is also told to use only the extractors of
// these sites (EXTRACTORS), so its generic "fetch any page" extractor can
// never run.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{12,80}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const SOUNDCLOUD_TRACK_ID = /^\d{1,20}$/;

// soundcloud.com/<name> is an account unless <name> is one of the site's own pages.
const SOUNDCLOUD_PAGES = new Set([
  'discover', 'search', 'stream', 'upload', 'you', 'pages', 'charts', 'feed', 'settings', 'messages', 'notifications',
  'people', 'tags', 'terms-of-use', 'imprint', 'jobs', 'popular', 'mobile', 'pro', 'go', 'signin', 'login', 'logout',
  'connect', 'oauth', 'player', 'stations', 'for', 'press', 'creators', 'community-guidelines',
]);

export const SITES = {
  youtube: { label: 'YouTube', artwork: 'YouTube thumbnail' },
  soundcloud: { label: 'SoundCloud', artwork: 'SoundCloud artwork' },
};

/** The only yt-dlp extractors that may run (matched against extractor names). */
export const EXTRACTORS = 'youtube.*,soundcloud.*';

const one = (site, kind, id, url) => ({ site, kind, id, url });

function youtube(u, host) {
  const video = (id) => (VIDEO_ID.test(id || '') ? one('youtube', 'video', id, `https://www.youtube.com/watch?v=${id}`) : null);
  const list = (id) => (LIST_ID.test(id || '') ? one('youtube', 'playlist', id, `https://www.youtube.com/playlist?list=${id}`) : null);
  if (host === 'youtu.be') return video(u.pathname.split('/')[1]);
  if (u.pathname === '/watch') return video(u.searchParams.get('v'));
  if (u.pathname === '/playlist') return list(u.searchParams.get('list'));
  const m = /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/.exec(u.pathname);
  return m ? video(m[1]) : null;
}

function soundcloud(u) {
  const parts = u.pathname.split('/').filter(Boolean);
  const [user, a, b] = parts;
  if (!SLUG.test(user || '') || SOUNDCLOUD_PAGES.has(user.toLowerCase())) return null;
  if (parts.length === 2 && SLUG.test(a) && a !== 'sets') {
    return one('soundcloud', 'video', `${user}/${a}`, `https://soundcloud.com/${user}/${a}`);
  }
  if (parts.length === 3 && a === 'sets' && SLUG.test(b)) {
    return one('soundcloud', 'playlist', `${user}/sets/${b}`, `https://soundcloud.com/${user}/sets/${b}`);
  }
  return null;
}

/**
 * @param {string} input what the visitor pasted
 * @returns {{site: string, kind: 'video'|'playlist', id: string, url: string} | null}
 */
export function parseSource(input) {
  // A real link is short and made of printable ASCII only. Spaces, control
  // characters, backslashes and look-alike letters from other alphabets are
  // refused here, before the address is even taken apart.
  const text = String(input ?? '').trim();
  if (text.length < 10 || text.length > 300 || /[^\x21-\x7e]/.test(text) || text.includes('\\')) return null;
  // No "." or ".." steps in the path, written plainly or percent-encoded.
  if (/\/(?:\.|%2e){1,2}(?:[/?#]|$)/i.test(text)) return null;
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');

  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') return youtube(u, host);
  if (host === 'soundcloud.com') return soundcloud(u);
  return null;
}

/**
 * One entry of a playlist as yt-dlp lists it, checked the same way as a pasted
 * link. Anything that is not a single song on the playlist's own site is dropped.
 */
export function parseEntry(site, entry) {
  if (!entry) return null;
  if (site === 'youtube') {
    return VIDEO_ID.test(entry.id || '') ? one('youtube', 'video', entry.id, `https://www.youtube.com/watch?v=${entry.id}`) : null;
  }
  const url = String(entry.url || entry.webpage_url || '');
  if (site === 'soundcloud') {
    // Songs deep in a long set are listed by number rather than by address,
    // either bare (tracks/123) or as a URN (tracks/soundcloud:tracks:123).
    const m = /^https:\/\/api(?:-v2)?\.soundcloud\.com\/tracks\/(?:soundcloud(?::|%3A)tracks(?::|%3A))?(\d+)(?:[/?#].*)?$/i.exec(url);
    if (m && SOUNDCLOUD_TRACK_ID.test(m[1])) return one('soundcloud', 'video', m[1], `https://api.soundcloud.com/tracks/${m[1]}`);
  }
  const parsed = parseSource(url);
  return parsed && parsed.site === site && parsed.kind === 'video' ? parsed : null;
}
