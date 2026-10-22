/**
 * xkiro-llm.js - Xkiro LLM chain steps (feature 13 chain, Task 17-a swap;
 * hosted failover hop replacing the Ollama local hop - user direction
 * 2026-10-21: "change this ollama to this xkiro api key").
 *
 * ONE factory, TWO locked models (Task 17-a chain order):
 *   makeXkiroLlmStep("sensenova/sensenova-6.8-flash-lite")  -> step name "xkiro-flash" (fast hop)
 *   makeXkiroLlmStep("qwen/qwen3-omni-flash:free")          -> step name "xkiro-qwen" (free fallback)
 * Model names are PINNED (library-docs gotcha: models drift - never
 * "latest"); config.js imports XKIRO_LLM_MODELS instead of restating them.
 *
 * Envelope per library-docs.md "Xkiro REST": OpenAI-compatible POST
 * {baseUrl}/chat/completions with { model, messages, stream: false },
 * Authorization Bearer. NO max_tokens parameter: reasoning models can burn
 * part of a small budget reasoning and a max_tokens cap makes them return
 * EMPTY content (both locked models verified live HTTP 200 on 2026-10-21
 * without it).
 *
 * Task 20-a (latency + barge-in): the step arms its OWN guards via
 * abort-guard.js raceWithGuards - the same pattern the TTS steps use -
 * instead of the bare aiTimeoutSignal() fetch signal:
 *   - AbortSignal.timeout(LLM_TIMEOUT_MS) (status 0): a stalled hosted
 *     attempt costs <= 8 s before the P1 hop, not 20 s (AI_TIMEOUT_MS
 *     stays on ASR/TTS steps);
 *   - the optional externalSignal (the whole-turn barge-in abort, threaded
 *     by config.js, status 499): rejects IMMEDIATELY even when the signal
 *     pre-aborted (barge landing between chain steps), so post-hop steps
 *     unwind in ~0 ms - and P1 never retries a 4xx.
 * onCancel best-effort aborts the in-flight fetch via a per-attempt
 * AbortController (the race outcome is already fixed by then).
 *
 * H-G4: a non-OK response becomes an error carrying ONLY e.status - the
 * response body is never read, logged, or attached. Fetch rejection
 * (DNS / refused / reset / timeout) surfaces as status 0 (network class)
 * so the chain hops onward per Pattern P1. ADR H-01: an ABSENT key or
 * base URL is a mode, not an error - the factory returns null and
 * config.js simply omits the step. Key and base URL are passed in by
 * providers/config.js (the voice-service's SOLE env reader); this module
 * never reads env.
 */

import { makeAbortError, raceWithGuards } from "./abort-guard.js";

// Provenance: canonical pure constant owned by server/lib (single copy).
import { LLM_TIMEOUT_MS } from "../../../server/lib/constants.js";

/** Locked LLM models (Task 17-a chain order; never "latest"). */
export const XKIRO_LLM_MODELS = Object.freeze({
  fast: "sensenova/sensenova-6.8-flash-lite",
  free: "qwen/qwen3-omni-flash:free",
});

/** Chain step names for the locked models (logs + registry naming). */
const STEP_NAMES = Object.freeze({
  [XKIRO_LLM_MODELS.fast]: "xkiro-flash",
  [XKIRO_LLM_MODELS.free]: "xkiro-qwen",
});

/**
 * Build one Xkiro LLM chain step for one assembled sales prompt.
 *
 * @param {string} model pinned Xkiro model name (XKIRO_LLM_MODELS)
 * @param {{role: string, content: string}[]} messages OpenAI-style messages
 * @param {string} apiKey XKIRO_API_KEY (from providers/config.js)
 * @param {string} baseUrl XKIRO_BASE_URL (from providers/config.js)
 * @param {AbortSignal} [externalSignal] whole-turn barge-in abort (Task 20-a)
 * @returns {{name: string, run: () => Promise<string>} | null} the step,
 *   or null when the key or base URL is absent/empty (ADR H-01 - step
 *   not included)
 */
export function makeXkiroLlmStep(model, messages, apiKey, baseUrl, externalSignal) {
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
  return {
    name: STEP_NAMES[model] ?? "xkiro",
    /**
     * @returns {Promise<string>} the model reply text ("" when the
     *   provider reports no content - handled downstream as llm_empty)
     * @throws {Error} e.status = HTTP status, 0 (network/timeout), or 499
     *   (barge-in abort; body never read)
     */
    run: async () => {
      // Pre-aborted (barge landed between chain steps): reject before the
      // fetch even starts (raceWithGuards would reject instantly anyway;
      // this keeps the dead hop at literally zero work).
      if (externalSignal?.aborted) {
        throw makeAbortError(499, "chain step aborted");
      }
      // Per-attempt controller: the guards' onCancel aborts the in-flight
      // fetch (timeout or barge); the request itself never retries.
      const controller = new AbortController();
      const guards = [{ signal: AbortSignal.timeout(LLM_TIMEOUT_MS), status: 0 }];
      if (externalSignal) guards.push({ signal: externalSignal, status: 499 });
      const request = (async () => {
        let response;
        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            body: JSON.stringify({ model, messages, stream: false }),
          });
        } catch {
          // DNS / refused / reset / timeout: fetch rejection -> status 0
          // (network class) -> the chain hops onward per P1.
          const error = new Error("xkiro llm unreachable");
          error.status = 0;
          throw error;
        }
        if (!response.ok) {
          // H-G4: status code only - never read/log the provider body.
          const error = new Error(`xkiro llm failed with status ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const data = await response.json();
        // OpenAI-compatible shape: choices[0].message.content ONLY. NEVER
        // touch choices[0].message.reasoning_content - the sensenova model
        // emits reasoning in a SEPARATE field and it must be ignored
        // (reasoning is not the reply; Task 17-a).
        const content = data?.choices?.[0]?.message?.content;
        return typeof content === "string" ? content : "";
      })();
      return raceWithGuards(request, guards, () => {
        try {
          controller.abort();
        } catch {
          // best-effort abort - the race outcome is already fixed
        }
      });
    },
  };
}
