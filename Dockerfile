# Build stage: has the toolchain in case better-sqlite3 needs to compile.
FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage: just node and the built modules.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js db.js session-store.js ./
COPY public ./public

# The chat database lives here — mount a volume so it survives redeploys.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000
CMD ["node", "server.js"]
