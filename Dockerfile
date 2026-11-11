FROM node:22-trixie-slim

# ffmpeg 7 for conversion (needed for 32-bit FLAC), python3 for yt-dlp.
# The yt-dlp download is verified against the release's published checksums.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && cd /tmp \
 && curl -fsSLO https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && curl -fsSLO https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS \
 && grep ' yt-dlp$' SHA2-256SUMS | sha256sum -c - \
 && install -m 0755 yt-dlp /usr/local/bin/yt-dlp \
 && rm -f yt-dlp SHA2-256SUMS \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp \
    YTDLP_EXTRA_ARGS="--js-runtimes node"

# Runs as an unprivileged user; /data is the only place it writes.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
