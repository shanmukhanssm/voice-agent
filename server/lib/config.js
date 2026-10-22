/**
 * config.js - THE only module that reads env (architecture.md ss System
 * Boundaries: "no raw process.env reads outside server/lib/config.js").
 * Every other module imports config and never touches Bun.env directly.
 *
 * Exports:
 *   - config.env: the six optional vars, read exactly once at boot
 *   - config.runtimeSecret: 32 random bytes per boot (HMAC rate-limit keys)
 *   - config.appVersion: package.json version (surfaced by /api/health)
 *   - config.isDev: true unless NODE_ENV=production (Prisma globalThis cache)
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

/**
 * The seven optional env vars (code-standards.md ss Environment Variables).
 * INTERNAL_SETTINGS_TOKEN (feature 25, Task 19-a) guards the server-to-server
 * /internal/voice-config feed (main server :3000 <- voice-service :3003);
 * it is never sent by the browser and never logged.
 */
const rawEnv = Object.freeze({
  GROQ_API_KEY: Bun.env.GROQ_API_KEY,
  XKIRO_API_KEY: Bun.env.XKIRO_API_KEY,
  XKIRO_BASE_URL: Bun.env.XKIRO_BASE_URL,
  INTERNAL_SETTINGS_TOKEN: Bun.env.INTERNAL_SETTINGS_TOKEN,
  SUPABASE_URL: Bun.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: Bun.env.SUPABASE_SERVICE_ROLE_KEY,
  DATABASE_URL: Bun.env.DATABASE_URL,
});

/**
 * Shared server config. Frozen so no module can quietly swap values.
 * @typedef {object} ServerConfig
 * @property {Readonly<Record<string, string | undefined>>} env raw env values
 * @property {Buffer} runtimeSecret 32 random bytes regenerated each boot
 * @property {string} appVersion package.json version
 * @property {boolean} isDev NODE_ENV !== production
 */
export const config = Object.freeze({
  env: rawEnv,
  runtimeSecret: randomBytes(32),
  appVersion:
    typeof packageJson.version === "string" ? packageJson.version : "0.0.0",
  isDev: (Bun.env.NODE_ENV ?? "development") !== "production",
});
