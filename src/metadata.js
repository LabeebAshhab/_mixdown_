// Metadata extractor.
//
// YouTube only gives us a video title, a channel name and a thumbnail. This
// module turns that into real release metadata:
//   1. build hypotheses of (artist, title) from the YouTube data
//   2. search the catalogues one after another, iTunes first, until one of
//      them has a good match (which ones, and in what order: src/config.js)
//   3. score every candidate on title, artist and duration, reject weak ones
//   4. ask the next catalogues for whatever the winner left empty
//   5. return the tags and album artwork, or a careful fallback
// All requests go through safeFetch (see net.js).
import { config } from './config.js';
import { safeJson } from './net.js';
import { cleanText } from './security.js';

const MIN_SCORE = 0.7;

// ------------------------------------------------------------ text helpers

const NOISE_WORDS =
  'official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|explicit|clean|mv|m/v|remaster(?:ed)?|full song|out now';
const NOISE = new RegExp(`\\s*[(\\[【][^)\\]】]*\\b(?:${NOISE_WORDS})\\b[^)\\]】]*[)\\]】]`, 'gi');
const VERSION = /\b(live|remix|acoustic|demo|instrumental|karaoke|sped up|slowed|nightcore|8d)\b/gi;
const KNOCKOFF = /\b(karaoke|tribute|made famous|originally performed|in the style of|cover version|lullaby)\b/i;
const FEAT = /\s*[([]?\b(?:feat|ft|featuring)\b\.?\s+([^)\]]+)[)\]]?\s*$/i;

export function cleanTitle(title) {
  return String(title || '')
    .replace(NOISE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[([](?:feat|ft|featuring|with)\b[^)\]]*[)\]]/g, ' ')
    .replace(/\b(?:feat|ft|featuring)\b\.?\s.+$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Like norm() but keeps featured artist names, which are strong search terms. */
export function searchNorm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(?:feat|ft|featuring)\b\.?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Token overlap (Dice) between two strings after normalisation, 0..1. */
function sim(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = new Set(x.split(' '));
  const B = new Set(y.split(' '));
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return (2 * common) / (A.size + B.size);
}

export function versions(s) {
  return new Set((String(s || '').match(VERSION) || []).map((v) => v.toLowerCase()));
}

/** "Artist (feat. X)" + "Title" -> "Artist" + "Title (feat. X)". */
function moveFeat(pick) {
  const m = String(pick.artist || '').match(FEAT);
  if (!m) return pick;
  return {
    ...pick,
    artist: pick.artist.replace(FEAT, '').trim(),
    title: FEAT.test(pick.title) ? pick.title : `${pick.title} (feat. ${m[1].trim()})`,
  };
}

// ------------------------------------------------------------ hypotheses

function channelName(info) {
  return String(info.channel || info.uploader || '')
    .replace(/ - Topic$/, '')
    .replace(/\s*VEVO$/i, '')
    .trim();
}

/** Possible (artist, title) readings of a YouTube video, most trusted first. */
function hypotheses(info) {
  const out = [];
  if (info.track && info.artist) {
    const artist = Array.isArray(info.artists) && info.artists.length ? info.artists[0] : String(info.artist).split(',')[0];
    out.push({ artist: String(artist).trim(), title: String(info.track), trusted: true });
  }
  const clean = cleanTitle(info.title);
  const parts = clean.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    // "A - B" can be "Artist - Title" or "Title - Artist". Keep both readings.
    const a = parts[0];
    const b = parts.slice(1).join(' - ');
    out.push({ artist: a, title: b, split: true }, { artist: b, title: a, split: true });
  }
  const channel = channelName(info);
  if (channel) out.push({ artist: channel, title: clean });
  return out;
}

function searchTerms(hyps) {
  const seen = new Set();
  const terms = [];
  const add = (term) => {
    const key = [...new Set(term.split(' '))].sort().join(' ');
    if (!term || seen.has(key)) return;
    seen.add(key);
    terms.push(term.slice(0, 200));
  };
  // Most specific first: with featured artists, then without.
  for (const h of hyps) add(`${searchNorm(h.artist)} ${searchNorm(h.title)}`.trim());
  for (const h of hyps) add(`${norm(h.artist)} ${norm(h.title)}`.trim());
  return terms.slice(0, 3);
}

