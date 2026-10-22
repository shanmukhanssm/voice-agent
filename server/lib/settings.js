/**
 * settings.js - the ONE settings brain for the main server (feature 25,
 * Task 19-a). Resolution order everywhere:
 *
 *     Settings-DB value ?? .env value ?? built-in default
 *
 * so a saved Setting takes effect from the NEXT call with no process
 * restart, while the zero-config boot keeps working (ADR H-01: absence is
 * a mode). The Setting row is a singleton (id "global", see
 * prisma/schema.prisma); reads are upsert-free - a missing row simply
 * means "everything resolves from env/defaults".
 *
 * Exports: getSettingsRow(), getEffectiveSettings(), maskedSettings(),
 * saveSettings(patch) and testLlm(effective) - the ONE live LLM ping
 * behind POST /api/settings/test (provider chosen BY the effective
 * llmProvider; ONE attempt, SETTINGS_TEST_TIMEOUT_MS budget).
 *
 * SECURITY (H-C4/H-G4 posture):
 *   - getEffectiveSettings() carries FULL key values and stays
 *     server-side; its consumers are the summary provider config, the
 *     /api/settings/test ping and the token-guarded
 *     /internal/voice-config feed (server-to-server only).
 *   - maskedSettings() is the ONLY client-facing shape: provider/model/
 *     voice values, the resolved Xkiro base URL, last-4 key hints and
 *     booleans. Full keys are NEVER included in any /api response.
 *   - Key values are never logged (log lines carry booleans/hints only).
 *
 * DB-read failure degrades honestly: the read returns null (logged, never
 * thrown) so env/default resolution still answers - the same fail-soft
 * posture the /api/health probe uses.
 */

import { db } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { builtinCompletion } from "./builtin-completion.js";
import {
  SETTINGS_STT_MODELS,
  SETTINGS_LLM_MODELS,
  SETTINGS_TTS_VOICES,
  SETTINGS_TEST_TIMEOUT_MS,
  XKIRO_DEFAULT_BASE_URL,
  GROQ_BASE_URL,
} from "./constants.js";

/** Singleton row id (prisma/schema.prisma Setting @default("global")). */
const SETTINGS_ROW_ID = "global";

// First entry of each canonical list IS the built-in default (single copy).
// Task 20-a: the LLM provider default flips to "builtin" (measured
// 2026-10-22: builtin ~0.7 s per reply vs the sensenova reasoning model at
// 5.5-8.8 s - incompatible with the 1.5-2 s turn target); Xkiro/Groq stay
// selectable in Settings. The llmModel default stays the suggestion list's
// first entry (the model only matters once a hosted provider is selected).
const DEFAULT_STT_PROVIDER = "builtin";
const DEFAULT_STT_MODEL = SETTINGS_STT_MODELS[0];
const DEFAULT_LLM_PROVIDER = "builtin";
const DEFAULT_LLM_MODEL = SETTINGS_LLM_MODELS[0];
const DEFAULT_TTS_VOICE = SETTINGS_TTS_VOICES[0];

/**
 * Effective settings shape (FULL keys - server-side only).
 *
 * @typedef {object} EffectiveSettings
 * @property {string} sttProvider "builtin" | "groq"
 * @property {string} sttModel Groq Whisper model id
 * @property {string} llmProvider "xkiro" | "groq" | "builtin"
 * @property {string} llmModel free-form model id
 * @property {string} ttsVoice Edge-TTS voice name
 * @property {string} groqApiKey full key or ""
 * @property {string} xkiroApiKey full key or ""
 * @property {string} xkiroBaseUrl resolved base URL
 */

