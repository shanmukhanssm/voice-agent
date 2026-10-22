#!/bin/sh
# Production entrypoint (deploy `start` script): schema push + voice-service
# + main server, mirroring the sandbox runtime shape.
#
# - `bun run db:push` makes a FRESH deploy database match
#   prisma/schema.prisma (no-op when already in sync; --accept-data-loss is
#   safe on a deploy-fresh SQLite file that ships no data).
# - The voice socket mini-service (:3003) runs in the BACKGROUND; the Caddy
#   gateway routes /?XTransformPort=3003 to it (same shape as the sandbox
#   runtime - see the boot timeline's "Starting Caddy server" step).
# - The main server (:3000, or the $PORT the deploy platform injects) stays
#   in the FOREGROUND so the runtime keeps the container alive.
set -e
cd "$(dirname "$0")/.."
# Non-blocking env guard: re-seed .env from .env.canonical if the boot wiped
# canonical keys (|| true so a missing canonical file never blocks startup).
bun scripts/env-guard.mjs || true
bun run db:push
bun mini-services/voice-service/index.js &
exec bun server/index.js