/** Best guess when no catalogue match exists. */
function fallbackTags(info, hyps) {
  let pick = hyps.find((h) => h.trusted);
  if (!pick) {
    const split = hyps.filter((h) => h.split);
    if (split.length) {
      // Whichever side looks like the channel name is the artist.
      const channel = channelName(info);
      pick = sim(channel, split[1].artist) > sim(channel, split[0].artist) ? split[1] : split[0];
    }
  }
  if (!pick) pick = { artist: channelName(info), title: cleanTitle(info.title) || 'Unknown' };
  pick = moveFeat(pick);

  let date = '';
  const rd = String(info.release_date || '');
  if (/^\d{8}$/.test(rd)) date = `${rd.slice(0, 4)}-${rd.slice(4, 6)}-${rd.slice(6)}`;
  else if (info.release_year) date = String(info.release_year);
  else if (info.upload_date) date = String(info.upload_date).slice(0, 4);

  return { title: pick.title, artist: pick.artist, album: info.album || '', albumArtist: info.album_artist || '', date, genre: info.genre || '' };
}

// ------------------------------------------------------------ catalogues
//
// Every catalogue answers a search with the same plain shape (a "candidate"),
// so the scoring further down does not care where one came from:
//   { source, title, artist, album, albumArtist, date, track, trackTotal,
//     disc, discTotal, genre, duration (seconds), isSingle, live, cover (address) }
// iTunes, Deezer and MusicBrainz are open. Tidal, Spotify, Discogs and Last.fm
// answer only with a key of this server's own (see .env.example) and are left
// out until it is set. A key goes into a request header, or for Last.fm into
// the address; it is never logged and never sent to a visitor's browser.

const enc = encodeURIComponent;
const market = () => config.itunesCountry;

/** Title and artist kept apart, for the catalogues that search them separately. */
function pairQueries(hyps) {
  const seen = new Set();
  const out = [];
  for (const h of hyps) {
    const title = cleanText(cleanTitle(h.title), 150);
    const artist = cleanText(h.artist, 150);
    const key = `${norm(artist)}|${norm(title)}`;
    if (!norm(title) || !norm(artist) || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, artist });
  }
  return out.slice(0, 2);
}

async function searchItunes(term) {
  const data = await safeJson(
    `https://itunes.apple.com/search?media=music&entity=song&limit=50&country=${market()}&term=${enc(term)}`,
  );
  return (data.results || []).map((r) => ({
    source: 'iTunes',
    title: r.trackName,
    artist: r.artistName,
    album: String(r.collectionName || '').replace(/ - (Single|EP)$/, ''),
    isSingle: / - Single$/.test(r.collectionName || ''),
    albumArtist: r.collectionArtistName || r.artistName,
    date: String(r.releaseDate || '').slice(0, 10),
    track: r.trackNumber,
    trackTotal: r.trackCount,
    disc: r.discNumber,
    discTotal: r.discCount,
    genre: r.primaryGenreName,
    duration: r.trackTimeMillis ? r.trackTimeMillis / 1000 : null,
    cover: typeof r.artworkUrl100 === 'string' ? r.artworkUrl100.replace(/\/\d+x\d+bb\.(?:jpg|png)$/, '/1200x1200bb.jpg') : null,
  }));
}

async function searchDeezer(term) {
  const data = await safeJson(`https://api.deezer.com/search?limit=25&q=${enc(term)}`);
  return (data.data || []).map((r) => ({
    source: 'Deezer',
    id: r.id,
    title: r.title,
    artist: r.artist?.name,
    album: r.album?.title,
    albumArtist: r.artist?.name,
    duration: r.duration,
    cover: r.album?.cover_xl || null,
  }));
}

async function enrichDeezer(c) {
  if (!Number.isInteger(c.id)) return c;
  const t = await safeJson(`https://api.deezer.com/track/${c.id}`);
  return { ...c, track: t.track_position, disc: t.disk_number, date: t.release_date || '' };
}

// ---- catalogues that need a key

// Tidal and Spotify hand out a short-lived token in exchange for the server's
// key. It is kept in memory until shortly before it runs out.
const tokens = new Map(); // catalogue id -> { value, until }

