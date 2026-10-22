/**
 * builtin-tts.js - built-in TTS chain step (feature 14; $0 fallback).
 *
 * STREAM-FORMAT RECONCILIATION (library-docs.md envelope vs the TTS
 * platform skill fact, resolved by probe on 2026-10-21 with
 * z-ai-web-dev-sdk@0.0.18 and noted in the worklog - library-docs is
 * NOT edited):
 *   - library-docs envelope: response_format "wav" + stream:true ->
 *     async iterable of chunks.
 *   - platform skill fact: with stream:true only "pcm" is streaming;
 *     wav/mp3 are non-streaming Response objects.
 *   - PROBE RESULT (this SDK build): stream:true returns a Response for
 *     BOTH formats whose BODY is a text/event-stream; each SSE frame is
 *     OpenAI-style JSON and choices[0].delta.content carries base64
 *     audio bytes in the REQUESTED format (wav frames carry complete
 *     RIFF/WAVE bytes, pcm frames raw s16le). The documented envelope
 *     therefore WORKS here and is attempted FIRST; if it ever rejects,
 *     yields nothing, or produces bytes that are neither a complete wav
 *     nor raw pcm, the SAME streaming step falls back to
 *     response_format "pcm" (same voice "tongtong", still streaming).
 *   - The ACTUAL format is sniffed from the collected bytes and
 *     reported honestly in bot:speech mime ("audio/wav" for complete
 *     RIFF/WAVE, "audio/pcm;rate=24000" for raw s16le) - never assumed.
 *
 * H-G4: never logs prompt text, audio bytes, or provider error bodies -
 * fixed Error labels only; the service logs sizes/counts/status codes.
 * SERVER-SIDE ONLY (z-ai-web-dev-sdk import; never imported from
 * anything under public/). The ZAI client is memoized (library-docs
 * Setup / Client Pattern, same as builtin-llm.js / builtin-asr.js).
 */

import ZAI from "z-ai-web-dev-sdk";

// Provenance: canonical pure constant owned by server/lib (single copy).
import { TURN_TEXT_MAX } from "../../../server/lib/constants.js";

import { aiTimeoutSignal } from "./chain.js";
import { makeAbortError, raceWithGuards } from "./abort-guard.js";
import { PCM_SPEECH_MIME, WAV_SPEECH_MIME } from "./speech-chunks.js";

/** Locked fallback voice (library-docs.md z-ai-web-dev-sdk envelope). */
const TTS_VOICE = "tongtong";

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
 * Defensive input prep for the SDK call: trim + collapse whitespace,
 * then cap at TURN_TEXT_MAX (600; the reply is already capped upstream -
 * this is the SDK-boundary enforcement; the SDK's own hard limit is
 * 1024). Empty after sanitize -> null (caller treats as a step failure
 * and the chain hops / exhausts honestly).
 *
 * @param {string} text
 * @returns {string | null}
 */
export function sanitizeTtsInput(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > TURN_TEXT_MAX ? cleaned.slice(0, TURN_TEXT_MAX) : cleaned;
}

/**
 * Extract base64 audio from one SSE line (fixed-frame OpenAI-style
 * shape: data: {"choices":[{"delta":{"content":"<base64>"}}]}). Returns
 * null for keep-alives, [DONE] and non-audio frames. JSON parse failures
 * are skipped (defensive), never logged (H-G4).
 *
 * @param {string} line
 * @returns {string | null}
 */
function audioBase64FromSseLine(line) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload.length === 0 || payload === "[DONE]") return null;
  try {
    const frame = JSON.parse(payload);
    if (frame && typeof frame === "object" && frame.error) return null; // error frame -> no audio
    const base64 = frame?.choices?.[0]?.delta?.content;
    return typeof base64 === "string" && base64.length > 0 ? base64 : null;
  } catch {
    return null; // unparseable frame - skipped, never logged
  }
}

/**
 * Sniff the mime from the collected bytes: complete RIFF/WAVE ->
 * "audio/wav"; anything else is raw s16le mono 24 kHz pcm from this
 * SDK's streaming endpoint -> "audio/pcm;rate=24000".
 *
 * @param {Buffer[]} audio
 * @returns {string}
 */
function mimeForCollectedBytes(audio) {
  const head = audio.length > 0 ? audio[0] : null;
  if (head && head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WAVE") {
    return WAV_SPEECH_MIME;
  }
  return PCM_SPEECH_MIME;
}

