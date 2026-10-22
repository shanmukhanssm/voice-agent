/**
 * transcript.js - feature 13 per-session transcript memory (pure).
 *
 * Keeps the ordered turn history the sales prompt is built from: one
 * { role: "user" | "bot", text } entry per emitted turn:final. Pure and
 * testable like session.js - index.js owns ALL I/O (emits, timers,
 * logging); this module never touches sockets or env.
 *
 * Memory hygiene: the store is capped at TRANSCRIPT_MEMORY_MAX turns
 * (oldest dropped) and resets on call:start / re-handshake / call:end /
 * disconnect (index.js owns those lifecycle points).
 *
 * Prompt rendering: renderTranscriptLines() renders the last `depth`
 * turns as "Customer: ..." / "You: ..." lines (user = Customer, bot =
 * You, per the SALES_SYSTEM_PROMPT template comment; build-plan feature
 * 13). Depth is passed by the caller (TRANSCRIPT_TURN_DEPTH = 6 from the
 * canonical server/lib/constants.js - single source of truth).
 */

import { TRANSCRIPT_MEMORY_MAX } from "./constants.js";

/** Label for one transcript role in the sales prompt history lines. */
const ROLE_LABELS = Object.freeze({ user: "Customer", bot: "You" });

/** Fresh transcript memory for one socket session. */
export function createTranscriptMemory() {
  return { turns: [] };
}

/** Reset the transcript memory (call:start / call:end / disconnect). */
export function resetTranscriptMemory(memory) {
  memory.turns.length = 0;
}

/**
 * Append one emitted turn; beyond TRANSCRIPT_MEMORY_MAX the OLDEST turn
 * is dropped (bounded memory, H-G4-adjacent hygiene: sizes stay small).
 *
 * @param {{turns: {role: string, text: string}[]}} memory
 * @param {"user"|"bot"} role
 * @param {string} text
 * @returns {void}
 */
export function appendTranscriptTurn(memory, role, text) {
  memory.turns.push({ role, text });
  while (memory.turns.length > TRANSCRIPT_MEMORY_MAX) {
    memory.turns.shift();
  }
}

/**
 * Render the last `depth` turns as prompt history lines
 * ("Customer: ..." / "You: ...", newline-joined; "" when empty).
 *
 * @param {{role: string, text: string}[]|undefined} turns
 * @param {number} depth TRANSCRIPT_TURN_DEPTH (6)
 * @returns {string}
 */
export function renderTranscriptLines(turns, depth) {
  const history = Array.isArray(turns) ? turns : [];
  return history
    .slice(-depth)
    .map((turn) => {
      const label = ROLE_LABELS[turn?.role] ?? "Customer";
      const text = typeof turn?.text === "string" ? turn.text : "";
      return `${label}: ${text}`;
    })
    .join("\n");
}