async function clientToken(id, url) {
  const hit = tokens.get(id);
  if (hit && Date.now() < hit.until) return hit.value;
  const key = config.keys[id];
  const data = await safeJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${key.id}:${key.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  }).catch((e) => {
    // The key itself was refused: asking again will not help, so the catalogue is rested.
    if ([400, 401, 403].includes(e?.status)) throw Object.assign(new Error('key refused'), { status: 401, final: true });
    throw e;
  });
  const value = String(data.access_token || '');
  if (!/^[A-Za-z0-9_.~+/=-]{10,4000}$/.test(value)) throw new Error('no token');
  const seconds = Math.max(120, Math.min(Number(data.expires_in) || 3600, 86_400));
  tokens.set(id, { value, until: Date.now() + (seconds - 60) * 1000 });
  return value;
}

/** A request signed with a catalogue's token. A token it no longer accepts is thrown away. */
async function withToken(id, tokenUrl, url, accept = 'application/json') {
  const token = await clientToken(id, tokenUrl);
  try {
    return await safeJson(url, { accept, headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    if (e?.status === 401) tokens.delete(id);
    throw e;
  }
}

// Tidal: a search gives track ids; the tracks, their albums and artists come
// with a second request. The track number and the artwork are fetched only
// for the song that wins (enrichTidal).
const TIDAL = 'https://openapi.tidal.com/v2';
const TIDAL_ID = /^\d{1,20}$/;
const tidalGet = (path) => withToken('tidal', 'https://auth.tidal.com/v1/oauth2/token', `${TIDAL}${path}`, 'application/vnd.api+json');

/** "PT3M21S" -> 201 */
function isoSeconds(v) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(v || ''));
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) || null : null;
}

async function searchTidal(term) {
  const cc = `countryCode=${market()}`;
  const found = await tidalGet(`/searchResults/${enc(term)}/relationships/tracks?${cc}&include=tracks`);
  const ids = (Array.isArray(found.data) ? found.data : [])
    .map((r) => String(r?.id ?? ''))
    .filter((id) => TIDAL_ID.test(id))
    .slice(0, 12);
  if (!ids.length) return [];
  const doc = await tidalGet(`/tracks?${cc}&${ids.map((id) => `filter%5Bid%5D=${id}`).join('&')}&include=albums&include=artists`);
  const byKey = new Map((Array.isArray(doc.included) ? doc.included : []).map((r) => [`${r?.type}/${r?.id}`, r?.attributes || {}]));
  const related = (t, kind) =>
    (Array.isArray(t.relationships?.[kind]?.data) ? t.relationships[kind].data : []).map((x) => ({ ...byKey.get(`${kind}/${x?.id}`), id: String(x?.id ?? '') }));
  return (Array.isArray(doc.data) ? doc.data : []).map((t) => {
    const a = t.attributes || {};
    const artist = related(t, 'artists').map((x) => x.name).find(Boolean);
    const album = related(t, 'albums')[0] || {};
    const version = String(a.version || '');
    return {
      source: 'Tidal',
      id: String(t.id ?? ''),
      albumId: TIDAL_ID.test(album.id || '') ? album.id : null,
      title: version && !String(a.title).toLowerCase().includes(version.toLowerCase()) ? `${a.title} (${version})` : a.title,
      artist,
      album: album.title,
      isSingle: (album.albumType || album.type) === 'SINGLE',
      albumArtist: artist,
      date: String(album.releaseDate || ''),
      trackTotal: album.numberOfItems,
      discTotal: album.numberOfVolumes,
      genre: '',
      duration: isoSeconds(a.duration),
      cover: null,
    };
  });
}

