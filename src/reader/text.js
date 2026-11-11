// Small decoding helpers shared by the tag readers.

/** Cut at the first NUL, drop a byte-order mark, trim. */
export function clean(s) {
  const i = s.indexOf('\0');
  return (i < 0 ? s : s.slice(0, i)).replace(/^﻿/, '').trim();
}

/** Decode with an ID3 text-encoding byte: 0 Latin-1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8. */
export function decode(buf, enc) {
  if (enc !== 1 && enc !== 2) return buf.toString(enc === 3 ? 'utf8' : 'latin1');
  let be = enc === 2;
  let b = buf;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    be = true;
    b = b.subarray(2);
  } else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    be = false;
    b = b.subarray(2);
  }
  b = b.subarray(0, b.length & ~1);
  return be ? Buffer.from(b).swap16().toString('utf16le') : b.toString('utf16le');
}

/** A terminated string starting at `start`. Returns the text and the offset after its terminator. */
export function cstring(buf, start, enc) {
  let end;
  if (enc === 1 || enc === 2) {
    end = start;
    while (end + 1 < buf.length && (buf[end] | buf[end + 1]) !== 0) end += 2;
    end = Math.min(end, buf.length);
    return { text: clean(decode(buf.subarray(start, end), enc)), next: Math.min(end + 2, buf.length) };
  }
  end = buf.indexOf(0, start);
  if (end < 0) end = buf.length;
  return { text: clean(decode(buf.subarray(start, end), enc)), next: Math.min(end + 1, buf.length) };
}

/** Image type from the first bytes, or null. */
export function imageType(d) {
  if (d.length < 12) return null;
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'image/jpeg';
  if (d.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (d.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (d.toString('latin1', 0, 4) === 'RIFF' && d.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (d[0] === 0x42 && d[1] === 0x4d) return 'image/bmp';
  return null;
}

/** Genre names by number, as used by ID3v1, ID3v2 "(17)" references and the MP4 "gnre" atom. */
export const GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
  'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alt. Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta Rap',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes',
  'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
  'Folk', 'Folk/Rock', 'National Folk', 'Swing', 'Fast-Fusion', 'Bebob', 'Latin', 'Revival', 'Celtic', 'Bluegrass',
  'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic',
  'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove',
  'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle',
  'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore',
  'Terror', 'Indie', 'BritPop', 'Negerpunk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover',
  'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'JPop', 'Synthpop', 'Abstract', 'Art Rock',
  'Baroque', 'Bhangra', 'Big Beat', 'Breakbeat', 'Chillout', 'Downtempo', 'Dub', 'EBM', 'Eclectic', 'Electro',
  'Electroclash', 'Emo', 'Experimental', 'Garage', 'Global', 'IDM', 'Illbient', 'Industro-Goth', 'Jam Band', 'Krautrock',
  'Leftfield', 'Lounge', 'Math Rock', 'New Romantic', 'Nu-Breakz', 'Post-Punk', 'Post-Rock', 'Psytrance', 'Shoegaze', 'Space Rock',
  'Trop Rock', 'World Music', 'Neoclassical', 'Audiobook', 'Audio Theatre', 'Neue Deutsche Welle', 'Podcast', 'Indie Rock', 'G-Funk', 'Dubstep',
  'Garage Rock', 'Psybient',
];
