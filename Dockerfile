# Bid Finder: one small image holding the web app, scheduler and CLI.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Build tools are only needed if no prebuilt SQLite binary exists for this CPU.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts/demo.js ./scripts/demo.js
RUN mkdir -p /data && chown node:node /data && ln -s /app/src/cli.js /usr/local/bin/bidfinder
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The port is fixed inside the container; map a different one outside if needed.
CMD ["node", "src/cli.js", "serve", "--strict-port"]
