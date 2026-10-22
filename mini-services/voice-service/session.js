/**
 * session.js - pure per-socket voice session state machine (feature 11).
 *
 * States enforce the protocol from architecture.md "Voice Socket Protocol"
 * (single copy): idle -> live (call:start with consent === true and a
 * non-empty callId string) -> closed (call:end). index.js owns ALL I/O
 * (timers, emits, logging); this module stays pure and testable.
 *
 * Re-handshake gotcha (library-docs.md): bun --hot reloads drop socket
 * state and the client auto-reconnects, re-sending call:start. A
 * call:start on an already-live session is therefore NORMAL: reset the
 * session state, never an error.
 */

/** The three session states (closed value set, never free-text). */
export const SESSION_STATES = Object.freeze({
  IDLE: "idle",
  LIVE: "live",
  CLOSED: "closed",
});

// Locked sample rate for streamed VAD speech chunks (protocol table).
const REQUIRED_SAMPLE_RATE = 16000;

/** Fresh session for one socket connection. */
export function createSession() {
  return Object.freeze({
    state: SESSION_STATES.IDLE,
    consent: false,
    callId: null,
  });
}

/**
 * call:start {callId, consent}: consent MUST be exactly true AND callId a
 * non-empty string; anything else is a protocol violation (the caller
 * disconnects - no error echo). On success the session goes live; a
 * re-handshake while live restarts the session state.
 *
 * @param {object} session current session
 * @param {unknown} payload call:start payload
 * @returns {{session: object, violation: string|null, restarted: boolean}}
 */
export function startCall(session, payload) {
  const handshake = payload !== null && typeof payload === "object" ? payload : {};
  const callId = typeof handshake.callId === "string" ? handshake.callId : "";
  if (handshake.consent !== true || callId.length === 0) {
    return { session, violation: "call_start_invalid_handshake", restarted: false };
  }
  const restarted = session.state === SESSION_STATES.LIVE;
  return {
    session: Object.freeze({
      state: SESSION_STATES.LIVE,
      consent: true,
      callId,
    }),
    violation: null,
    restarted,
  };
}

/** True only when the session is live AND consent is true. */
export function isLive(session) {
  return session.state === SESSION_STATES.LIVE && session.consent === true;
}

/**
 * utterance {seq, pcmBase64, sampleRate} shape check: seq a non-negative
 * integer, pcmBase64 a string, sampleRate exactly 16000. The base64 length
 * cap (AUDIO_CHUNK_MAX_BYTES) is the payload-caps gate's job in index.js.
 *
 * @param {unknown} payload utterance payload
 * @returns {boolean}
 */
export function isValidUtterance(payload) {
  if (payload === null || typeof payload !== "object") return false;
  if (typeof payload.pcmBase64 !== "string") return false;
  if (!Number.isInteger(payload.seq) || payload.seq < 0) return false;
  return payload.sampleRate === REQUIRED_SAMPLE_RATE;
}

/**
 * call:end {durationSec}: only when live; durationSec must be a finite
 * number >= 0. Malformed -> ignored (session stays live, no violation);
 * while not live -> violation; valid -> session closed (terminal).
 *
 * @param {object} session current session
 * @param {unknown} payload call:end payload
 * @returns {{session: object, closed: boolean, ignored: boolean,
 *            reason: string|null, durationSec: number|null}}
 */
export function endCall(session, payload) {
  if (session.state !== SESSION_STATES.LIVE) {
    return { session, closed: false, ignored: false, reason: "not_live", durationSec: null };
  }
  const durationSec =
    payload !== null && typeof payload === "object" ? payload.durationSec : undefined;
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec < 0) {
    return { session, closed: false, ignored: true, reason: "malformed_duration", durationSec: null };
  }
  return {
    session: Object.freeze({
      state: SESSION_STATES.CLOSED,
      consent: false,
      callId: null,
    }),
    closed: true,
    ignored: false,
    reason: null,
    durationSec,
  };
}
