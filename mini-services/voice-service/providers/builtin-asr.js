/**
 * builtin-asr.js - built-in ASR chain step (feature 12; $0 fallback).
 *
 * z-ai-web-dev-sdk, per library-docs.md "z-ai-web-dev-sdk (built-in
 * ASR/LLM/TTS)": `zai().audio.asr.create({ file_base64 })` with the WHOLE
 * utterance wav base64'd. SERVER-SIDE ONLY - this module lives in the
 * voice-service providers and is never imported from anything under
 * public/. The ZAI client is created once and memoized (init is cheap but
 * the pattern memoizes anyway). No thinking flag is needed for ASR (that
 * is an LLM-only latency knob).
 *
 * Errors thrown by the SDK carry no HTTP status, so Pattern P1 sees
 * status 0 (network class) and retries/hops per H-E3.
 */

import ZAI from "z-ai-web-dev-sdk";

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
 * Build the built-in ASR chain step for one utterance wav.
 *
 * @param {{toBase64: () => string}} wav assembled utterance wav (pcm-wav.js)
 * @returns {{name: string, run: () => Promise<string>}}
 */
export function createBuiltinAsrStep(wav) {
  return {
    name: "builtin",
    /**
     * @returns {Promise<string>} the transcribed text, trimmed ("" when the
     *   provider reports no text - handled downstream as asr_empty)
     */
    run: async () => {
      const asr = await (await zai()).audio.asr.create({
        file_base64: wav.toBase64(),
      });
      return typeof asr?.text === "string" ? asr.text.trim() : "";
    },
  };
}
