/**
 * chain.js - Pattern P1 Provider Chain (library-docs.md, SINGLE COPY of
 * that envelope - the file path named in the docs envelope is THIS file).
 *
 * Runs the failover steps in order; each step gets 3 attempts; retries only
 * on 429 / 5xx / network (status 0) with the RETRY_BACKOFF_MS ladder +
 * jitter; any 4xx hops to the next provider immediately (H-E3, never
 * retried). Every step.run() sets its own AbortSignal.timeout (H-E2) - the
 * chain adds no timer of its own. Provider error BODIES never reach this
 * module: steps throw status-carrying errors and only the status code is
 * logged (H-G4). When every step is exhausted it throws the taxonomy's
 * DependencyDown AppError (503).
 *
 * Provenance note (boundary rule, architecture.md "System Boundaries"): the
 * voice-service never touches the DB / static files / uploads, but these
 * imports are the PURE, dependency-free canonical constants + AppError from
 * the main server's lib - the project's single source of truth. One-line
 * provenance: server/lib/constants.js + server/lib/errors.js are shared
 * canonical modules by design (code-standards.md constants table).
 */

// Provenance: canonical pure modules owned by server/lib (single copy).
import { AppError } from "../../../server/lib/errors.js";
import { AI_TIMEOUT_MS, RETRY_BACKOFF_MS } from "../../../server/lib/constants.js";

/** One ASCII JSON line per event, same shape as the service's logEvent. */
function log(event, fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Canonical AI timeout signal for chain steps (H-E2: AI providers 20 s).
 * Each step.run() arms this itself - the chain never wraps timers.
 *
 * @returns {AbortSignal}
 */
export function aiTimeoutSignal() {
  return AbortSignal.timeout(AI_TIMEOUT_MS);
}

/**
 * Pattern P1 - run the provider chain.
 *
 * @param {{name: string, run: () => Promise<unknown>}[]} steps ordered
 *   failover steps (e.g. ASR [groq, builtin]); a step's run() rejects with
 *   e.status set (HTTP status or 0 for network/timeout).
 * @returns {Promise<unknown>} the first successful step's output
 * @throws {AppError} 503 DependencyDown when every step is exhausted
 */
export async function runChain(steps) {
  let lastCode = 0;
  for (const step of steps) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await step.run(); // each run() sets its own AbortSignal.timeout
      } catch (e) {
        const code = e?.status ?? 0;
        lastCode = code;
        const retryable = code === 429 || code >= 500 || code === 0; // network=0
        if (!retryable || attempt === 2) break; // 4xx -> hop immediately (H-E3)
        await sleep(RETRY_BACKOFF_MS[attempt] + Math.random() * 250); // + jitter
      }
    }
    log("provider_failover", { layer: step.name, statusCode: lastCode }); // event list
  }
  throw new AppError(503, "DependencyDown", "Voice service temporarily unavailable.");
}
