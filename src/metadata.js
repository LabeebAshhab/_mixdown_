// Metadata extractor.
//
// YouTube only gives us a video title, a channel name and a thumbnail. This
// module turns that into real release metadata:
//   1. build hypotheses of (artist, title) from the YouTube data
//   2. search iTunes, then Deezer, then MusicBrainz for candidates
//   3. score every candidate on title, artist and duration, reject weak ones
//   4. return the catalogue's tags and album artwork, or a careful fallback
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

function norm(s) {
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
function searchNorm(s) {
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

function versions(s) {
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

// ------------------------------------------------------------ providers

async function searchItunes(term) {
  const data = await safeJson(
    `https://itunes.apple.com/search?media=music&entity=song&limit=50&country=${config.itunesCountry}&term=${encodeURIComponent(term)}`,
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
  const data = await safeJson(`https://api.deezer.com/search?limit=25&q=${encodeURIComponent(term)}`);
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
  const data = await safeJson(`https://musicbrainz.org/ws/2/recording?fmt=json&limit=40&query=${encodeURIComponent(query)}`);
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
      cover: rgid ? `https://coverartarchive.org/release-group/${rgid}/front-1200` : null,
    });
  }
  return out;
}

const PROVIDERS = [
  { name: 'iTunes', search: searchItunes, queries: searchTerms },
  { name: 'Deezer', search: searchDeezer, queries: searchTerms },
  { name: 'MusicBrainz', search: searchMusicBrainz, queries: mbQueries },
];

/** Fill in what the winning candidate's search result did not include. */
async function enrich(c) {
  try {
    if (c.source === 'MusicBrainz' && c.rgid) {
      await mbSlot();
      const rg = await safeJson(`https://musicbrainz.org/ws/2/release-group/${c.rgid}?inc=genres&fmt=json`);
      const top = (rg.genres || []).sort((a, b) => b.count - a.count)[0];
      if (top) return { ...c, genre: String(top.name).replace(/(^|\s)\p{L}/gu, (ch) => ch.toUpperCase()) };
    }
    if (c.source === 'Deezer' && Number.isInteger(c.id)) {
      const t = await safeJson(`https://api.deezer.com/track/${c.id}`);
      return { ...c, track: t.track_position, disc: t.disk_number, date: t.release_date || '' };
    }
  } catch {
    /* optional extras */
  }
  return c;
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

async function withRetry(fn) {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    return fn();
  }
}

const int = (v) => (Number.isInteger(v) && v > 0 && v < 1000 ? v : null);

// ------------------------------------------------------------ entry point

/**
 * @param {object} info yt-dlp info json for one video
 * @returns {Promise<{source: string, confidence: number|null, tags: object, coverUrl: string|null, lookupFailed: boolean}>}
 */
export async function resolveMetadata(info) {
  const hyps = hypotheses(info);
  const fb = fallbackTags(info, hyps);
  const fallback = {
    source: 'YouTube',
    confidence: null,
    coverUrl: null,
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
  if (!config.lookup) return fallback;

  for (const provider of PROVIDERS) {
    let best = null;
    for (const term of provider.queries(hyps)) {
      let candidates;
      try {
        candidates = await withRetry(() => provider.search(term));
      } catch (e) {
        fallback.lookupFailed = true;
        console.warn(`[metadata] ${provider.name} lookup failed: ${e.cause?.code || e.message}`);
        continue;
      }
      for (const c of candidates) {
        const s = score(c, hyps, info);
        if (s >= MIN_SCORE && (!best || s > best.s)) best = { c, s };
      }
      if (best && best.s >= 0.9) break;
    }
    if (!best) continue;
    const c = await enrich(best.c);
    return {
      source: c.source,
      confidence: Math.min(1, Math.round(best.s * 100) / 100),
      coverUrl: typeof c.cover === 'string' ? c.cover : null,
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
