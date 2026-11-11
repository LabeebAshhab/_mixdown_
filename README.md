# Mixdown

Mixdown is a self-hosted web app. Paste a YouTube or YouTube Music link, pick a format, and get back a properly tagged audio file with album artwork and lyrics.

Built by [Labeeb Ashhab](https://me.astroit.org) ([GitHub](https://github.com/LabeebAshhab)).

## Features

- **Ten output formats**, each with its own options: FLAC, WAV, AIFF, ALAC, DSD, MP3, AAC, Opus, OGG Vorbis, or the original stream untouched
- **Single videos and playlists**; a playlist downloads as one zip containing an album folder
- **Metadata extractor**: identifies the song and writes real release tags (title, artist, album, album artist, date, track and disc number, genre)
- **Album artwork** from the matched release, embedded in every format
- **Lyrics** looked up and embedded in the file
- **Metadata inspector**: drop an audio file (MP3, FLAC, WAV, AIFF, M4A, Ogg, Opus, DSF or Matroska) to read its tags, artwork and audio properties
- **Full-screen glass interface** with light and dark themes, an animated logo and a smooth theme switch
- **Storage limit per visitor** (3 GB by default); files are deleted from the server the moment they are downloaded
- **Hardened for public hosting**: see [Security](#security)

## Formats and options

| Format | Options |
| --- | --- |
| FLAC | Bit depth 16 / 24 / 32, sample rate up to 192 kHz, compression level |
| WAV | Bit depth 16 / 24 / 32 / 32 float, sample rate up to 192 kHz |
| AIFF | Bit depth 16 / 24 / 32, sample rate up to 192 kHz |
| ALAC (.m4a) | Bit depth 16 / 24, sample rate up to 192 kHz |
| DSD (.dsf) | DSD64 or DSD128 |
| MP3 | 320 / V0 / 256 / 192 / 128 kbps, sample rate |
| AAC (.m4a) | 320 / 256 / 192 / 128 kbps, sample rate |
| Opus | 256 / 192 / 160 / 128 / 96 kbps |
| OGG Vorbis | Quality q3 to q10, sample rate |
| Original | No re-encoding; tags and artwork are still added |

A note on quality: YouTube serves lossy audio (Opus or AAC, usually 130 to 160 kbps). Converting it to a lossless or high-resolution format preserves that audio exactly but cannot add detail that was never there, and the files get much larger. "Original" keeps the stream as delivered. 32-bit FLAC is not supported by every player.

DSD output comes from a built-in encoder (`src/dsd.js`): a fifth-order sigma-delta modulator that writes standard stereo DSF files. A DSD64 file is about 42 MB per minute.

## Quick start (Docker)

```bash
docker compose up -d --build
```

Open <http://localhost:8080>.

To change settings, copy `.env.example` to `.env`, edit it, and run the same command again. To update yt-dlp later (needed when YouTube changes something), rebuild without the cache:

```bash
docker compose build --no-cache
```

### Proxmox LXC

1. Create a Debian or Ubuntu LXC with **nesting** enabled (Options → Features → nesting).
2. Install Docker inside it: `curl -fsSL https://get.docker.com | sh`
3. Clone this repository and run `docker compose up -d --build`.
4. Browse to `http://<lxc-ip>:8080`.

### Putting it on the internet

Put a reverse proxy with HTTPS in front of it (Caddy, nginx, Traefik or a Cloudflare Tunnel), then set these in `.env`:

```
TRUST_PROXY=1
COOKIE_SECURE=1
```

`TRUST_PROXY` matters: without it, every visitor appears to come from the proxy's address and they all share one rate limit and one storage limit. Set `ACCESS_PASSWORD` if the site is meant only for you.

## Run without Docker

Requires Node.js 20+, plus [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org) 6.1 or newer on your `PATH`.

```bash
npm ci
```

```bash
npm start
```

## Configuration

All settings are environment variables; `.env.example` lists every one with its default. The main ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACCESS_PASSWORD` | empty | Require a password to use the app |
| `TRUST_PROXY` | empty | Number of reverse proxies in front of the app |
| `QUOTA_GB` | `3` | Space one visitor may have waiting to be downloaded |
| `TOTAL_STORAGE_GB` | `20` | Space all visitors together may use |
| `FILE_TTL_MINUTES` | `15` | How long a finished file waits before it is deleted |
| `MAX_TRACKS` | `100` | Tracks taken from one playlist |
| `MAX_TRACK_MINUTES` | `90` | Longest single video |
| `MAX_CONCURRENT` | `2` | Links processed at the same time |
| `RATE_CONVERT_PER_MIN` | `5` | New links per minute, per visitor |
| `LYRICS` / `METADATA_LOOKUP` | `on` | Turn the lookups off |
| `CREDIT_NAME`, `CREDIT_GITHUB`, `CREDIT_WEBSITE` | set | Footer credits |

## How storage works

- Every finished file counts towards the visitor's limit until it is downloaded.
- A file is deleted from the server as soon as its download completes. The space is then free again, so a visitor can download 3 GB and start over.
- A track that would not fit is refused before it is converted.
- Files nobody downloads are deleted after `FILE_TTL_MINUTES`. A sweep runs every minute and also removes anything left behind by a crash.
- Nothing is kept across restarts.

## Security

The app is written to be exposed to untrusted visitors.

**No command injection.** External tools (`yt-dlp`, `ffmpeg`) are started only through `src/proc.js`, which never uses a shell and passes arguments as an array. Formats and every option value come from a fixed allowlist (`src/formats.js`). A pasted link is reduced to its video or playlist id, checked against a strict pattern, and the URL is rebuilt from that id, so nothing a visitor types reaches a command line.

**No server-side request forgery.** Only YouTube links are accepted. The server's own requests (catalogues, artwork, lyrics) go through `src/net.js`: HTTPS only, a fixed host allowlist, DNS resolved at connect time with loopback, private, link-local and multicast addresses refused, redirects followed by hand (at most three, each re-checked), and limits on time and response size.

**Safe file handling.** Files on disk are named with random UUIDs inside a per-job folder; titles and artist names never become paths. Every path is checked to be inside the data folder. Download names are sanitised in the `Content-Disposition` header.

**Input validation.** Request bodies are checked against strict schemas (zod) that reject unknown fields. Uploads to the inspector are identified by their first bytes, not their name or declared type. Downloaded artwork is checked the same way and re-encoded before use.

**Resource limits.** Token-bucket rate limits per address (overall, new links, uploads, password attempts); a worker queue with a concurrency cap; hard timeouts that kill any subprocess; limits on source size, track length, playlist length, upload size, and per-visitor and total storage.

**Isolation between visitors.** Each browser gets a random session id in an `HttpOnly`, `SameSite=Strict` cookie. Jobs can only be listed, downloaded or removed by the session that created them. Writes are refused when they come from another site.

**Headers and errors.** A strict Content-Security-Policy (no inline scripts or styles, no third-party hosts), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and HSTS over HTTPS. Error responses are short sentences; stack traces, paths and tool output stay in the server log.

**Container.** Runs as an unprivileged user on a read-only filesystem with all Linux capabilities dropped, `no-new-privileges`, and CPU, memory and process limits. The yt-dlp download is verified against its published checksum at build time.

What this does not cover: TLS (use a reverse proxy), protection against large distributed floods (use your proxy or CDN), and vulnerabilities in ffmpeg or yt-dlp themselves, which is why the container is locked down. Keep the image rebuilt regularly.

## How it works

1. `yt-dlp` downloads the best audio stream, its info and thumbnail.
2. The metadata extractor (`src/metadata.js`) builds several readings of the video title, searches iTunes, Deezer and MusicBrainz, and scores candidates on title, artist and duration. Karaoke, tribute and cover versions are rejected, and the original studio album is preferred. Weak matches are refused: the file is then tagged from the YouTube data and marked "no catalogue match".
3. Album artwork and lyrics (from LRCLIB) are fetched for the matched song.
4. `ffmpeg` converts the audio. Tags are written by ffmpeg where it does that well (FLAC, Ogg, MP4) and by a built-in ID3 writer elsewhere (MP3, WAV, AIFF, DSF).
5. The built-in reader (`src/reader/`) reads the finished file back, and the verified result is shown in the interface. The same reader powers the metadata inspector. It parses each format directly, with no parsing library, and its result follows the `format` / `common` / `native` layout of [music-metadata](https://github.com/Borewit/music-metadata), which the app used before.

Lookups send the song's title and artist to those public services. Set `METADATA_LOOKUP=off` and `LYRICS=off` to disable them.

## Project layout

```
server.js          start-up and middleware
src/config.js      settings
src/security.js    headers, rate limits, sessions, safe names, error messages
src/net.js         guarded outbound requests
src/proc.js        subprocess runner (no shell, hard timeouts)
src/formats.js     formats and options allowlist
src/pipeline.js    download, identify, convert, tag, verify
src/jobs.js        queue, storage limit, cleanup
src/routes.js      HTTP API and input schemas
src/metadata.js    catalogue matching
src/lyrics.js      lyrics lookup
src/tags.js        ffmetadata and ID3 writers
src/reader/        tag and audio-property reader (MP3, FLAC, WAV, AIFF, MP4, Ogg, DSF, Matroska)
src/dsd.js         PCM to DSD encoder
public/            interface
```

## Responsible use

Only download content you own, content under a licence that allows it (such as Creative Commons), or content you have permission to download. If you host this for other people, you are responsible for how it is used, for YouTube's terms of service, and for the copyright law that applies to you.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Labeeb Ashhab.
