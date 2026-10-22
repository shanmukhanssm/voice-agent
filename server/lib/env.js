/**
 * env.js - ADR H-01 boot validation over the seven optional vars.
 *
 * MALFORMED (bad URL shape for XKIRO_BASE_URL / SUPABASE_URL / DATABASE_URL;
 * empty string where a string is declared for GROQ_API_KEY / XKIRO_API_KEY /
 * INTERNAL_SETTINGS_TOKEN / SUPABASE_SERVICE_ROLE_KEY) -> throw at boot
 * NAMING the variable. MISSING -> warn exactly once and continue: the
 * zero-keys boot is a locked invariant and the provider fallback chains are
 * the designed degraded mode. An absent INTERNAL_SETTINGS_TOKEN is degraded
 * mode too: /internal/voice-config answers 403 and the voice-service keeps
 * its .env-only resolution.
 */
import { config } from "./config.js";
import { log } from "./log.js";

/** Vars whose value must be URL-shaped when present. */
const URL_VARS = ["XKIRO_BASE_URL", "SUPABASE_URL", "DATABASE_URL"];

/** Vars whose value must be a non-empty string when present. */
const STRING_VARS = [
  "GROQ_API_KEY",
  "XKIRO_API_KEY",
  "INTERNAL_SETTINGS_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const ALL_VARS = [
  "GROQ_API_KEY",
  "XKIRO_API_KEY",
  "XKIRO_BASE_URL",
  "INTERNAL_SETTINGS_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
];

let warnedOnce = false;

/** True when the value carries a scheme prefix (file:./x, postgres://...). */
function hasScheme(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

/** Per-var URL-shape check. */
function urlShaped(name, value) {
  if (name === "DATABASE_URL") {
    // file:./db/custom.db (sandbox) or postgres://... (deploy switch)
    return hasScheme(value);
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the seven optional vars per ADR H-01. Throws (naming the variable)
 * on malformed values; warns exactly once on missing keys; never throws for
 * absent keys. Call once at boot, before Bun.serve.
 * @returns {Record<string, boolean>} the env completeness map
 */
export function validateEnv() {
  const malformed = [];
  for (const name of ALL_VARS) {
    const value = config.env[name];
    if (value === undefined) continue; // missing -> warn path below
    if (URL_VARS.includes(name)) {
      if (value.trim() === "" || !urlShaped(name, value)) {
        malformed.push(`${name} is malformed (expected a URL-shaped value)`);
      }
    } else if (STRING_VARS.includes(name) && value === "") {
      malformed.push(`${name} is malformed (empty string where a string is declared)`);
    }
  }
  if (malformed.length > 0) {
    throw new Error(`Boot aborted - malformed environment: ${malformed.join("; ")}`);
  }

  const missing = ALL_VARS.filter((name) => config.env[name] === undefined);
  if (missing.length > 0 && !warnedOnce) {
    warnedOnce = true;
    log("env", "missing optional vars - degraded mode (fallback chains cover them)", {
      missing,
    });
  }
  return envComplete();
}

/**
 * Completeness map for /api/health (booleans only - no values, no hostnames).
 * @returns {Record<string, boolean>} true when the var is present and non-empty
 */
export function envComplete() {
  return Object.fromEntries(
    ALL_VARS.map((name) => {
      const value = config.env[name];
      return [name, value !== undefined && value !== ""];
    }),
  );
}