/**
 * Drive one streaming synthesis: request -> iterate the SSE body ->
 * collect base64 audio frames into Buffers, racing the AI timeout
 * (H-E2) and any barge-in abort. Returns [] when the stream carried no
 * audio (caller decides: fallback format or step failure).
 *
 * @param {object} zaiClient memoized SDK client
 * @param {string} text sanitized input
 * @param {string} responseFormat "wav" (documented) or "pcm" (fallback)
 * @param {{signal: AbortSignal, status: number}[]} guards
 * @returns {Promise<Buffer[]>}
 */
async function collectTtsStream(zaiClient, text, responseFormat, guards) {
  // Fast-fail BEFORE firing the request when a guard already aborted
  // (a barge-in landing between chain steps must not spend an SDK call).
  const preAborted = (Array.isArray(guards) ? guards : []).find((g) => g.signal.aborted);
  if (preAborted) throw makeAbortError(preAborted.status, "builtin-tts aborted before request");
  const response = await zaiClient.audio.tts.create({
    input: text,
    voice: TTS_VOICE,
    response_format: responseFormat,
    stream: true,
  });
  const body = response?.body;
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    // Platform skill fact: a non-streaming Response object - the
    // documented streaming envelope does not apply in this SDK build.
    throw makeAbortError(0, "builtin-tts returned no streaming body");
  }
  const collected = (async () => {
    const audio = [];
    let sse = "";
    for await (const chunk of body) {
      sse += Buffer.from(chunk).toString("utf8");
      let newlineAt;
      while ((newlineAt = sse.indexOf("\n")) !== -1) {
        const line = sse.slice(0, newlineAt).trim();
        sse = sse.slice(newlineAt + 1);
        const base64 = audioBase64FromSseLine(line);
        if (base64 !== null) audio.push(Buffer.from(base64, "base64"));
      }
    }
    return audio;
  })();
  // Cancel the HTTP stream on abort so the socket does not keep pulling.
  return raceWithGuards(collected, guards, () => {
    try {
      void body.cancel();
    } catch {
      // best-effort cancel - the race outcome is already fixed
    }
  });
}

/**
 * Build the built-in TTS chain step for one reply text.
 *
 * @param {string} text reply text (sanitized defensively here too)
 * @param {AbortSignal} [externalSignal] barge-in abort (optional)
 * @returns {{name: string, run: () => Promise<{chunks: Buffer[], mime: string}>}}
 */
export function createBuiltinTtsStep(text, externalSignal) {
  return {
    name: "builtin",
    run: async () => {
      const input = sanitizeTtsInput(text);
      if (input === null) throw makeAbortError(0, "builtin-tts input empty after sanitize");
      const guards = [{ signal: aiTimeoutSignal(), status: 0 }];
      if (externalSignal) guards.push({ signal: externalSignal, status: 499 });
      const client = await zai();
      // Attempt the DOCUMENTED envelope first (wav + stream:true), then
      // the platform-skill fallback (pcm + stream:true) - the same
      // streaming step either way (see module header reconciliation).
      let audio = null;
      try {
        const collected = await collectTtsStream(client, input, "wav", guards);
        if (collected.length > 0) audio = collected;
      } catch (error) {
        // A barge abort must NOT be swallowed by the format fallback:
        // rethrow so P1 hops immediately (H-E3). Any other failure (SDK
        // rejection, timeout guard, empty stream) tries the fallback
        // below - whose guards already include the fired AI-timeout
        // signal when that was the cause, so it fails fast.
        if (error?.status === 499) throw error;
        audio = null;
      }
      if (audio === null) {
        let fallback = null;
        try {
          fallback = await collectTtsStream(client, input, "pcm", guards);
        } catch {
          // H-G4: the SDK error text can embed a provider body - it is
          // never propagated/logged; a fixed label carries the failure.
          throw makeAbortError(0, "builtin-tts stream failed");
        }
        if (fallback.length === 0) throw makeAbortError(0, "builtin-tts stream carried no audio");
        audio = fallback;
      }
      const bytes = audio.reduce((total, buffer) => total + buffer.length, 0);
      if (bytes === 0) throw makeAbortError(0, "builtin-tts produced no audio");
      return { chunks: audio, mime: mimeForCollectedBytes(audio) };
    },
  };
}
