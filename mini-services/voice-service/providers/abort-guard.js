/**
 * abort-guard.js - shared abort/timeout race helper for feature 14 TTS
 * chain steps (both steps need the same guarantee: a step run() must
 * reject the moment EITHER its own Pattern P1 AI timeout (H-E2, 20 s
 * stall -> fail -> chain hops) OR an external barge-in abort fires, and
 * the abort must NOT be retried by P1).
 *
 * Status classes surfaced to Pattern P1 (chain.js, untouched):
 *   - 0   : timeout / network class (retryable per P1)
 *   - 499 : aborted on purpose (barge-in) - a 4xx, so P1 hops immediately
 *           and never retries (H-E3 semantics); the caller maps it back
 *           to the barge path.
 *
 * H-G4: error objects never carry provider bodies or audio bytes; only
 * these fixed labels, and the service logs status codes only.
 */

/**
 * Build a status-carrying abort error (Pattern P1 reads e.status).
 *
 * @param {number} status 0 (timeout/network) or 499 (barge-in abort)
 * @param {string} label fixed ASCII label, never a provider body
 * @returns {Error}
 */
export function makeAbortError(status, label) {
  const error = new Error(label);
  error.status = status;
  return error;
}

/**
 * Race one in-flight collection promise against a set of abort guards.
 * A guard whose signal is ALREADY aborted rejects synchronously (a
 * barge-in can land between chain steps); otherwise the first abort
 * listener or the promise itself settles the race. onAbort is a
 * best-effort cancel hook for the underlying stream (never throws).
 *
 * @param {Promise<unknown>} promise the in-flight collection
 * @param {{signal: AbortSignal, status: number}[]} guards
 * @param {() => void} [onCancel] best-effort stream cancel hook
 * @returns {Promise<unknown>} resolves with the collection value
 */
export function raceWithGuards(promise, guards, onCancel) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const listeners = [];
    const cancel = () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
      if (typeof onCancel === "function") {
        try {
          onCancel();
        } catch {
          // best-effort cancel only - never mask the settle outcome
        }
      }
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cancel();
      fn(value);
    };
    // A guard that aborted BEFORE the race started rejects immediately.
    for (const guard of Array.isArray(guards) ? guards : []) {
      if (guard.signal.aborted) {
        settle(reject, makeAbortError(guard.status, "chain step aborted"));
        return;
      }
    }
    promise.then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
    for (const guard of Array.isArray(guards) ? guards : []) {
      const listener = () => settle(reject, makeAbortError(guard.status, "chain step aborted"));
      listeners.push({ signal: guard.signal, listener });
      guard.signal.addEventListener("abort", listener, { once: true });
    }
  });
}