async function enrichTidal(c) {
  if (!c.albumId || !TIDAL_ID.test(c.id)) return c;
  const cc = `countryCode=${market()}`;
  const out = { ...c };
  const album = await tidalGet(`/albums/${c.albumId}?${cc}&include=coverArt&include=genres`).catch(() => null);
  const included = Array.isArray(album?.included) ? album.included : [];
  const files = included
    .filter((r) => r?.type === 'artworks')
    .flatMap((r) => (Array.isArray(r.attributes?.files) ? r.attributes.files : []))
    .filter((f) => typeof f?.href === 'string')
    .sort((a, b) => (b.meta?.width || 0) - (a.meta?.width || 0));
  // The largest picture that is not needlessly big; failing that, the smallest of the big ones.
  const picture = files.find((f) => (f.meta?.width || 0) <= 1600) || files.at(-1);
  if (picture) out.cover = picture.href;
  const genre = included.find((r) => r?.type === 'genres')?.attributes?.genreName;
  if (genre) out.genre = String(genre);

  // Where the song sits on its album: walk the album's list until it turns up.
  let path = `/albums/${c.albumId}/relationships/items?${cc}`;
  for (let page = 0; page < 4 && path; page++) {
    const doc = await tidalGet(path).catch(() => null);
    const me = (Array.isArray(doc?.data) ? doc.data : []).find((r) => String(r?.id) === c.id);
    if (me) {
      out.track = me.meta?.trackNumber;
      out.disc = me.meta?.volumeNumber;
      break;
    }
    // Only ever a path on the same service, never an address taken from the answer.
    const next = String(doc?.links?.next || '');
    path = /^\/[^/]/.test(next) ? next.replace(/^\/v2(?=\/)/, '') : null;
  }
  return out;
}

async function searchSpotify(term) {
  const data = await withToken(
    'spotify',
    'https://accounts.spotify.com/api/token',
    `https://api.spotify.com/v1/search?type=track&limit=10&market=${market()}&q=${enc(term)}`,
  );
  return (Array.isArray(data.tracks?.items) ? data.tracks.items : []).filter(Boolean).map((r) => {
    const album = r.album || {};
    const images = (Array.isArray(album.images) ? album.images : [])
      .filter((i) => typeof i?.url === 'string')
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    const artist = r.artists?.[0]?.name;
    return {
      source: 'Spotify',
      title: r.name,
      artist,
      album: album.name,
      isSingle: album.album_type === 'single' && !(album.total_tracks > 3),
      albumArtist: album.artists?.[0]?.name || artist,
      date: String(album.release_date || ''),
      track: r.track_number,
      trackTotal: album.total_tracks,
      disc: r.disc_number,
      genre: '',
      duration: r.duration_ms ? r.duration_ms / 1000 : null,
      cover: images[0]?.url || null,
    };
  });
}

// Discogs lists releases, not songs: a search gives the releases a song is
// on, and the two most promising are opened to read their track lists.
const discogsName = (list) => String((Array.isArray(list) ? list[0] : null)?.name || '').replace(/\s\(\d+\)$/, '');
const clock = (v) => {
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(String(v || '').trim());
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) || null : null;
};

async function searchDiscogs({ artist, title }) {
  const auth = { headers: { Authorization: `Discogs token=${config.keys.discogs.token}` } };
  const data = await safeJson(`https://api.discogs.com/database/search?type=release&per_page=10&artist=${enc(artist)}&track=${enc(title)}`, auth);
  const formats = (r) => (Array.isArray(r.format) ? r.format.join(' ') : '');
  const rank = (r) => (/\bAlbum\b/.test(formats(r)) ? 0 : 2) + (/Compilation|Unofficial|Promo/.test(formats(r)) ? 3 : 0) + (parseInt(r.year, 10) || 9999) / 100000;
  const picks = (Array.isArray(data.results) ? data.results : [])
    .filter((r) => Number.isInteger(r?.id) && r.id > 0)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 2);
  const out = [];
  for (const pick of picks) {
    const rel = await safeJson(`https://api.discogs.com/releases/${pick.id}`, auth).catch(() => null);
    if (!rel) continue;
    const albumArtist = discogsName(rel.artists);
    const kinds = (Array.isArray(rel.formats) ? rel.formats : []).flatMap((f) => (Array.isArray(f?.descriptions) ? f.descriptions : []));
    const picture = (Array.isArray(rel.images) ? rel.images : []).find((i) => typeof i?.uri === 'string');
    const tracks = (Array.isArray(rel.tracklist) ? rel.tracklist : []).filter((t) => t?.type_ === 'track');
    tracks.forEach((t, i) =>
      out.push({
        source: 'Discogs',
        title: t.title,
        artist: discogsName(t.artists) || albumArtist,
        album: rel.title,
        isSingle: kinds.includes('Single'),
        albumArtist,
        date: String(rel.released || rel.year || '').replace(/-00.*$/, ''),
        track: i + 1,
        trackTotal: tracks.length,
        genre: (Array.isArray(rel.styles) && rel.styles[0]) || (Array.isArray(rel.genres) && rel.genres[0]) || '',
        duration: clock(t.duration),
        cover: picture?.uri || null,
      }),
    );
  }
  return out;
}

