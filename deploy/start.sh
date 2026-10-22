#!/bin/sh
# Container entrypoint (Render / Fly / docker run).
# Three processes, mirroring the sandbox runtime:
#   voice-service :3003 (socket.io voice engine)
#   main server   :3000 (static + REST; PORT is pinned to 3000 here because
#                        the platform-injected $PORT belongs to the Caddy edge)
#   caddy edge    $PORT (foreground; keeps the container alive)
set -e
cd /app

# Prisma schema has no URL default; on free-tier hosts the disk is ephemeral,
# so push a fresh SQLite schema on every boot.
export DATABASE_URL="${DATABASE_URL:-file:../db/custom.db}"
mkdir -p /app/db
echo "[deploy] pushing prisma schema..."
bun run db:push

echo "[deploy] starting voice-service on :3003..."
cd /app/mini-services/voice-service
bun index.js &

echo "[deploy] starting main server on :3000..."
cd /app
PORT=3000 bun server/index.js &

echo "[deploy] starting edge gateway on :${PORT:-3000}..."
exec caddy run --config /app/deploy/Caddyfile --adapter caddyfile
