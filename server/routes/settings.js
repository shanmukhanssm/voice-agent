/**
 * settings.js - settings REST routes + the internal voice-config feed
 * (feature 25, Task 19-a).
 *
 * Public API (registered in the server/index.js exact table; the ONE
 * envelope from server/lib/envelope.js applies to every response):
 *   GET  /api/settings       -> masked settings (last-4 hints ONLY, never keys)
 *   PUT  /api/settings       -> validate SETTINGS_PATCH_SCHEMA -> upsert the
 *                               singleton row -> masked settings back
 *   POST /api/settings/test  -> ONE live LLM ping through the EFFECTIVE
 *                               provider; the RESULT carries ok:false on
 *                               failure (status 200 either way - a failed
 *                               test is data, not an HTTP error)
 *
 * Internal feed (NOT in the /api table; a dedicated branch in the fetch
 * handler BEFORE /api dispatch and BEFORE static serving):
 *   GET  /internal/voice-config -> FULL effective settings (keys included)
 *                               for the voice-service only, guarded by the
 *                               INTERNAL_SETTINGS_TOKEN compared in constant
 *                               time (sha256 digests + timingSafeEqual, so
 *                               length differences cannot throw or leak).
 *                               Missing token on either side -> 403. The
 *                               gateway blocks /internal/* at the edge
 *                               (Caddyfile responds 403 before :3000); the
 *                               token check is the second, in-process gate.
 *
 * Rate limiting: PUT + test use the shared "write" tier (30/min/IP) - the
 * same posture POST /api/calls uses for mutations. The internal feed is
 * token-guarded server-to-server traffic (no client tier).
 *
 * The live-ping business rule (testLlm) lives in server/lib/settings.js -
 * this handler stays thin (architecture.md invariant: business rules live
 * in server/lib/, never in handlers). H-G4: provider response bodies are
 * never read/logged/attached anywhere in this module - status codes,
 * timings and booleans only. Full keys are never logged and never echoed
 * to any client.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../lib/config.js";
import { respond, withRoute, SECURITY_HEADERS } from "../lib/envelope.js";
import { log } from "../lib/log.js";
import { SETTINGS_PATCH_SCHEMA } from "../lib/validation.js";
import {
  getEffectiveSettings,
  getSettingsRow,
  maskedSettings,
  saveSettings,
  testLlm,
} from "../lib/settings.js";

/** Log tag shared by the settings routes. */
const ROUTE = "settings";

/** sha256 digest as the constant-time compare domain (fixed 32 bytes). */
function sha256(value) {
  return createHash("sha256").update(value).digest();
}

/**
 * Constant-time token compare: BOTH sides are hashed first, so
 * timingSafeEqual always sees equal-length buffers (a raw compare would
 * throw on length mismatch - and length itself is not a secret worth
 * leaking). Absent token on either side -> false.
 *
 * @param {string | null} provided x-internal-token header value
 * @param {string | undefined} expected INTERNAL_SETTINGS_TOKEN
 * @returns {boolean}
 */
function internalTokenMatches(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  if (typeof expected !== "string" || expected.length === 0) return false;
  try {
    return timingSafeEqual(sha256(provided), sha256(expected));
  } catch {
    return false;
  }
}

/**
 * GET /api/settings - the masked view (never a full key).
 */
async function getSettingsHandler() {
  const row = await getSettingsRow();
  return respond({ status: 200, data: maskedSettings(await getEffectiveSettings(), row) });
}

/**
 * PUT /api/settings - validate (SETTINGS_PATCH_SCHEMA; a failure is the
 * shared 400 ValidationError envelope carrying fieldErrors with the field
 * NAMES only - the closed taxonomy's code, no per-field prose echoed) ->
 * upsert -> the refreshed masked view.
 */
async function putSettingsHandler({ body }) {
  await saveSettings(body);
  const row = await getSettingsRow();
  return respond({ status: 200, data: maskedSettings(await getEffectiveSettings(), row) });
}

/**
 * POST /api/settings/test - 200 even when the ping fails (the RESULT
 * carries ok:false; a failed test is never an HTTP error). No keys in the
 * response - provider/model/ms/reason/status only. The ping itself is
 * testLlm() in server/lib/settings.js.
 */
async function testSettingsHandler() {
  const result = await testLlm(await getEffectiveSettings());
  return respond({ status: 200, data: result });
}

export const getSettingsRoute = withRoute({
  route: ROUTE,
  tier: "read",
  handler: getSettingsHandler,
});

export const putSettingsRoute = withRoute({
  route: ROUTE,
  tier: "write",
  schema: SETTINGS_PATCH_SCHEMA,
  handler: putSettingsHandler,
});

export const testSettingsRoute = withRoute({
  route: ROUTE,
  tier: "write",
  handler: testSettingsHandler,
});

/** Plain { ok: false } JSON with the security headers (no detail - the 403
 *  must not reveal whether the path, method or token failed). */
function internalForbidden() {
  return new Response(JSON.stringify({ ok: false }), {
    status: 403,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * GET /internal/voice-config - the server-to-server runtime provider feed
 * for the voice-service (it PULLS from the main server; the main server
 * never pushes). GET only (anything else is the same bare 403);
 * token-guarded (constant-time compare) and gateway-blocked (Caddy answers
 * 403 for /internal/* before :3000; the browser never holds the token).
 * Success returns the FULL effective settings - keys included - which is
 * why this handler is reachable ONLY with the shared secret.
 *
 * @param {Request} req
 * @returns {Promise<Response>}
 */
export async function internalVoiceConfigRoute(req) {
  if (req.method !== "GET") {
    log(ROUTE, "internal_voice_config_denied");
    return internalForbidden();
  }
  const token = req.headers.get("x-internal-token");
  if (!internalTokenMatches(token, config.env.INTERNAL_SETTINGS_TOKEN)) {
    log(ROUTE, "internal_voice_config_denied");
    return internalForbidden();
  }
  const data = await getEffectiveSettings();
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
    },
  });
}
