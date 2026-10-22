/**
 * builtin-completion.js - the MAIN SERVER's built-in LLM completion helper
 * (feature 25, Task 19-a). Mirrors the request envelope of
 * mini-services/voice-service/providers/builtin-llm.js: z-ai-web-dev-sdk
 * chat.completions.create({ messages, thinking: { type: "disabled" } })
 * (disabled thinking is REQUIRED for latency - library-docs.md ss
 * z-ai-web-dev-sdk), reply read from choices[0].message.content ONLY.
 *
 * Consumers: server/lib/summary-llm.js (provider "builtin" for the call
 * summary - the summary now uses the SAME LLM the conversation used) and
 * the POST /api/settings/test live ping. The SDK is backend-only: this
 * module lives in server/lib and is never imported from anything under
 * public/ (H-F2).
 *
 * Contract mirrors summary-llm.js requestCompletion: NEVER throws -
 * { ok: true, content } or { ok: false, reason: "unconfigured" | "empty" |
 * "sdk", status: 0 }. H-G4: SDK error messages are never read/logged/
 * attached - only the error class name rides the log line.
 */

import ZAI from "z-ai-web-dev-sdk";
import { log } from "./log.js";

/** @type {object | null} memoized ZAI client (created once per process) */
let _zai = null;

/**
 * Memoized SDK client (library-docs Setup / Client Pattern).
 *
 * @returns {Promise<object>}
 */
export async function zai() {
  if (!_zai) _zai = await ZAI.create(); // init ~ 3 ms - cheap, but memoize anyway
  return _zai;
}

/**
 * One built-in LLM completion (no chain, no retry - the caller owns the
 * retry semantics exactly as with the REST providers).
 *
 * @param {Array<{ role: string, content: string }>} messages chat-style
 *   messages
 * @param {string} route log tag of the calling route (e.g. "summary")
 * @returns {Promise<{ ok: true, content: string } | { ok: false, reason: string, status: number }>}
 */
export async function builtinCompletion(messages, route) {
  try {
    const out = await (await zai()).chat.completions.create({
      messages,
      thinking: { type: "disabled" }, // REQUIRED for low latency
    });
    const content = out?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      log(route, "builtin_llm_empty_content");
      return { ok: false, reason: "empty", status: 0 };
    }
    return { ok: true, content };
  } catch (e) {
    // H-G4: the SDK error text is never read/logged - class name only.
    log(route, "builtin_llm_sdk_error", {
      name: e instanceof Error ? e.name : "unknown",
    });
    return { ok: false, reason: "sdk", status: 0 };
  }
}
