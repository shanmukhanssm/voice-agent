/**
 * edge-tts.js - msedge-tts chain step (feature 14; TTS primary).
 *
 * Envelope per library-docs.md "msedge-tts": new MsEdgeTTS();
 * setMetadata(<voice>, <opus output format>); toStream(text, prosody)
 * (Task 21-b: the prosody options ride EVERY toStream request - see
 * EDGE_PROSODY below; the voice is the locked default or the user's
 * Settings pick).
 * The installed msedge-tts@2.x renamed the locked enum member:
 * OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_OPUS is UNDEFINED there and
 * WEBM_24KHZ_16BIT_MONO_OPUS carries the same 24 kHz 16-bit mono opus
 * stream in a webm (EBML) container. This step attempts the locked
 * member first and falls back to the webm-opus member; the mime returned
 * to the emission layer describes the bytes ACTUALLY produced
 * ("audio/webm;codecs=opus" for the webm member, "audio/ogg;codecs=opus"
 * if a future lib restores the Azure ogg-opus format) - never a guess.
 *
 * Sandbox/laptop failover (library-docs gotcha + H-E4): every call is
 * wrapped - setMetadata and the stream collection both race the Pattern
 * P1 AI timeout (H-E2: stall > AI_TIMEOUT_MS -> status 0 -> hop) and the
 * external barge-in signal (status 499 -> hop, never retried). A
 * synthesis that ends with zero audio bytes is also a failure (status 0)
 * so the chain hops to the built-in step. Failures are routine; nothing
 * here is ever worth debugging in place (H-E4).
 *
 * H-G4: never logs stream chunks or provider errors - the Error labels
 * are fixed strings and the service logs status codes + sizes only.
 */

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { aiTimeoutSignal } from "./chain.js";
import { makeAbortError, raceWithGuards } from "./abort-guard.js";

/** Default primary voice (Task 21-b: probed 2026-10-22 with the shipped
 *  prosody - en-US-AndrewMultilingualNeural rendered the probe sentence ok
 *  at 39536 bytes / 1110 ms, faster than plain AndrewNeural, so it is the
 *  locked default; AndrewNeural stays selectable in Settings). Feature 25:
 *  the user-selected ttsVoice (Settings) is threaded in by
 *  providers/config.js; this stays the locked default when unset. */
const EDGE_VOICE = "en-US-AndrewMultilingualNeural";

/**
 * Task 21-b locked delivery prosody: Andrew at 0% reads like a news
 * anchor; +8% rate reads as a relaxed live call and shaves ~7% off the
 * audio duration, +2Hz adds warmth. The values are per-request
 * ProsodyOptions on toStream (msedge-tts dist Prosody.d.ts: rate accepts
 * a relative "+8%", pitch a relative "+2Hz"), compatible with the
 * warm-connection cache which binds only voice+format at setMetadata -
 * the prosody rides every synthesis request.
 */
const EDGE_PROSODY = Object.freeze({ rate: "+8%", pitch: "+2Hz" });

/**
 * The locked opus member, attempted first (undefined on msedge-tts@2.x,
 * where the opus output is the WEBM member below - see module header).
 */
const LOCKED_OPUS_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_OPUS;
const WEBM_OPUS_FORMAT = OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS;

/** Lib's own connect deadline (its default, made explicit). */
const EDGE_CONNECT_TIMEOUT_MS = 10000;

/**
 * Warm-connection cache (Task 20-a latency round): the msedge-tts lib
 * demuxes every synthesis by requestId on ONE websocket (_rawSSMLRequest
 * registers per-request streams), so a live connection is reusable across
 * turns. Each setMetadata otherwise pays a fresh wss handshake (~200-300
 * ms) on EVERY turn - measurable against the 1.5-2 s turn budget. Cache
 * key = voice (format is the module constant); entries are invalidated on
 * ANY step failure (closed + removed - the next turn reconnects cleanly)
 * and recycled after EDGE_WARM_TTL_MS so an idle socket never goes stale.
 * H-G4: the cache never logs; failures surface through the step's normal
 * status-carrying errors.
 */
const EDGE_WARM_TTL_MS = 240000;
/** @type {Map<string, { tts: object, createdAtMs: number }>} */
const warmConnections = new Map();

/**
 * Acquire a live connection for the voice: the cached one when young, or a
 * fresh one whose setMetadata is raced against the step guards (a stall or
 * barge during connect fails the step exactly like the old per-turn path).
 *
 * @param {string} selectedVoice Edge voice name (cache key)
 * @param {string} format OUTPUT_FORMAT member bound at setMetadata
 * @param {{signal: AbortSignal, status: number}[]} guards step guards
 * @returns {Promise<object>} a metadata-bound MsEdgeTTS instance
 */