/**
 * Client-safe masked shape (never carries a full key).
 *
 * @typedef {object} MaskedSettings
 * @property {string} sttProvider
 * @property {string} sttModel
 * @property {string} llmProvider
 * @property {string} llmModel
 * @property {string} ttsVoice
 * @property {string} xkiroBaseUrl
 * @property {string | null} groqKeyHint last 4 chars of the resolved key
 * @property {string | null} xkiroKeyHint last 4 chars of the resolved key
 * @property {boolean} hasGroqKey
 * @property {boolean} hasXkiroKey
 * @property {boolean} envGroqKey .env provides GROQ_API_KEY
 * @property {boolean} envXkiroKey .env provides XKIRO_API_KEY
 * @property {boolean} dbGroqKey the Setting row stores a Groq key (drives
 *   the UI's "Clear saved key" affordance)
 * @property {boolean} dbXkiroKey the Setting row stores an Xkiro key
 */

/**
 * Upsert-free read of the singleton Setting row. Any read failure is
 * logged and reads as "no row" (degraded mode: env/defaults still resolve).
 *
 * @returns {Promise<object | null>} the Setting row or null
 */
export async function getSettingsRow() {
  try {
    return await db.setting.findUnique({ where: { id: SETTINGS_ROW_ID } });
  } catch (e) {
    log("settings", "settings_row_read_failed - env/default resolution", {
      name: e instanceof Error ? e.name : "unknown",
    });
    return null;
  }
}

/**
 * Resolve the effective settings: Settings-DB ?? .env ?? default. FULL key
 * values - server-side only, never returned to a client.
 *
 * @returns {Promise<EffectiveSettings>}
 */
export async function getEffectiveSettings() {
  const row = await getSettingsRow();
  return {
    sttProvider: row?.sttProvider || DEFAULT_STT_PROVIDER,
    sttModel: row?.sttModel || DEFAULT_STT_MODEL,
    llmProvider: row?.llmProvider || DEFAULT_LLM_PROVIDER,
    llmModel: row?.llmModel || DEFAULT_LLM_MODEL,
    ttsVoice: row?.ttsVoice || DEFAULT_TTS_VOICE,
    groqApiKey: row?.groqApiKey || config.env.GROQ_API_KEY || "",
    xkiroApiKey: row?.xkiroApiKey || config.env.XKIRO_API_KEY || "",
    xkiroBaseUrl:
      row?.xkiroBaseUrl || config.env.XKIRO_BASE_URL || XKIRO_DEFAULT_BASE_URL,
  };
}

/** Last-4 hint for a masked key display; null when the key is absent. */
function keyHint(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(-4) : null;
}

/**
 * Project the effective settings to the ONLY client-facing shape. Full
 * keys never pass through this function's output (last-4 hints only).
 * The optional row (getSettingsRow()) adds the two DB-presence booleans
 * the UI needs to show "Clear saved key" ONLY when a key is DB-saved
 * (an env-provided key cannot be cleared from the UI).
 *
 * @param {EffectiveSettings} effective
 * @param {object | null} [row] the singleton Setting row (or null)
 * @returns {MaskedSettings}
 */
export function maskedSettings(effective, row = null) {
  return {
    sttProvider: effective.sttProvider,
    sttModel: effective.sttModel,
    llmProvider: effective.llmProvider,
    llmModel: effective.llmModel,
    ttsVoice: effective.ttsVoice,
    xkiroBaseUrl: effective.xkiroBaseUrl,
    groqKeyHint: keyHint(effective.groqApiKey),
    xkiroKeyHint: keyHint(effective.xkiroApiKey),
    hasGroqKey: Boolean(effective.groqApiKey),
    hasXkiroKey: Boolean(effective.xkiroApiKey),
    envGroqKey: Boolean(config.env.GROQ_API_KEY),
    envXkiroKey: Boolean(config.env.XKIRO_API_KEY),
    dbGroqKey: Boolean(row?.groqApiKey),
    dbXkiroKey: Boolean(row?.xkiroApiKey),
  };
}

