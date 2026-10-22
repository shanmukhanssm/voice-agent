/**
 * log.js - the one log format: "[route] <message>" + structured extras
 * (code-standards.md ss Error Handling). NEVER raw provider bodies, stack
 * traces, SQL, or secrets in logs - only attempt numbers, hashed keys
 * (prefix-truncated), and status codes.
 */
import { randomBytes } from "node:crypto";

/**
 * Emit one structured server log line.
 * @param {string} route route tag, e.g. "health" or "provider_failover"
 * @param {string} message short stable message
 * @param {Record<string, unknown>} [extras] structured extras (hashed keys,
 *   attempt numbers, status codes) - JSON-serialized on the same line
 */
export function log(route, message, extras) {
  if (extras === undefined) {
    console.log(`[${route}] ${message}`);
    return;
  }
  console.log(`[${route}] ${message} ${JSON.stringify(extras)}`);
}

/**
 * Short opaque reference ID for unknown-error correlation: the 500 envelope
 * carries it and the log line carries the same id with full detail.
 * @returns {string} 8-char hex reference
 */
export function newReferenceId() {
  return randomBytes(4).toString("hex");
}
