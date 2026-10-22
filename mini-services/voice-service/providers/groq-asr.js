/**
 * groq-asr.js - Groq ASR chain step (feature 12; primary ASR provider).
 *
 * Envelope per library-docs.md "Groq REST": OpenAI-compatible
 * POST {GROQ_BASE_URL}/audio/transcriptions, multipart
 * FormData with the wav in the `file` field, model
 * "whisper-large-v3-turbo" (feature 25: the caller threads the
 * user-selected sttModel; the locked model stays the default),
 * AbortSignal.timeout(AI_TIMEOUT_MS) armed HERE
 * (Pattern P1: each step sets its own timer).
 *
 * ADR H-01: an ABSENT GROQ_API_KEY is a mode, not an error - the factory
 * returns null and config.js simply omits the step from the chain. The API
 * key is passed in by providers/config.js (the voice-service's SOLE env
 * reader); this module never reads env.
 *
 * H-G4: a non-OK response becomes an error carrying ONLY e.status - the
 * response body is never read, logged, or attached. Sandbox note (locked):
 * ALL Groq calls return 403 here (egress block) - 4xx hops to the next
 * chain member immediately (never retried, H-E3).
 */

import { aiTimeoutSignal } from "./chain.js";

// Provenance: canonical pure constants owned by server/lib (single copy) -
// the Groq REST base + the STT model list live ONLY there (feature 25,
// Task 19-a single-copy rule; the list's first entry is the locked default).
import { GROQ_BASE_URL, SETTINGS_STT_MODELS } from "../../../server/lib/constants.js";

const GROQ_ASR_URL = `${GROQ_BASE_URL}/audio/transcriptions`;

/**
 * Build the Groq ASR chain step for one utterance wav.
 *
 * @param {{buffer: Uint8Array}} wav assembled utterance wav (pcm-wav.js)
 * @param {string} apiKey GROQ_API_KEY (from providers/config.js)
 * @param {string} [model] Whisper model id (feature 25: the user-selected
 *   sttModel; defaults to the locked whisper-large-v3-turbo)
 * @returns {{name: string, run: () => Promise<string>} | null} the step,
 *   or null when the key is absent (ADR H-01 - step not included)
 */
export function createGroqAsrStep(wav, apiKey, model = SETTINGS_STT_MODELS[0]) {
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  const selectedModel =
    typeof model === "string" && model.length > 0 ? model : SETTINGS_STT_MODELS[0];
  return {
    name: "groq",
    /**
     * @returns {Promise<string>} the transcribed text, trimmed
     * @throws {Error} e.status = HTTP status code ONLY (body never read)
     */
    run: async () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([wav.buffer], { type: "audio/wav" }),
        "utterance.wav",
      );
      form.append("model", selectedModel);
      const response = await fetch(GROQ_ASR_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: aiTimeoutSignal(),
      });
      if (!response.ok) {
        // H-G4: status code only - never read/log the provider body.
        const error = new Error(`groq asr failed with status ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const data = await response.json();
      return typeof data?.text === "string" ? data.text.trim() : "";
    },
  };
}
