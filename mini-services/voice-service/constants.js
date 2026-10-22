/**
 * constants.js - voice-service-owned canonical constants (feature 11).
 *
 * Per server/lib/constants.js header comment: VOICE_SERVICE_PORT,
 * SOCKET_TURN_BUDGET_MS, SOCKET_MSG_PER_SEC and AUDIO_CHUNK_MAX_BYTES are
 * OWNED here (the voice-service is an independent bun project and never
 * imports from server/). Caps mirror architecture.md "Voice Socket
 * Protocol" (single copy) and hardening.md H-C7 / H-E2.
 */

/** Port of the voice socket mini-service (gateway XTransformPort=3003). */
export const VOICE_SERVICE_PORT = 3003;

/** Rate limit: socket events per second per socket, across ALL events. */
export const SOCKET_MSG_PER_SEC = 40;

/** Rolling window for the sustained-abuse check (ms). */
export const SOCKET_RATE_WINDOW_MS = 1000;

/** H-E2 turn budget: VAD-end -> audio-back, wraps pipeline work (ms). */
export const SOCKET_TURN_BUDGET_MS = 30000;

/** Audio chunk cap: max base64 chars per utterance pcmBase64 (32 KB). */
export const AUDIO_CHUNK_MAX_BYTES = 32768;

/** Turn chunk store cap: max utterance chunks accumulated for one turn
 *  (feature 12 ASR). The client VAD ring holds 30 s (~40 chunks); chunks
 *  arriving beyond the cap are dropped and counted (memory bound, H-G4
 *  sizes-only posture). */
export const UTTERANCE_CHUNK_STORE_MAX = 64;

/** Feature 13 transcript memory cap per session (stored turns; beyond
 *  the cap the OLDEST turn is dropped - bounded history for the sales
 *  prompt, memory hygiene). */
export const TRANSCRIPT_MEMORY_MAX = 32;

/** Main-server origin for the /internal/voice-config pull (feature 25,
 *  Task 19-a): the voice-service fetches its runtime provider config from
 *  the main Bun server on localhost - the ONLY cross-service URL in this
 *  project (server-to-server, token-guarded; the browser never sees it). */
export const MAIN_SERVER_ORIGIN = "http://127.0.0.1:3000";
