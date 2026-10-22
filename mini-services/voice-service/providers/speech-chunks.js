/**
 * speech-chunks.js - pure bot:speech emission slicing (feature 14).
 *
 * The socket protocol caps ONE bot:speech audioBase64 at 32 KB
 * (AUDIO_CHUNK_MAX_BYTES base64 chars, architecture.md "Voice Socket
 * Protocol"), while a spoken reply can be far larger (raw s16le mono
 * 24 kHz pcm is 48 KB/s, so a 10 s reply is ~480 KB base64). The whole
 * utterance is therefore split into <= 32000-char base64 slices with a
 * seq across the WHOLE utterance (client reassembles the chain).
 *
 * Slice geometry: the emission budget is 32000 base64 chars per
 * bot:speech chunk (task-locked slice budget, inside the protocol's
 * 32 KB AUDIO_CHUNK_MAX_BYTES cap). 32000 chars decode to 24000 bytes,
 * a multiple of 6 - so every FULL slice is simultaneously an exact
 * base64 group boundary (6 bytes -> 8 chars; 24000 bytes -> exactly
 * 32000 chars) and a 2-byte s16le sample boundary - no pcm sample is
 * ever split across chunks, which lets the client decode each pcm
 * slice independently.
 *
 * One provider run yields ONE continuous byte stream in the reported
 * mime (raw pcm samples, or one container such as wav/webm/ogg built
 * from its stream fragments) - the collected buffers are concatenated
 * before slicing so a fragmented container stream emits as few socket
 * events as possible and stays byte-contiguous for client reassembly.
 *
 * Pure module: no I/O, no env, no logging.
 */

// Voice-service-owned canonical constant (mirrors architecture.md
// "Voice Socket Protocol"; the service is an independent bun project -
// see constants.js header note).
import { AUDIO_CHUNK_MAX_BYTES } from "../constants.js";

/** Raw s16le mono 24 kHz pcm mime (the built-in SDK's streaming shape). */
export const PCM_SPEECH_MIME = "audio/pcm;rate=24000";

/** Complete RIFF/WAVE bytes mime. */
export const WAV_SPEECH_MIME = "audio/wav";

/**
 * Base64-char budget per bot:speech chunk (task-locked; <= the 32 KB
 * AUDIO_CHUNK_MAX_BYTES protocol cap).
 */
export const SPEECH_SLICE_CHARS = 32000;

/**
 * Bytes per full slice, derived from the char budget: 24000 bytes ->
 * exactly 32000 base64 chars, rounded down to a multiple of 6 (base64
 * group AND 2-byte sample boundary). Derived, never hand-waved; the
 * guard throws at import time if the geometry ever violates the cap.
 */
export const SPEECH_SLICE_BYTES = (() => {
  const rawBytes = Math.floor(SPEECH_SLICE_CHARS / 4) * 3;
  const aligned = rawBytes - (rawBytes % 6);
  const capBytes = Math.floor(AUDIO_CHUNK_MAX_BYTES / 4) * 3;
  if (aligned <= 0 || aligned > capBytes) {
    throw new Error("speech slice geometry violates the audio chunk cap");
  }
  return aligned;
})();

/**
 * Split the collected audio buffers into ordered bot:speech slices.
 *
 * @param {Buffer[]} buffers collected audio buffers (one provider run -
 *   ONE continuous byte stream; the run's mime documents the bytes and
 *   travels to the client separately)
 * @returns {{audioBase64: string, bytes: number}[]} ordered slices
 */
export function buildSpeechChunks(buffers) {
  const list = Array.isArray(buffers) ? buffers.filter((b) => b && b.length > 0) : [];
  if (list.length === 0) return [];
  // One continuous stream per run (pcm samples OR one container) -
  // concat the fragments before slicing (mime documents the bytes).
  const total = Buffer.concat(list);
  const slices = [];
  for (let offset = 0; offset < total.length; offset += SPEECH_SLICE_BYTES) {
    const slice = total.subarray(offset, Math.min(offset + SPEECH_SLICE_BYTES, total.length));
    slices.push({ audioBase64: slice.toString("base64"), bytes: slice.length });
  }
  return slices;
}
