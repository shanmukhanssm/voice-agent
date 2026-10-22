#!/usr/bin/env bun
// env-guard.mjs - keeps .env in sync with .env.canonical.
//
// Why: the sandbox boot (platform start.sh) rewrites .env at every container
// start down to DATABASE_URL-only, wiping XKIRO_API_KEY, XKIRO_BASE_URL and
// INTERNAL_SETTINGS_TOKEN (seen twice, worklog Task 22 / 22-b). The
// gitignored .env.canonical is the source of truth; this guard restores .env
// atomically (write .env.tmp then rename) whenever any canonical key is
// missing or its value differs.
//
// Safety rules:
// - Never logs secret values - at most key names plus "restored"/"ok".
// - Missing canonical file -> exit 1 with a clear warning, never blocks boot
//   (every boot path wires this script with "|| true").
//
// Usage: bun scripts/env-guard.mjs [--selftest]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const CANONICAL = path.join(ROOT, ".env.canonical");
const ENV_FILE = path.join(ROOT, ".env");

const silentLog = { log: () => {}, error: () => {} };

function parseEnv(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!map.has(key)) map.set(key, line.slice(eq + 1).trim());
  }
  return map;
}

function diffKeys(canonical, current) {
  const missing = [];
  const changed = [];
  for (const [k, v] of canonical) {
    if (!current.has(k)) missing.push(k);
    else if (current.get(k) !== v) changed.push(k);
  }
  return { missing, changed };
}

// Restores envPath with the exact canonicalPath content when any canonical
// key is missing or differs. Returns "ok" | "restored" | "canonical-missing".
function runGuard(canonicalPath, envPath, log = console) {
  if (!fs.existsSync(canonicalPath)) {
    log.error(
      `env-guard: WARNING - ${path.basename(canonicalPath)} is MISSING; cannot verify ${path.basename(envPath)} (leaving it untouched; this must never block boot)`
    );
    process.exitCode = 1;
    return "canonical-missing";
  }
  const canonicalText = fs.readFileSync(canonicalPath, "utf8");
  const canonical = parseEnv(canonicalText);
  const current = fs.existsSync(envPath)
    ? parseEnv(fs.readFileSync(envPath, "utf8"))
    : new Map();
  const { missing, changed } = diffKeys(canonical, current);
  if (missing.length === 0 && changed.length === 0) return "ok";
  const parts = [];
  if (missing.length) parts.push(`missing keys: ${missing.join(", ")}`);
  if (changed.length) parts.push(`changed keys: ${changed.join(", ")}`);
  const tmp = `${envPath}.tmp`;
  fs.writeFileSync(tmp, canonicalText);
  fs.renameSync(tmp, envPath);
  log.log(`env-guard: restored ${path.basename(envPath)} from canonical (${parts.join("; ")})`);
  return "restored";
}

function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-guard-selftest-"));
  const canonPath = path.join(dir, ".env.canonical");
  const envPath = path.join(dir, ".env");
  const canonText = [
    "# fake canonical for selftest (no real secrets here)",
    "ALPHA_KEY=value-alpha",
    "BETA_KEY=value-beta",
    "GAMMA_KEY=value-gamma",
    "",
  ].join("\n");
  fs.writeFileSync(canonPath, canonText);
  const results = [];
  const assert = (name, cond) => results.push([name, !!cond]);

  // Case 1: truncated env (one key missing, one value wrong) -> full restore.
  fs.writeFileSync(envPath, "ALPHA_KEY=value-alpha\nBETA_KEY=value-WRONG\n");
  const s1 = runGuard(canonPath, envPath, silentLog);
  assert("case1 status=restored", s1 === "restored");
  assert("case1 content byte-exact vs canonical", fs.readFileSync(envPath, "utf8") === canonText);
  assert("case1 no .tmp left behind", !fs.existsSync(`${envPath}.tmp`));

  // Case 2: idempotent second run -> no rewrite at all (same inode).
  const before = fs.readFileSync(envPath, "utf8");
  const inoBefore = fs.statSync(envPath).ino;
  const s2 = runGuard(canonPath, envPath, silentLog);
  assert("case2 status=ok (silent)", s2 === "ok");
  assert("case2 content unchanged", fs.readFileSync(envPath, "utf8") === before);
  assert("case2 file not rewritten (same inode)", fs.statSync(envPath).ino === inoBefore);

  // Case 3: healthy env with an extra non-canonical key -> untouched.
  fs.writeFileSync(
    envPath,
    "EXTRA_KEY=keepme\nALPHA_KEY=value-alpha\nBETA_KEY=value-beta\nGAMMA_KEY=value-gamma\n"
  );
  const s3 = runGuard(canonPath, envPath, silentLog);
  assert("case3 status=ok", s3 === "ok");
  assert("case3 extra keys preserved", fs.readFileSync(envPath, "utf8").includes("EXTRA_KEY=keepme"));

  // Case 4: missing canonical -> exit code 1, env left untouched.
  const otherEnv = path.join(dir, "other.env");
  fs.writeFileSync(otherEnv, "ALPHA_KEY=value-alpha\n");
  const prevCode = process.exitCode;
  process.exitCode = 0;
  const s4 = runGuard(path.join(dir, "does-not-exist"), otherEnv, silentLog);
  const code4 = process.exitCode;
  process.exitCode = prevCode;
  assert("case4 status=canonical-missing", s4 === "canonical-missing");
  assert("case4 exit code 1", code4 === 1);
  assert("case4 env untouched", fs.readFileSync(otherEnv, "utf8") === "ALPHA_KEY=value-alpha\n");

  fs.rmSync(dir, { recursive: true, force: true });
  let failed = 0;
  for (const [name, ok] of results) {
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}`);
    if (!ok) failed++;
  }
  console.log(`env-guard selftest: ${results.length - failed}/${results.length} assertions passed`);
  // Set explicitly: Bun does not reset a previously assigned exitCode via
  // undefined, and case 4 legitimately assigned 1 during the assertion.
  process.exitCode = failed ? 1 : 0;
}

const mode = process.argv[2] || "";
if (mode === "--selftest") {
  selftest();
} else {
  runGuard(CANONICAL, ENV_FILE);
}
