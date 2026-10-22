# AI Voice Sales Bot - single-container deploy (Render / Fly / any Docker host)
# Shape mirrors the sandbox runtime: Caddy edge on $PORT routes
# /?XTransformPort=3003 -> voice-service (:3003), everything else -> main (:3000).
FROM oven/bun:1

# Prisma query engine needs openssl; caddy downloaded as a static binary below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

# Caddy edge gateway (amd64 static build; Render builds linux/amd64).
ADD https://github.com/caddyserver/caddy/releases/download/v2.10.0/caddy_2.10.0_linux_amd64.tar.gz /tmp/caddy.tar.gz
RUN tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy \
    && chmod +x /usr/local/bin/caddy \
    && rm -f /tmp/caddy.tar.gz

WORKDIR /app

# Install deps first (cached until a lockfile changes).
COPY package.json bun.lock ./
COPY mini-services/voice-service/package.json mini-services/voice-service/bun.lock mini-services/voice-service/
RUN bun install
RUN cd mini-services/voice-service && bun install

# Prisma client generate (schema push happens at container START: the disk
# is ephemeral on free tiers, so the SQLite file must be created per boot).
COPY prisma ./prisma
RUN bun run build

# App source.
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY mini-services/voice-service ./mini-services/voice-service
COPY deploy ./deploy

RUN mkdir -p /app/db

ENV NODE_ENV=production
EXPOSE 3000

# Foreground caddy keeps the container alive; it binds the platform-injected
# $PORT (Render/Fly) and proxies to the two app processes.
CMD ["sh", "deploy/start.sh"]
