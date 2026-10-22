/**
 * health.js - GET /api/health (hardening H-E7): public, rate-limit-light
 * (read tier). Liveness = process up; readiness = a 5 s-bounded SELECT 1
 * plus the env completeness map, plus a 2 s voice-service reachability
 * probe (feature 17): data.voice = "up" | "down". A network error/timeout
 * to the voice-service NEVER turns health 503 - only the DB probe does.
 * Response { ok, db, voice, version, env }; DB down -> 503 DependencyDown
 * envelope with db: "down". No hostnames, no driver errors.
 */
import { db } from "../lib/db.js";
import { config } from "../lib/config.js";
import { envComplete } from "../lib/env.js";
import { respond, withRoute } from "../lib/envelope.js";
import { DB_TIMEOUT_MS, VOICE_PROBE_TIMEOUT_MS } from "../lib/constants.js";
import { log } from "../lib/log.js";

/** Voice mini-service reachability endpoint (:3003 is a separate process). */
const VOICE_HEALTH_URL = "http://127.0.0.1:3003/healthz";

/**
 * 5 s-bounded SELECT 1 probe. $queryRaw takes no abort signal, so the bound
 * is a Promise.race against a DB_TIMEOUT_MS timer (library-docs.md ss
 * Prisma: SELECT 1 readiness probe inside AbortSignal.timeout semantics).
 * @returns {Promise<boolean>} true when the DB answered in time
 */
async function probeDb() {
  const probe = db.$queryRaw`SELECT 1`;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`db probe exceeded ${DB_TIMEOUT_MS}ms`)),
      DB_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([probe, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    // a lost race must never surface later as an unhandled rejection
    probe.catch(() => {});
  }
}

/**
 * 2 s-bounded voice-service reachability probe (feature 17). ANY HTTP answer
 * proves the process is listening (the socket service answers non-socket
 * paths with its own engine.io error body - that is still liveness); only a
 * network error or timeout reads "down". NEVER throws (E7 posture).
 * @returns {Promise<"up" | "down">}
 */
async function probeVoice() {
  try {
    await fetch(VOICE_HEALTH_URL, {
      signal: AbortSignal.timeout(VOICE_PROBE_TIMEOUT_MS),
    });
    return "up";
  } catch {
    return "down";
  }
}

/**
 * Health handler: 200 { ok, data: { db: "up", voice, version, env } } or
 * 503 DependencyDown with data.db = "down" (voice state rides along as
 * information; it never causes the 503).
 */
async function healthHandler() {
  const [up, voice] = await Promise.all([probeDb(), probeVoice()]);
  if (!up) {
    log("health", "db_probe_failed -> 503", { timeoutMs: DB_TIMEOUT_MS });
    // E7: DB down -> 503 + db: "down"; fallback-table copy for SQLite,
    // never the voice-service sentence and never a driver error.
    return respond({
      status: 503,
      error: {
        code: "DependencyDown",
        message: "Service temporarily unavailable.",
      },
      data: { db: "down", voice },
    });
  }
  return respond({
    status: 200,
    data: { db: "up", voice, version: config.appVersion, env: envComplete() },
  });
}

/** GET /api/health route, read-tier limited. */
export const healthRoute = withRoute({
  route: "health",
  tier: "read",
  handler: healthHandler,
});
