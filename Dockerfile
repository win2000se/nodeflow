# NODEFLOW server — Express + SQLite, serves the WebGL2 visual synth frontend
FROM node:20-bookworm-slim

# build tools for the native better-sqlite3 module, plus media conversion:
#   ffmpeg      — encodes gif → mp4 (h264) for the <video> playback path
#   imagemagick — decodes animated webp → gif (ffmpeg cannot read animated webp)
#   webp        — libwebp tooling backing imagemagick's webp delegate
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ffmpeg imagemagick webp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install deps first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# app code
COPY server.js ./
COPY public ./public

# patch library lives here — mount a volume to persist it
ENV DATA_DIR=/data
ENV PORT=8080
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "server.js"]