/**
 * Persist one validated patch onto the singleton row (upsert). Key-field
 * semantics (groqApiKey / xkiroApiKey / xkiroBaseUrl):
 *   - field absent/undefined -> keep the existing value (create: null)
 *   - "" (empty string)      -> clear (null)
 *   - non-empty string       -> trim + set (the Zod boundary already trims)
 * Non-key fields are set directly after validation; absent non-key fields
 * keep the existing value (create: the built-in default).
 *
 * @param {Record<string, string | undefined>} patch validated
 *   SETTINGS_PATCH_SCHEMA output
 * @returns {Promise<object>} the saved Setting row
 */
export async function saveSettings(patch) {
  const existing = await db.setting.findUnique({ where: { id: SETTINGS_ROW_ID } });

  /** @type {Record<string, string | null>} */
  const data = {
    sttProvider: existing?.sttProvider ?? DEFAULT_STT_PROVIDER,
    sttModel: existing?.sttModel ?? DEFAULT_STT_MODEL,
    llmProvider: existing?.llmProvider ?? DEFAULT_LLM_PROVIDER,
    llmModel: existing?.llmModel ?? DEFAULT_LLM_MODEL,
    ttsVoice: existing?.ttsVoice ?? DEFAULT_TTS_VOICE,
    groqApiKey: existing?.groqApiKey ?? null,
    xkiroApiKey: existing?.xkiroApiKey ?? null,
    xkiroBaseUrl: existing?.xkiroBaseUrl ?? null,
  };
  if (patch.sttProvider !== undefined) data.sttProvider = patch.sttProvider;
  if (patch.sttModel !== undefined) data.sttModel = patch.sttModel;
  if (patch.llmProvider !== undefined) data.llmProvider = patch.llmProvider;
  if (patch.llmModel !== undefined) data.llmModel = patch.llmModel;
  if (patch.ttsVoice !== undefined) data.ttsVoice = patch.ttsVoice;
  if (patch.groqApiKey !== undefined) {
    data.groqApiKey = patch.groqApiKey === "" ? null : patch.groqApiKey;
  }
  if (patch.xkiroApiKey !== undefined) {
    data.xkiroApiKey = patch.xkiroApiKey === "" ? null : patch.xkiroApiKey;
  }
  if (patch.xkiroBaseUrl !== undefined) {
    data.xkiroBaseUrl = patch.xkiroBaseUrl === "" ? null : patch.xkiroBaseUrl;
  }

  const row = await db.setting.upsert({
    where: { id: SETTINGS_ROW_ID },
    update: data,
    create: { id: SETTINGS_ROW_ID, ...data },
  });
  log("settings", "settings_saved", {
    hasGroqKey: Boolean(row.groqApiKey),
    hasXkiroKey: Boolean(row.xkiroApiKey),
  });
  return row;
}

/**
 * The one live-ping prompt (fixed; the reply text is never surfaced).
 * Production-shaped ON PURPOSE: the locked sensenova model is a reasoning
 * model whose terse-ping answers can land entirely in its reasoning
 * channel (empty content, finish_reason stop - probed live 2026-10-22),
 * while real conversation prompts (full system prompt + product brief)
 * produce normal content (worklog Tasks 17-a/18-test). A ping that
 * resembles a real turn therefore tests what the call will actually do.
 */
const TEST_PROMPT =
  "You are Avery, a friendly SaaS sales rep. The customer just said hello. " +
  "Greet them back in one short sentence.";

