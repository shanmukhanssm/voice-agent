/**
 * groq-llm.js - Groq LLM chain steps (feature 13; primary sales brain).
 *
 * ONE factory, TWO locked models (build-plan feature 13 chain order):
 *   makeGroqLlmStep("llama-3.1-8b-instant")     -> step name "groq-8b"  (fast path)
 *   makeGroqLlmStep("llama-3.3-70b-versatile")  -> step name "groq-70b"
 * Model names are PINNED (library-docs gotcha: models drift - never
 * "latest"); config.js imports GROQ_LLM_MODELS instead of restating them.
 *
 * Envelope per library-docs.md "Groq REST": OpenAI-compatible POST
 * {base}/chat/completions with { model, messages, stream: false },
 * Authorization Bearer. stream:false collects the FULL reply before
 * resolving - the streaming first-sentence handoff to TTS lands with
 * feature 14 (marked at the collection point below).
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
 * response body is never read, logged, or attached. ADR H-01: an ABSENT
 * GROQ_API_KEY is a mode, not an error - the factory returns null and
 * config.js simply omits the step. The key is passed in by
 * providers/config.js (the voice-service's SOLE env reader); this module
 * never reads env.
 */

import { makeAbortError, raceWithGuards } from "./abort-guard.js";

// Provenance: canonical pure constants owned by server/lib (single copy) -
// the Groq REST base lives ONLY here (feature 25, Task 19-a single-copy
// rule); LLM_TIMEOUT_MS bounds the interactive LLM hop (Task 20-a).
import { GROQ_BASE_URL, LLM_TIMEOUT_MS } from "../../../server/lib/constants.js";

const GROQ_LLM_URL = `${GROQ_BASE_URL}/chat/completions`;

/** Locked LLM models (build-plan feature 13 chain order; never "latest"). */
export const GROQ_LLM_MODELS = Object.freeze({
  fast: "llama-3.1-8b-instant",
  heavy: "llama-3.3-70b-versatile",
});

/** Chain step names for the locked models (logs + registry naming). */
const STEP_NAMES = Object.freeze({
  [GROQ_LLM_MODELS.fast]: "groq-8b",
  [GROQ_LLM_MODELS.heavy]: "groq-70b",
});

/**
 * Build one Groq LLM chain step for one assembled sales prompt.
 *
 * @param {string} model pinned Groq model name (GROQ_LLM_MODELS)
 * @param {{role: string, content: string}[]} messages OpenAI-style messages
 * @param {string} apiKey GROQ_API_KEY (from providers/config.js)
 * @param {AbortSignal} [externalSignal] whole-turn barge-in abort (Task 20-a)
 * @returns {{name: string, run: () => Promise<string>} | null} the step,
 *   or null when the key is absent (ADR H-01 - step not included)
 */
export function makeGroqLlmStep(model, messages, apiKey, externalSignal) {
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  return {
    name: STEP_NAMES[model] ?? "groq",
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
        const response = await fetch(GROQ_LLM_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({ model, messages, stream: false }),
        });
        if (!response.ok) {
          // H-G4: status code only - never read/log the provider body.
          const error = new Error(`groq llm failed with status ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        // FEATURE 14: the full-collection point - stream:true + first
        // sentence boundary handing off to TTS while generation continues
        // replaces this whole block (build-plan feature 13/14).
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
