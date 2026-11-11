// Lyrics lookup from LRCLIB, an open lyrics database. The text is embedded in
// the visitor's own file; it is never logged or stored anywhere else.
import { config } from './config.js';
import { safeJson } from './net.js';
import { cleanText } from './security.js';

const API = 'https://lrclib.net/api';
const MAX_CHARS = 20_000;

const simple = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[([](?:feat|ft|featuring|with)\b[^)\]]*[)\]]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const query = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

function textOf(record) {
  if (!record || record.instrumental) return null;
  const plain = record.plainLyrics || String(record.syncedLyrics || '').replace(/^\[[^\]]*\]\s?/gm, '');
  const cleaned = cleanText(plain, MAX_CHARS, true);
  return cleaned.length > 20 ? cleaned : null;
}

/**
 * @param {{title: string, artist: string, album?: string, duration?: number}} song
 * @returns {Promise<string|null>} plain lyrics, or null when none are found
 */
export async function findLyrics({ title, artist, album, duration }) {
  if (!config.lyrics || !title || !artist) return null;
  const track = title.replace(/\s*[([](?:feat|ft|featuring|with)\b[^)\]]*[)\]]/gi, '').trim() || title;

  // 1. Exact lookup: the service matches the duration within a couple of seconds.
  if (duration) {
    try {
      const hit = await safeJson(
        `${API}/get?${query({ track_name: track, artist_name: artist, album_name: album, duration: Math.round(duration) })}`,
      );
      const found = textOf(hit);
      if (found) return found;
    } catch {
      /* not found, fall through to search */
    }
  }

  // 2. Search, then keep only results for the same song, closest in length.
  try {
    const results = await safeJson(`${API}/search?${query({ track_name: track, artist_name: artist })}`);
    const wantTitle = simple(track);
    const wantArtist = simple(artist);
    let best = null;
    let bestDiff = Infinity;
    for (const r of Array.isArray(results) ? results : []) {
      if (simple(r.trackName) !== wantTitle) continue;
      const a = simple(r.artistName);
      if (a !== wantArtist && !a.includes(wantArtist) && !wantArtist.includes(a)) continue;
      const diff = duration && r.duration ? Math.abs(duration - r.duration) : 5;
      if (diff > 10 || diff >= bestDiff || !textOf(r)) continue;
      best = r;
      bestDiff = diff;
    }
    return textOf(best);
  } catch {
    return null;
  }
}