/**
 * ONE live LLM ping through the EFFECTIVE provider - the POST
 * /api/settings/test body (business rule lives here in lib/, the route
 * handler stays thin). NEVER throws; the RESULT carries ok:false with a
 * reason class - a failed test is data, never an HTTP error.
 *
 *   xkiro   -> {baseUrl: effective.xkiroBaseUrl} + xkiroApiKey
 *   groq    -> {baseUrl: GROQ_BASE_URL} + groqApiKey
 *   builtin -> z-ai-web-dev-sdk (server/lib/builtin-completion.js)
 *
 * Request envelope per library-docs.md (Xkiro/Groq REST): OpenAI-compatible
 * POST {baseUrl}/chat/completions, Bearer auth, { model, messages,
 * stream: false } and NO max_tokens (reasoning models return empty content
 * when it is present - verified gotcha, worklog Task 17-a). The reply text
 * is read from choices[0].message.content ONLY - reasoning_content's VALUE
 * is never read, used, or logged; for a reasoning-only HTTP 200 response
 * (empty content, non-empty reasoning channel) only the PRESENCE of that
 * channel is checked (a boolean) to classify the ping as reached-ok.
 * H-G4: provider response bodies are never read/logged/attached - status
 * codes, timings and booleans only; keys never appear in logs or results.
 *
 * @param {EffectiveSettings} effective resolved settings (FULL keys)
 * @returns {Promise<{ ok: true, provider: string, model: string, ms: number } | { ok: false, provider: string, model: string, reason: string, status: number }>}
 */
export async function testLlm(effective) {
  const provider = effective.llmProvider;
  const model = effective.llmModel;
  const startedMonoMs = Math.round(performance.now());

  if (provider === "builtin") {
    const out = await builtinCompletion(
      [{ role: "user", content: TEST_PROMPT }],
      "settings",
    );
    const ms = Math.round(performance.now()) - startedMonoMs;
    if (!out.ok) {
      return {
        ok: false,
        provider,
        model,
        // SDK errors surface in the network class (provider unreachable);
        // an empty reply is its own honest class.
        reason: out.reason === "empty" ? "empty" : "network",
        status: 0,
      };
    }
    return { ok: true, provider, model, ms };
  }

  const apiKey =
    provider === "groq" ? effective.groqApiKey : effective.xkiroApiKey;
  const baseUrl = provider === "groq" ? GROQ_BASE_URL : effective.xkiroBaseUrl;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    log("settings", "settings_test_unconfigured", { provider });
    return { ok: false, provider, model, reason: "unconfigured", status: 0 };
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: TEST_PROMPT }],
        stream: false,
        // NO max_tokens - see the module-level envelope note above.
      }),
      signal: AbortSignal.timeout(SETTINGS_TEST_TIMEOUT_MS),
    });
    const ms = Math.round(performance.now()) - startedMonoMs;
    if (!res.ok) {
      // H-G4: status code only - the body is never read/logged/attached.
      log("settings", "settings_test_http_error", { provider, status: res.status });
      return { ok: false, provider, model, reason: "http", status: res.status };
    }
    const payload = await res.json();
    // content ONLY - never reasoning_content (Task 17-a).
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      log("settings", "settings_test_bad_shape", { provider });
      return { ok: false, provider, model, reason: "shape", status: res.status };
    }
    if (content.trim().length === 0) {
      // Reasoning-model posture (see TEST_PROMPT note): an HTTP 200 with a
      // valid chat shape whose answer landed in the reasoning channel still
      // proves key + endpoint + model work. Presence check ONLY - the
      // reasoning value is never read, used, or logged (H-G4).
      const message = payload?.choices?.[0]?.message;
      const reasoningOnly =
        typeof message?.reasoning_content === "string" &&
        message.reasoning_content.length > 0;
      if (reasoningOnly) {
        log("settings", "settings_test_reasoning_only_ok", { provider, ms });
        return { ok: true, provider, model, ms };
      }
      log("settings", "settings_test_empty_content", { provider });
      return { ok: false, provider, model, reason: "empty", status: res.status };
    }
    log("settings", "settings_test_ok", { provider, ms });
    return { ok: true, provider, model, ms };
  } catch (e) {
    const ms = Math.round(performance.now()) - startedMonoMs;
    log("settings", "settings_test_network_error", {
      provider,
      ms,
      name: e instanceof Error ? e.name : "unknown",
    });
    return { ok: false, provider, model, reason: "network", status: 0 };
  }
}
