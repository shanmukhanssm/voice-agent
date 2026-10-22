/**
 * builtin-llm.js - built-in LLM chain step (feature 13; $0 fallback and,
 * since Task 20-a, the DEFAULT brain).
 *
 * z-ai-web-dev-sdk, per library-docs.md "z-ai-web-dev-sdk (built-in
 * ASR/LLM/TTS)": chat.completions.create({ messages, thinking: { type:
 * "disabled" } }) - thinking disabled is REQUIRED for low latency (the
 * measured ~646-702 ms full-reply figure was WITH it disabled); the reply
 * text is extracted as out.choices[0].message.content.
 *
 * SERVER-SIDE ONLY - this module lives in the voice-service providers and
 * is never imported from anything under public/. The ZAI client is
 * created once and memoized (library-docs Setup / Client Pattern).
 *
 * Task 20-a (latency + barge-in): the SDK call takes no abort signal, so
 * the step wraps it in abort-guard.js raceWithGuards - the same pattern
 * the TTS steps use:
 *   - AbortSignal.timeout(LLM_TIMEOUT_MS) (status 0): the SDK hop is
 *     bounded to <= 8 s (it was previously unbounded - Pattern P1 saw a
 *     hung SDK call as a hung chain);
 *   - the optional externalSignal (the whole-turn barge-in abort,
 *     threaded by config.js, status 499): rejects IMMEDIATELY even when
 *     pre-aborted, so the hop unwinds in ~0 ms and P1 never retries a
 *     4xx.
 * onCancel is a no-op: the SDK exposes no cancel hook (the losing SDK
 * promise stays attached to the race, so it can never surface as an
 * unhandled rejection; its result is discarded).
 *
 * Errors thrown by the SDK carry no HTTP status, so Pattern P1 sees
 * status 0 (network class) and retries/hops per H-E3.
 */

import ZAI from "z-ai-web-dev-sdk";
import { makeAbortError, raceWithGuards } from "./abort-guard.js";

// Provenance: canonical pure constant owned by server/lib (single copy).
import { LLM_TIMEOUT_MS } from "../../../server/lib/constants.js";

/** @type {object | null} memoized ZAI client (created once per process) */
let _zai = null;

/**
 * Memoized SDK client (library-docs Setup / Client Pattern).
 *
 * @returns {Promise<object>}
 */
export async function zai() {
  if (!_zai) _zai = await ZAI.create(); // init ~ 3 ms - cheap, but memoize anyway
  return _zai;
}

/**
 * Build the built-in LLM chain step for one assembled sales prompt.
 *
 * @param {{role: string, content: string}[]} messages chat-style messages
 * @param {AbortSignal} [externalSignal] whole-turn barge-in abort (Task 20-a)
 * @returns {{name: string, run: () => Promise<string>}}
 */
export function createBuiltinLlmStep(messages, externalSignal) {
  return {
    name: "builtin",
    /**
     * @returns {Promise<string>} the model reply text ("" when the
     *   provider reports no content - handled downstream as llm_empty)
     * @throws {Error} e.status = 0 (network/timeout) or 499 (barge-in)
     */
    run: async () => {
      // Pre-aborted (barge landed between chain steps): reject before the
      // SDK call even starts - the SDK exposes no cancel hook, so the only
      // way to keep a dead hop cost-free is to never start it.
      if (externalSignal?.aborted) {
        throw makeAbortError(499, "chain step aborted");
      }
      // The SDK call itself is wrapped (no cancel hook exists): the race
      // guarantees the step settles within LLM_TIMEOUT_MS, or instantly
      // on a barge-in abort. The losing SDK promise's outcome is ignored
      // (the race attached handlers, so it never becomes unhandled).
      const pending = (async () => {
        const out = await (await zai()).chat.completions.create({
          messages,
          thinking: { type: "disabled" }, // REQUIRED for low latency
        });
        const content = out?.choices?.[0]?.message?.content;
        return typeof content === "string" ? content : "";
      })();
      const guards = [{ signal: AbortSignal.timeout(LLM_TIMEOUT_MS), status: 0 }];
      if (externalSignal) guards.push({ signal: externalSignal, status: 499 });
      return raceWithGuards(pending, guards);
    },
  };
}