// Last.fm knows one song at a time. Its tags are written by listeners, so the
// ones that say nothing about the music are skipped; its pictures are too
// small to embed and are not used.
const NOT_A_GENRE = /^(?:seen live|live|favou?rites?|favou?rite songs?|awesome|cool|love|loved|beautiful|my music|spotify|albums i own|under \d+ listeners|\d+s?|.{0,1}|.{31,})$/i;

async function searchLastfm({ artist, title }) {
  let data;
  try {
    data = await safeJson(
      `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&format=json&autocorrect=1&api_key=${config.keys.lastfm.key}&artist=${enc(artist)}&track=${enc(title)}`,
    );
  } catch (e) {
    if (e?.status === 404) return []; // it does not know the song
    throw e;
  }
  const t = data?.track;
  if (!t || typeof t !== 'object') return [];
  const tag = (Array.isArray(t.toptags?.tag) ? t.toptags.tag : []).map((x) => String(x?.name || '')).find((name) => !NOT_A_GENRE.test(name));
  return [
    {
      source: 'Last.fm',
      title: t.name,
      artist: t.artist?.name,
      album: t.album?.title || '',
      albumArtist: t.album?.artist || t.artist?.name,
      date: '',
      track: parseInt(t.album?.['@attr']?.position, 10) || null,
      genre: tag ? tag.replace(/(^|[\s-])\p{L}/gu, (ch) => ch.toUpperCase()) : '',
      duration: Number(t.duration) > 0 ? Number(t.duration) / 1000 : null,
      cover: null,
    },
  ];
}

// ---- MusicBrainz

// MusicBrainz is an open database, so it also covers songs the stores do not
// list. It allows one request per second: calls are spaced through this gate.
let mbGate = Promise.resolve();
function mbSlot() {
  const slot = mbGate.then(() => new Promise((r) => setTimeout(r, 1100)));
  mbGate = slot.catch(() => {});
  return slot;
}

function mbQueries(hyps) {
  const seen = new Set();
  const out = [];
  for (const h of hyps) {
    const title = norm(h.title);
    const artist = norm(h.artist);
    if (!title || !artist || seen.has(`${artist}|${title}`)) continue;
    seen.add(`${artist}|${title}`);
    out.push(`recording:"${title.slice(0, 100)}" AND artist:"${artist.slice(0, 100)}"`);
  }
  return out.slice(0, 3);
}

