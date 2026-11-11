// Collects what the format readers find:
//   format  audio properties (container, codec, sample rate, duration, ...)
//   native  every tag exactly as stored, grouped by tag format
//   common  the same information under one set of names, whatever the format
//
// A file can carry more than one tag format (a WAV has RIFF INFO and ID3, an
// MP3 has ID3v2 and ID3v1). The richer format wins, in the order below.

const RANK = { ID3v1: 1, 'AIFF text': 2, 'RIFF INFO': 3, matroska: 4, iTunes: 5, 'ID3v2.2': 6, 'ID3v2.3': 7, 'ID3v2.4': 8, vorbis: 9 };
const LISTS = new Set(['genre', 'artists', 'composer', 'comment', 'lyrics', 'picture']);
const MAX_NATIVE = 1000;
const MAX_LIST = 100;

const int = (v) => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

/** "3/12", "3", 3 or {no, of} */
function pair(v) {
  if (v && typeof v === 'object') return [int(v.no), int(v.of)];
  const [no, of] = String(v).split('/');
  return [int(no), of === undefined ? null : int(of)];
}

export class Meta {
  constructor() {
    this.format = { tagTypes: [] };
    this.common = { track: { no: null, of: null }, disk: { no: null, of: null } };
    this.native = {};
    this.ranks = new Map();
  }

  setFormat(values) {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) continue;
      this.format[k] = v;
    }
  }

  /** Record a tag as stored. */
  raw(type, id, value) {
    const list = this.#list(type);
    if (list.length < MAX_NATIVE) list.push({ id, value });
  }

  #list(type) {
    if (!this.native[type]) {
      this.native[type] = [];
      this.format.tagTypes.push(type);
    }
    return this.native[type];
  }

  /** Record a value under its common name. */
  set(type, key, value) {
    if (value === undefined || value === null || value === '') return;
    switch (key) {
      case 'track':
      case 'disk': {
        const [no, of] = pair(value);
        this.#one(type, `${key}.no`, no);
        this.#one(type, `${key}.of`, of);
        return;
      }
      case 'tracktotal':
        return this.#one(type, 'track.of', int(value));
      case 'disktotal':
        return this.#one(type, 'disk.of', int(value));
      case 'year':
        return this.#one(type, 'year', int(/\d{4}/.exec(String(value))?.[0]));
      case 'bpm':
        return this.#one(type, 'bpm', int(value));
      case 'compilation':
        return this.#one(type, 'compilation', value === true || value === 1 || value === '1');
      default:
        return LISTS.has(key) ? this.#many(type, key, value) : this.#one(type, key, value);
    }
  }

  /** Record a tag as stored and, when it has a common name, under that too. */
  tag(type, id, value, key) {
    this.raw(type, id, value);
    if (key) this.set(type, key, value);
  }

  /** @param {{format: string, data: Buffer, description?: string, kind?: number}} pic */
  picture(type, pic) {
    this.#list(type);
    if (pic.data.length) this.#many(type, 'picture', pic);
  }

  #one(type, key, value) {
    if (value === undefined || value === null || value === '') return;
    const rank = RANK[type] ?? 0;
    if (this.ranks.has(key) && this.ranks.get(key) >= rank) return; // the first value of the best format stays
    this.ranks.set(key, rank);
    const [a, b] = key.split('.');
    if (b) this.common[a][b] = value;
    else this.common[a] = value;
  }

  #many(type, key, value) {
    const rank = RANK[type] ?? 0;
    const have = this.ranks.get(key) ?? -1;
    if (rank < have) return;
    if (rank > have) {
      this.ranks.set(key, rank);
      this.common[key] = [];
    }
    const list = this.common[key];
    if (list.length < MAX_LIST && !list.includes(value)) list.push(value);
  }

  finish() {
    if (this.common.year === undefined && this.common.date) this.set('', 'year', this.common.date);
    return { format: this.format, common: this.common, native: this.native };
  }
}
