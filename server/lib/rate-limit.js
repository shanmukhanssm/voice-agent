/**
 * rate-limit.js - HMAC-keyed UsageCounter limiter (hardening H-C7, ADR H-04,
 * Pattern P2 mechanics).
 *
 * KEY:   HMAC-SHA256(runtime_secret, ip + route-class) - hashed key, the raw
 *        IP is never stored or logged (log lines carry the truncated hash).
 * STORE: SQLite UsageCounter(key, windowStart, count), UNIQUE(key,
 *        windowStart), transactional upsert-increment.
 * TIERS: writes 30/min/IP - turn relays 120/min/IP - reads 120/min/IP -
 *        uploads 10/min/IP - AI turns 60/hour/IP (the ai tier is enforced by
 *        quota.js BEFORE provider spend; AI routes skip the generic tier).
 * SWEEP: windows older than 1 hour are deleted opportunistically, throttled
 *        to once per 5 minutes.
 * 429:   RateLimited envelope + Retry-After header.
 */
import { createHmac } from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { AppError } from "./errors.js";
import {
  RATE_WRITE_PER_MIN,
  RATE_TURNS_PER_MIN,
  RATE_READ_PER_MIN,
  RATE_UPLOAD_PER_MIN,
  AI_QUOTA_TURNS_PER_HOUR,
} from "./constants.js";

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const SWEEP_THROTTLE_MS = 300000;

/** The closed tier table (hardening.md ss Validation & Input; the turns
 *  tier implements Trust-Boundary row 8's 120/min/IP turn relay cap). */
export const RATE_TIERS = Object.freeze({
  read: { limit: RATE_READ_PER_MIN, windowMs: MINUTE_MS },
  write: { limit: RATE_WRITE_PER_MIN, windowMs: MINUTE_MS },
  turns: { limit: RATE_TURNS_PER_MIN, windowMs: MINUTE_MS },
  upload: { limit: RATE_UPLOAD_PER_MIN, windowMs: MINUTE_MS },
  ai: { limit: AI_QUOTA_TURNS_PER_HOUR, windowMs: HOUR_MS },
});

/**
 * HMAC-SHA256(runtime_secret, identity + route-class) - Pattern P2's hmacKey.
 * @param {string} identity caller identity (ip)
 * @param {string} routeClass limiter class, e.g. "read" | "write" | "upload" | "ai-turn"
 * @returns {string} hex digest
 */
export function hmacKey(identity, routeClass) {
  return createHmac("sha256", config.runtimeSecret)
    .update(`${identity}+${routeClass}`)
    .digest("hex");
}

/**
 * Truncate a wall-clock instant to the start of its window bucket (UTC).
 * @param {Date} date
 * @param {number} windowMs bucket size in ms
 * @returns {Date} bucket start
 */
export function windowBucket(date, windowMs) {
  return new Date(Math.floor(date.getTime() / windowMs) * windowMs);
}

/** UTC hour truncation (Pattern P2's hourBucket). */
export function hourBucket(date) {
  return windowBucket(date, HOUR_MS);
}

let lastSweepAt = 0;

/**
 * Opportunistic sweep of UsageCounter windows older than 1 hour, throttled
 * so at most one sweep runs per 5 minutes.
 */
async function sweepMaybe(route) {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_THROTTLE_MS) return;
  lastSweepAt = now;
  try {
    await db.usageCounter.deleteMany({
      where: { windowStart: { lt: new Date(now - HOUR_MS) } },
    });
  } catch (e) {
    log(route, "counter_sweep_failed", {
      name: e instanceof Error ? e.name : "unknown",
    });
  }
}

/**
 * Check-and-increment the per-IP counter for one tier. Over limit -> AppError
 * 429 RateLimited with Retry-After. If the counter store is unavailable the
 * limiter fails OPEN (logs and allows) so routes can answer truthfully - e.g.
 * /api/health must be able to report the DB as down instead of a masked 500.
 * @param {object} spec
 * @param {string} spec.ip caller identity
 * @param {string} spec.route route tag (log)
 * @param {"read" | "write" | "turns" | "upload"} spec.tier limiter tier
 */
export async function enforceRateLimit({ ip, route, tier }) {
  const spec = RATE_TIERS[tier];
  if (!spec) throw new Error(`unknown rate tier: ${tier}`);
  const key = hmacKey(ip, tier);
  const windowStart = windowBucket(new Date(), spec.windowMs);
  try {
    await sweepMaybe(route);
    const row = await db.usageCounter.upsert({
      where: { key_windowStart: { key, windowStart } },
      create: { key, windowStart, count: 1 },
      update: { count: { increment: 1 } },
    });
    if (row.count > spec.limit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStart.getTime() + spec.windowMs - Date.now()) / 1000),
      );
      log(route, `rate_limited tier=${tier}`, { key: key.slice(0, 12) });
      throw new AppError(429, "RateLimited", `Too many tries - wait ${retryAfterSeconds}s.`, {
        headers: { "Retry-After": String(retryAfterSeconds) },
      });
    }
  } catch (e) {
    if (e instanceof AppError) throw e; // the 429 itself
    log(route, "rate_limit_store_unavailable - failing open", {
      name: e instanceof Error ? e.name : "unknown",
    });
  }
}