/** Choose the release to tag from: official studio album first, earliest date wins ties. */
function pickRelease(releases) {
  let best = null;
  let bestRank = Infinity;
  for (const r of releases || []) {
    const rg = r['release-group'] || {};
    const secondary = rg['secondary-types'] || [];
    const number = r.media?.[0]?.track?.[0]?.number;
    let rank = r.status === 'Official' ? 0 : 4;
    rank += secondary.length ? 2 : 0;
    rank += rg['primary-type'] === 'Album' ? 0 : rg['primary-type'] === 'EP' ? 0.5 : 1;
    rank += /^\d+$/.test(String(number)) ? 0 : 0.4; // vinyl sides like "A4"
    rank += (parseInt(r.date, 10) || 9999) / 100000;
    if (rank < bestRank) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}

const credit = (list) => (list || []).map((a) => `${a.name}${a.joinphrase || ''}`).join('');

async function searchMusicBrainz(query) {
  await mbSlot();
  const data = await safeJson(`https://musicbrainz.org/ws/2/recording?fmt=json&limit=40&query=${enc(query)}`);
  const out = [];
  for (const r of data.recordings || []) {
    const rel = pickRelease(r.releases);
    if (!rel) continue;
    const rg = rel['release-group'] || {};
    const secondary = rg['secondary-types'] || [];
    const medium = rel.media?.[0] || {};
    const named = moveFeat({ artist: credit(r['artist-credit']), title: r.title });
    const number = String(medium.track?.[0]?.number ?? '');
    const rgid = /^[0-9a-f-]{36}$/.test(rg.id || '') ? rg.id : null;
    out.push({
      source: 'MusicBrainz',
      title: named.title,
      artist: named.artist,
      album: rel.title,
      isSingle: rg['primary-type'] === 'Single',
      albumArtist: credit(rel['artist-credit']) || named.artist,
      date: rel.date || '',
      track: /^\d+$/.test(number) ? Number(number) : null,
      trackTotal: medium['track-count'] || null,
      disc: medium.position || null,
      genre: '',
      duration: r.length ? r.length / 1000 : null,
      live: secondary.includes('Live'),
      rgid,
      // The Cover Art Archive has a picture for many albums, not for all:
      // whether this one exists is only known when it is fetched.
      cover: rgid ? `https://coverartarchive.org/release-group/${rgid}/front-1200` : null,
      coverUnsure: true,
    });
  }
  return out;
}

async function enrichMusicBrainz(c) {
  if (!c.rgid) return c;
  await mbSlot();
  const rg = await safeJson(`https://musicbrainz.org/ws/2/release-group/${c.rgid}?inc=genres&fmt=json`);
  const top = (rg.genres || []).sort((a, b) => b.count - a.count)[0];
  return top ? { ...c, genre: String(top.name).replace(/(^|\s)\p{L}/gu, (ch) => ch.toUpperCase()) } : c;
}

// ---- the list

// `gives`: what a catalogue can add to a song another one identified.
// `label`: its name as the Privacy & Policy page gives it.
const CATALOGUES = {
  itunes: { name: 'iTunes', label: 'Apple iTunes Search', search: searchItunes, queries: searchTerms, gives: ['album', 'date', 'track', 'genre', 'cover'] },
  deezer: { name: 'Deezer', label: 'Deezer', search: searchDeezer, queries: searchTerms, enrich: enrichDeezer, gives: ['album', 'date', 'track', 'cover'] },
  tidal: { name: 'Tidal', label: 'Tidal', search: searchTidal, queries: searchTerms, enrich: enrichTidal, gives: ['album', 'date', 'track', 'genre', 'cover'] },
  spotify: { name: 'Spotify', label: 'Spotify', search: searchSpotify, queries: searchTerms, gives: ['album', 'date', 'track', 'cover'] },
  musicbrainz: { name: 'MusicBrainz', label: 'MusicBrainz', search: searchMusicBrainz, queries: mbQueries, enrich: enrichMusicBrainz, gives: ['album', 'date', 'track', 'genre', 'cover'] },
  discogs: { name: 'Discogs', label: 'Discogs', search: searchDiscogs, queries: pairQueries, gives: ['album', 'date', 'track', 'genre', 'cover'] },
  lastfm: { name: 'Last.fm', label: 'Last.fm', search: searchLastfm, queries: pairQueries, gives: ['album', 'genre'] },
};

/** The catalogues this server asks, in order (iTunes first unless CATALOGUES says otherwise). */
const active = () => (config.lookup ? config.catalogues.map((id) => CATALOGUES[id]).filter(Boolean) : []);

/** Their names, for the Privacy & Policy page. */
export const catalogueLabels = () => active().map((c) => c.label);

// A catalogue that refuses the server (a wrong key, too many requests) is left
// alone for a while instead of being asked again for every song.
const resting = new Map(); // catalogue name -> when it may be asked again

function rest(catalogue, e) {
  const ms = e?.status === 401 ? 15 * 60_000 : e?.status === 403 || e?.status === 429 ? 3 * 60_000 : 0;
  if (ms) resting.set(catalogue.name, Date.now() + ms);
}
const isResting = (catalogue) => (resting.get(catalogue.name) || 0) > Date.now();

/** Fill in what the winning candidate's search result did not include. */
async function enrich(catalogue, c) {
  if (!catalogue.enrich) return c;
  try {
    return await catalogue.enrich(c);
  } catch {
    return c; // optional extras
  }
}

// ------------------------------------------------------------ scoring

function score(c, hyps, info) {
  let best = 0;
  for (const h of hyps) {
    const t = sim(h.title, c.title);
    const a = sim(h.artist, c.artist);
    if (t < 0.5 || a < 0.5) continue;
    best = Math.max(best, 0.5 * t + 0.35 * a);
  }
  if (!best) return 0;

  const diff = info.duration && c.duration ? Math.abs(info.duration - c.duration) : null;
  const dur = diff == null ? 0.5 : diff <= 3 ? 1 : diff <= 10 ? 0.8 : diff <= 30 ? 0.5 : diff <= 90 ? 0.2 : 0;
  let s = best + 0.15 * dur;

  // Live / remix / acoustic etc. must agree between the video and the candidate.
  const want = versions(`${info.title} ${info.track || ''}`);
  const got = versions(c.title);
  if (c.live) got.add('live');
  if (want.size !== got.size || [...want].some((v) => !got.has(v))) s -= 0.2;

  if (KNOCKOFF.test(`${c.title} ${c.album} ${c.artist}`) && !KNOCKOFF.test(info.title || '')) s -= 0.3;
  if (/various artists/i.test(c.albumArtist || '')) s -= 0.08;
  if (/\b(greatest hits|best of|essentials|collection|anthology)\b/i.test(c.album || '')) s -= 0.04;
  if (c.isSingle) s -= 0.02; // prefer the album release over the single
  return s;
}

/** One more try after a failure that may pass. A plain "no" from the catalogue is not asked twice. */
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.final || [400, 403, 404, 429].includes(e?.status)) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    return fn();
  }
}

