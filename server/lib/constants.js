/**
 * constants.js - server-owned Canonical Constants (code-standards.md table).
 * These numbers NEVER appear inline anywhere else; import by name.
 * (PRODUCT_BRIEF lives in product-brief.js; VOICE_SERVICE_PORT,
 * SOCKET_TURN_BUDGET_MS, SOCKET_MSG_PER_SEC and AUDIO_CHUNK_MAX_BYTES are
 * owned by mini-services/voice-service.)
 */

/** Turn latency target: prospect stops talking -> bot voice starts (ms). */
export const TURN_LATENCY_TARGET_MS = 1500;

/** End-Call -> summary/status visible budget (ms). */
export const SUMMARY_BUDGET_MS = 15000;

/** AI provider call timeout per stage (ms). */
export const AI_TIMEOUT_MS = 20000;

/**
 * Interactive voice LLM hop timeout per step (ms). Task 20-a: a stalled
 * hosted LLM attempt must cost <= 8 s before the Pattern P1 hop, not the
 * 20 s AI_TIMEOUT_MS (a stalled xkiro attempt otherwise burns 20 s x 3 P1
 * attempts + backoff sleeps and stalls the per-session turn queue).
 * LLM chain steps arm this as their own guard; ASR/TTS steps keep
 * AI_TIMEOUT_MS.
 */
export const LLM_TIMEOUT_MS = 8000;

/** DB query timeout budget (ms). */
export const DB_TIMEOUT_MS = 5000;

/** Recording upload timeout (ms). */
export const UPLOAD_TIMEOUT_MS = 10000;

/** Recording upload hard cap: 20 MB (bytes). */
export const RECORDING_MAX_BYTES = 20971520;

/** JSON body cap for generic API routes (bytes). */
export const MAX_BODY_BYTES = 1048576;

/** JSON body cap for the turns relay route (bytes). */
export const MAX_TURN_BODY_BYTES = 8192;

/** Bot speech text cap before TTS (chars). */
export const TURN_TEXT_MAX = 600;

/** Normalized transcript text cap in the DB layer (chars). */
export const TURN_TEXT_DB_MAX = 4000;

/** Prior turns included in the sales prompt. */
export const TRANSCRIPT_TURN_DEPTH = 6;

/** Byte cap on raw LLM summary output before parsing (bytes). */
export const SUMMARY_MAX_BYTES = 65536;

/** Rate limit: write routes per minute per IP. */
export const RATE_WRITE_PER_MIN = 30;

/** Rate limit: turn-relay routes per minute per IP (turns arrive per
 *  utterance during a call - hardening.md Trust-Boundary row 8). */
export const RATE_TURNS_PER_MIN = 120;

/** Rate limit: read routes per minute per IP. */
export const RATE_READ_PER_MIN = 120;

/** Rate limit: upload routes per minute per IP. */
export const RATE_UPLOAD_PER_MIN = 10;

/** AI quota: bot turns per hour per IP (checked BEFORE provider spend). */
export const AI_QUOTA_TURNS_PER_HOUR = 60;

/** Barge-in: TTS playback must stop within this budget (ms). */
export const BARGE_IN_STOP_MS = 300;

/** Retry backoff ladder for safe retries (ms), + jitter, max 3 attempts. */
export const RETRY_BACKOFF_MS = [1000, 2000, 4000];

/** History list hard cap. */
export const HISTORY_LIST_MAX = 50;

/** Consent form time-trap: submissions faster than this are rejected (ms). */
export const TIME_TRAP_MS = 1200;

/** Voice-service /healthz reachability probe budget for /api/health (ms). */
export const VOICE_PROBE_TIMEOUT_MS = 2000;

/* -- Settings feature (feature 25, Task 19-a) shared constants -------------
   The model/voice suggestion lists are canonical here (single copy): the
   settings Zod boundary (server/lib/validation.js), the settings routes and
   the voice-service chain resolvers import them instead of restating. */

/** LLM model suggestion list (free-form input; these are the suggested rows). */
export const SETTINGS_LLM_MODELS = Object.freeze([
  "sensenova/sensenova-6.8-flash-lite",
  "qwen/qwen3-omni-flash:free",
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
]);

/** STT model picker list (Groq Whisper models; closed set). */
export const SETTINGS_STT_MODELS = Object.freeze([
  "whisper-large-v3-turbo",
  "whisper-large-v3",
]);

/** TTS voice picker list (Edge-TTS en-US neural voices; closed set).
 *  Task 21-b: the Multilingual Andrew variant is the first entry (= the
 *  settings default via DEFAULT_TTS_VOICE) - probed 2026-10-22 with the
 *  shipped +8%/+2Hz prosody (ok, faster than plain AndrewNeural); the
 *  plain AndrewNeural stays selectable. */
export const SETTINGS_TTS_VOICES = Object.freeze([
  "en-US-AndrewMultilingualNeural",
  "en-US-AndrewNeural",
  "en-US-AriaNeural",
  "en-US-EmmaNeural",
  "en-US-BrianNeural",
  "en-US-JennyNeural",
]);

/** Default Groq REST base URL (single copy - groq-asr.js / groq-llm.js /
 *  summary-llm.js / the settings test route import it; never restate). */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** Default Xkiro base URL (single copy - settings.js + summary-llm.js +
 *  the voice-service resolvers import it; env XKIRO_BASE_URL overrides). */
export const XKIRO_DEFAULT_BASE_URL = "https://api.xkiro.com/v1";

/** Voice-service -> main-server /internal/voice-config fetch budget (ms). */
export const INTERNAL_CONFIG_TIMEOUT_MS = 2500;

/** Live LLM ping budget for POST /api/settings/test (ms). */
export const SETTINGS_TEST_TIMEOUT_MS = 12000;
