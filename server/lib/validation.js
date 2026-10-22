/**
 * validation.js - the Zod boundary schemas for the call-persistence REST API
 * (features 17/19; hardening.md ss Trust-Boundary Map rows 2/3/7/8).
 *
 * SUMMARY_JSON_SCHEMA is the Zod twin of the SUMMARY_JSON_SCHEMA single copy
 * in context/build-plan.md feature 19 and must match field-for-field
 * (required keys exactly the five, no additional properties, maxLengths
 * 600/400/400/400, closed salesStatus enum). Never trim/repair overlong
 * values - a validator failure means the LLM output is rejected (H-G1).
 *
 * Strictness posture: strictObject everywhere - unknown keys are a 400, not
 * silently dropped payload (H-C1). Turn text is normalized (trimmed) and its
 * length is checked AFTER the trim (1..TURN_TEXT_DB_MAX chars).
 */
import { z } from "zod";
import { TURN_TEXT_DB_MAX, SETTINGS_STT_MODELS, SETTINGS_TTS_VOICES } from "./constants.js";

/**
 * Client-generated call id (idempotency key, H-B7). UUID v4 shape only -
 * version nibble 4 and a RFC 4122 variant nibble are both enforced.
 */
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** POST /api/calls - consent is a literal true or the request is a 400. */
export const CALL_CREATE_SCHEMA = z.strictObject({
  submissionId: z.string().regex(UUID_V4_PATTERN, "submissionId must be a UUID v4 string."),
  consent: z.literal(true),
});

/** POST /api/calls/:submissionId/turns - one relayed socket turn:final. */
export const TURN_SCHEMA = z.strictObject({
  idx: z.number().int().min(0).max(500),
  role: z.enum(["user", "bot"]),
  text: z.string().trim().min(1).max(TURN_TEXT_DB_MAX),
});

/** POST /api/calls/:submissionId/summary - body is optional; defaults to 0. */
export const SUMMARY_REQUEST_SCHEMA = z.strictObject({
  durationSec: z.number().int().min(0).max(14400).default(0),
});

/**
 * Zod twin of SUMMARY_JSON_SCHEMA (build-plan.md feature 19 single copy).
 * strictObject = "additionalProperties": false; every key required.
 */
export const SUMMARY_JSON_SCHEMA = z.strictObject({
  summary: z.string().max(600),
  requirements: z.string().max(400),
  objections: z.string().max(400),
  nextSteps: z.string().max(400),
  salesStatus: z.enum([
    "Converted",
    "Interested",
    "Follow-up Required",
    "Not Interested",
    "Demo Requested",
    "No Response",
  ]),
});

/**
 * LLM model ids are free-form (a user may type any model their provider
 * supports) but stay URL-path-safe: word chars, dot, underscore, colon,
 * slash, hyphen. 1..120 chars after the trim.
 */
const LLM_MODEL_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/**
 * PUT /api/settings patch (feature 25, Task 19-a). Every field optional
 * (absent = keep the stored value); unknown keys are a 400 (strictObject).
 * Key fields (groqApiKey / xkiroApiKey / xkiroBaseUrl) are trimmed strings
 * where "" means "clear the stored value"; full keys never echo back.
 */
export const SETTINGS_PATCH_SCHEMA = z.strictObject({
  sttProvider: z.enum(["builtin", "groq"]).optional(),
  sttModel: z.enum(SETTINGS_STT_MODELS).optional(),
  llmProvider: z.enum(["xkiro", "groq", "builtin"]).optional(),
  llmModel: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(LLM_MODEL_PATTERN, "llmModel must be a model id (letters, digits, dot, underscore, colon, slash, hyphen).")
    .optional(),
  ttsVoice: z.enum(SETTINGS_TTS_VOICES).optional(),
  xkiroBaseUrl: z
    .string()
    .trim()
    .max(200)
    .refine((value) => {
      if (value === "") return true; // "" = clear (fall back to env/default)
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, "xkiroBaseUrl must be a URL-shaped value (or \"\" to clear).")
    .optional(),
  groqApiKey: z.string().trim().max(300).optional(),
  xkiroApiKey: z.string().trim().max(300).optional(),
});