const int = (v) => (Number.isInteger(v) && v > 0 && v < 1000 ? v : null);

// ------------------------------------------------------------ filling gaps
//
// The catalogue that identified the song does not always know everything
// about it: Deezer has no genre, MusicBrainz often no picture. What is missing
// is asked of the catalogues after it, at most two of them, one search each.

const sameKind = (a, b) => {
  const x = versions(a);
  const y = versions(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/** Is candidate `c` the song `song`, as far as names and length can tell? */
function sameSong(c, song) {
  if (sim(c.title, song.title) < 0.8 || sim(c.artist, song.artist) < 0.6) return false;
  if (!sameKind(c.title, song.title) || !!c.live !== !!song.live) return false;
  if (KNOCKOFF.test(`${c.title} ${c.album} ${c.artist}`) && !KNOCKOFF.test(`${song.title} ${song.album}`)) return false;
  return !(c.duration && song.duration) || Math.abs(c.duration - song.duration) <= 7;
}

const gaps = (song) =>
  ['album', 'date', 'track', 'genre'].filter((k) => !song[k]).concat(!song.cover || song.coverUnsure ? ['cover'] : []);

/**
 * @param {object} song the winning candidate; filled in place
 * @param {object} winner the catalogue it came from
 * @param {Map<string, object[]>} seen what the catalogues asked so far answered
 * @returns {Promise<{url: string, label: string}[]>} more artwork to try, should the winner's fail
 */
async function fillGaps(song, winner, seen) {
  const spare = [];
  let need = new Set(gaps(song));
  let asked = 0;
  for (const catalogue of active()) {
    if (!need.size || asked >= 2) break;
    if (catalogue === winner || !catalogue.gives.some((k) => need.has(k))) continue;
    let list = seen.get(catalogue.name);
    if (!list) {
      if (isResting(catalogue)) continue;
      // The plainest form of the search: the winner's own names, featured artists left out.
      const query = catalogue.queries([{ artist: song.artist, title: song.title, trusted: true }]).at(-1);
      if (!query) continue;
      asked++;
      try {
        list = await catalogue.search(query);
      } catch (e) {
        rest(catalogue, e);
        continue;
      }
    }
    let other = list.filter((c) => sameSong(c, song)).sort((a, b) => sim(b.album, song.album) - sim(a.album, song.album))[0];
    if (!other) continue;
    other = await enrich(catalogue, other);

    if (!song.genre && other.genre) song.genre = other.genre;
    // The rest belongs to one particular album, so it is taken only from the same one.
    const sameAlbum = song.album ? sim(other.album, song.album) >= 0.75 : !!other.album;
    if (sameAlbum) {
      if (!song.album) Object.assign(song, { album: other.album, albumArtist: song.albumArtist || other.albumArtist });
      if (!song.date && other.date) song.date = other.date;
      if (!song.track && other.track) Object.assign(song, { track: other.track, trackTotal: other.trackTotal, disc: other.disc, discTotal: other.discTotal });
      if (other.cover && typeof other.cover === 'string') {
        if (!song.cover) Object.assign(song, { cover: other.cover, coverFrom: other.source, coverUnsure: other.coverUnsure });
        else if (song.coverUnsure && !other.coverUnsure) spare.push({ url: other.cover, label: `${other.source} album art` });
      }
    }
    need = new Set(gaps(song).filter((k) => !(k === 'cover' && spare.length)));
  }
  return spare;
}

// ------------------------------------------------------------ entry point

/**
 * @param {object} info yt-dlp info json for one video
 * @returns {Promise<{source: string, confidence: number|null, tags: object, coverUrl: string|null,
 *   covers: {url: string, label: string}[], duration: number|null, lookupFailed: boolean}>}
 *   `covers` is the artwork to try, best first (`coverUrl` is the first of them);
 *   `duration` is the catalogue's length of the song in seconds, when it has one
 */
export async function resolveMetadata(info) {
  const hyps = hypotheses(info);
  const fb = fallbackTags(info, hyps);
  const fallback = {
    source: 'YouTube',
    confidence: null,
    coverUrl: null,
    covers: [],
    duration: null,
    lookupFailed: false,
    tags: {
      title: cleanText(fb.title) || 'Unknown',
      artist: cleanText(fb.artist),
      album: cleanText(fb.album),
      albumArtist: cleanText(fb.albumArtist),
      date: /^\d{4}(-\d{2}-\d{2})?$/.test(fb.date) ? fb.date : '',
      genre: cleanText(fb.genre, 60),
      track: null,
      trackTotal: null,
      disc: null,
      discTotal: null,
    },
  };

  const seen = new Map(); // catalogue name -> every candidate it answered with
  for (const catalogue of active()) {
    if (isResting(catalogue)) continue;
    let best = null;
    for (const query of catalogue.queries(hyps)) {
      let candidates;
      try {
        candidates = await withRetry(() => catalogue.search(query));
      } catch (e) {
        fallback.lookupFailed = true;
        rest(catalogue, e);
        // The reason only: an address could hold a key, a message could hold a song title.
        console.warn(`[metadata] ${catalogue.name} lookup failed: ${e?.status ? `HTTP ${e.status}` : e?.cause?.code || e?.name || 'error'}`);
        if (isResting(catalogue)) break;
        continue;
      }
      seen.set(catalogue.name, [...(seen.get(catalogue.name) || []), ...candidates]);
      for (const c of candidates) {
        const s = score(c, hyps, info);
        if (s >= MIN_SCORE && (!best || s > best.s)) best = { c, s };
      }
      if (best && best.s >= 0.9) break;
    }
    if (!best) continue;

    const c = { ...(await enrich(catalogue, best.c)) };
    const spare = await fillGaps(c, catalogue, seen).catch(() => []);
    const covers = [];
    if (typeof c.cover === 'string') covers.push({ url: c.cover, label: `${c.coverFrom || c.source} album art` });
    covers.push(...spare);
    return {
      source: c.source,
      confidence: Math.min(1, Math.round(best.s * 100) / 100),
      coverUrl: covers[0]?.url || null,
      covers,
      duration: Number(c.duration) > 0 ? Number(c.duration) : null,
      lookupFailed: false,
      tags: {
        title: cleanText(c.title) || fallback.tags.title,
        artist: cleanText(c.artist),
        album: cleanText(c.album),
        albumArtist: cleanText(c.albumArtist || c.artist),
        date: /^\d{4}(-\d{2}(-\d{2})?)?$/.test(c.date || '') ? c.date : '',
        genre: cleanText(c.genre, 60),
        track: int(c.track),
        trackTotal: int(c.trackTotal),
        disc: int(c.disc),
        discTotal: int(c.discTotal),
      },
    };
  }
  return fallback;
}
