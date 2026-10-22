/**
 * quota.js - AI quota check-and-increment BEFORE provider spend
 * (hardening H-G3, Pattern P2 - the financial brake behind the $0.00
 * ceiling: count > 60 in the hour window -> 429 before any provider call).
 *
 * Phase 1 ships the module + unit-callable API; the summary route uses it
 * in Phase 4 and the socket lane in Phase 3.
 *
 * Failure posture differs from the request limiter ON PURPOSE: if the
 * counter store is unavailable we fail CLOSED (DependencyDown 503) - never
 * spend without a counted quota.
 *
 * AI routes do NOT also take a generic rate-limit tier: this guard IS the
 * ai tier (60/hour/IP, keyed "ai-turn"), so counting stays single-source.
 */
import { db } from "./db.js";
import { AppError } from "./errors.js";
import { log } from "./log.js";
import { hmacKey, hourBucket, RATE_TIERS } from "./rate-limit.js";
import { AI_QUOTA_TURNS_PER_HOUR } from "./constants.js";

/**
 * Atomic check-and-increment of the hourly AI-turn quota for one caller.
 * The upsert runs in a transaction - two concurrent requests must not both
 * read "59 used, ok" (UNIQUE(key, windowStart) is the upsert anchor).
 * @param {string} ip caller identity (hashed inside this module)
 */
export async function quotaGuard(ip) {
  const key = hmacKey(ip, "ai-turn"); // HMAC-SHA256(runtime_secret, ip + route)
  const windowStart = hourBucket(new Date());
  let row;
  try {
    row = await db.$transaction(async (tx) =>
      tx.usageCounter.upsert({
        where: { key_windowStart: { key, windowStart } },
        create: { key, windowStart, count: 1 },
        update: { count: { increment: 1 } },
      }),
    );
  } catch (e) {
    log("quota", "quota_store_unavailable - failing closed", {
      name: e instanceof Error ? e.name : "unknown",
    });
    throw new AppError(503, "DependencyDown", "Voice service temporarily unavailable.");
  }
  if (row.count > AI_QUOTA_TURNS_PER_HOUR) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        (windowStart.getTime() + RATE_TIERS.ai.windowMs - Date.now()) / 1000,
      ),
    );
    log("quota", "ai_quota_exceeded", { key: key.slice(0, 12) });
    throw new AppError(429, "RateLimited", "Too many tries - wait a moment.", {
      headers: { "Retry-After": String(retryAfterSeconds) },
    });
  }
}