async function acquireEdgeConnection(selectedVoice, format, guards) {
  const cached = warmConnections.get(selectedVoice);
  if (cached && Date.now() - cached.createdAtMs <= EDGE_WARM_TTL_MS) {
    return cached.tts;
  }
  if (cached) {
    // Aged out: recycle silently (the fresh connect below replaces it).
    warmConnections.delete(selectedVoice);
    try {
      cached.tts.close();
    } catch {
      // best-effort socket hygiene
    }
  }
  const tts = new MsEdgeTTS({
    enableLogger: false,
    connectionTimeoutMs: EDGE_CONNECT_TIMEOUT_MS,
  });
  await raceWithGuards(tts.setMetadata(selectedVoice, format), guards, () => {
    try {
      tts.close();
    } catch {
      // best-effort close on abort
    }
  });
  warmConnections.set(selectedVoice, { tts, createdAtMs: Date.now() });
  return tts;
}

/**
 * Invalidate a cached connection after a failed step (any failure class -
 * a broken or aborted socket must never be reused).
 *
 * @param {string} selectedVoice cache key
 * @param {object | null} tts the instance that failed (best-effort close)
 */
function invalidateEdgeConnection(selectedVoice, tts) {
  const cached = warmConnections.get(selectedVoice);
  if (cached && cached.tts === tts) warmConnections.delete(selectedVoice);
  if (tts) {
    try {
      tts.close();
    } catch {
      // best-effort socket hygiene; never mask the step outcome
    }
  }
}

/**
 * Honest mime for the format string the lib actually synthesised. The
 * webm member streams a webm (EBML, magic 1a 45 df a3) container; a
 * restored Azure "audio-24khz-48kbitrate-mono-opus" string is an ogg-opus
 * container; mp3 members are mpeg audio. Unknown -> generic octet-stream.
 *
 * @param {string | undefined} format
 * @returns {string}
 */
export function mimeForEdgeFormat(format) {
  if (format === WEBM_OPUS_FORMAT) return "audio/webm;codecs=opus";
  if (typeof format === "string") {
    if (format.includes("opus")) return "audio/ogg;codecs=opus";
    if (format.includes("mp3")) return "audio/mpeg";
  }
  return "application/octet-stream";
}

/**
 * Collect the audioStream into Buffers, racing the AI timeout and any
 * barge-in abort. Stream errors surface as status 0 (network class) so
 * P1 retries/hops per H-E3; neither the error body nor the audio is
 * logged (H-G4).
 *
 * @param {import("stream").Readable} audioStream
 * @param {{signal: AbortSignal, status: number}[]} guards
 * @returns {Promise<Buffer[]>}
 */
function collectAudioStream(audioStream, guards) {
  const collected = new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    audioStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    audioStream.on("end", () => settle(resolve, chunks));
    audioStream.on("error", () => settle(reject, makeAbortError(0, "edge-tts stream failed")));
  });
  return raceWithGuards(collected, guards, () => {
    try {
      audioStream.destroy();
    } catch {
      // best-effort destroy - the race outcome is already fixed
    }
  });
}

/**
 * Build the msedge-tts chain step for one sanitized reply text.
 *
 * @param {string} text sanitized reply text (trim + collapsed whitespace)
 * @param {AbortSignal} [externalSignal] barge-in abort (optional)
 * @param {string} [voice] Edge-TTS voice name (feature 25: the
 *   user-selected ttsVoice; defaults to the locked
 *   en-US-AndrewMultilingualNeural, Task 21-b)
 * @returns {{name: string, run: () => Promise<{chunks: Buffer[], mime: string}>}}
 */
export function createEdgeTtsStep(text, externalSignal, voice = EDGE_VOICE) {
  const selectedVoice =
    typeof voice === "string" && voice.length > 0 ? voice : EDGE_VOICE;
  return {
    name: "edge",
    run: async () => {
      const format = LOCKED_OPUS_FORMAT ?? WEBM_OPUS_FORMAT;
      const guards = [{ signal: aiTimeoutSignal(), status: 0 }];
      if (externalSignal) guards.push({ signal: externalSignal, status: 499 });
      let tts = null;
      try {
        // Warm-connection path (Task 20-a): reuse the cached connection
        // when possible; a fresh connect's setMetadata is still raced by
        // the guards (stall > AI_TIMEOUT_MS -> status 0 -> hop; barge-in
        // -> 499 -> hop, never retried).
        tts = await acquireEdgeConnection(selectedVoice, format, guards);
        const { audioStream } = tts.toStream(text, EDGE_PROSODY);
        const chunks = await collectAudioStream(audioStream, guards);
        const bytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
        if (bytes === 0) throw makeAbortError(0, "edge-tts produced no audio");
        return { chunks, mime: mimeForEdgeFormat(format) };
      } catch (error) {
        // ANY failure invalidates the cached socket - the next turn
        // reconnects cleanly instead of replaying a broken connection.
        invalidateEdgeConnection(selectedVoice, tts);
        throw error;
      }
    },
  };
}
