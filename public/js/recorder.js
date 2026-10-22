/**
 * recorder.js - feature 21 quick path: record the live call audio
 * (the ONE mic stream from vad.js) with MediaRecorder and upload the webm
 * blob when the call ends. Fire-and-forget by design: a recording failure
 * must NEVER break the call UI or the summary flow.
 *
 * Mime is negotiated once: opus-in-webm on Chrome/Edge/Firefox, then plain
 * webm, then the browser default. Chunks are collected in memory (a call
 * is minutes of opus audio - well under the 20 MB server cap).
 *
 * Task 23 - BOTH sides: the stream is a MIX of the live mic (customer) and
 * the bot playback tap (audio.js ensureBotTapStream - every bot utterance
 * mirrors into it), so the saved conversation is complete.
 */

import { ensureBotTapStream, getAudioContext } from "./audio.js";

/** Storage format (Task 27): 16 kHz mono 16-bit WAV - exact duration,
 * instant seeking, plays everywhere, ~1.9 MB per minute (a sales call is
 * minutes; the server cap is 20 MB). MediaRecorder's streamed webm has NO
 * duration metadata - the <audio> element showed "0:00 / 0:00" and a dead
 * seek bar even when the audio was fine. Converting client-side fixes the
 * player AND lets us verify the audio is really there before upload. */
const WAV_SAMPLE_RATE = 16000;

/** @type {MediaRecorder | null} the ONE active recorder for the page */
let recorder = null;
/** @type {Blob[]} accumulated webm chunks for the current call */
let chunks = [];

/**
 * Pick the best supported audio mime type.
 * @returns {string} MediaRecorder mime (may be the browser default "")
 */
function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm"];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

/**
 * Web Audio mix graph for the current call (Task 26): everything is summed
 * into ONE MediaStreamAudioDestinationNode so MediaRecorder gets a SINGLE
 * audio track. Chrome's MediaRecorder does NOT reliably mix multiple audio
 * tracks (it effectively records the first and drops the rest) - the Task
 * 24 two-track stream is exactly why the saved calls had only the customer
 * side. Both sources are routed on the SHARED AudioContext.
 *
 * @type {{ dest: MediaStreamAudioDestinationNode, sources: MediaStreamAudioSourceNode[] } | null}
 */
let mixGraph = null;

/**
 * Build the recording stream: a true Web Audio DOWNMIX of the live mic
 * (customer) and the bot playback tap (AI) into ONE audio track.
 *
 * @param {MediaStream | null} micStream the live mic stream from vad.js
 * @returns {MediaStream | null} null when there is nothing to record
 */
function buildRecordingStream(micStream) {
  teardownMixGraph();
  const context = getAudioContext();
  const dest = context.createMediaStreamDestination();
  const sources = [];
  const connectSource = (stream) => {
    try {
      if (!stream || stream.getAudioTracks().length === 0) return;
      const source = context.createMediaStreamSource(stream);
      source.connect(dest);
      sources.push(source);
    } catch {
      // one missing side must never kill the other
    }
  };
  connectSource(micStream);
  try {
    connectSource(ensureBotTapStream());
  } catch {
    // no tap (no AudioContext yet) - record mic only
  }
  if (sources.length === 0) return null;
  mixGraph = { dest, sources };
  return dest.stream;
}

/**
 * Disconnect + drop the mix graph (call end). The nodes are garbage once
 * disconnected; the underlying mic stream and bot tap stay untouched.
 */
function teardownMixGraph() {
  const graph = mixGraph;
  mixGraph = null;
  if (!graph) return;
  for (const source of graph.sources) {
    try {
      source.disconnect();
    } catch {
      // already disconnected - nothing to do
    }
  }
}

/**
 * Start recording the call audio for a call. Safe to call when the stream
 * is missing (recording silently skipped - honest omission, never a crash).
 *
 * @param {MediaStream | null} stream the live mic stream from vad.js
 */
export function startCallRecording(stream) {
  try {
    if (recorder !== null) stopCallRecording();
    if (
      typeof MediaRecorder === "undefined"
    ) {
      return;
    }
    const mixed = buildRecordingStream(stream);
    if (mixed === null) return;
    chunks = [];
    const mime = pickMime();
    recorder = mime ? new MediaRecorder(mixed, { mimeType: mime }) : new MediaRecorder(mixed);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(4000); // 4s slices - bounded memory, clean final chunk
  } catch {
    recorder = null; // recording is best-effort; the call proceeds without it
  }
}

/** Stop the recorder without uploading (reset path / stream cleanup). */
function stopCallRecording() {
  const current = recorder;
  recorder = null;
  if (current && current.state !== "inactive") {
    try {
      current.stop();
    } catch {
      /* already stopped */
    }
  }
}

/**
 * Encode Float32 mono samples as a 16-bit PCM WAV Blob (RIFF header + data).
 *
 * @param {Int16Array} pcm final samples
 * @returns {Blob} audio/wav
 */
function encodeWav(pcm) {
  const bytes = 44 + pcm.length * 2;
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  const writeStr = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, WAV_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(offset, pcm[i], true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Convert the recorded MediaRecorder webm into a clean 16 kHz mono WAV.
 * Decodes the blob on the shared AudioContext, downmixes every channel to
 * mono, resamples linearly, and reports the loudness (RMS) so a silent
 * recording is visible in the console instead of silently confusing.
 *
 * @param {Blob} webm the raw MediaRecorder blob
 * @returns {Promise<{ blob: Blob, seconds: number, rms: number } | null>}
 *   null when the recording cannot be decoded (caller uploads raw bytes)
 */
async function webmToWav(webm) {
  try {
    const decoded = await getAudioContext().decodeAudioData(await webm.arrayBuffer());
    const frames = decoded.length;
    const channels = decoded.numberOfChannels;
    const mono = new Float32Array(frames);
    for (let c = 0; c < channels; c += 1) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < frames; i += 1) mono[i] += data[i] / channels;
    }
    let sumSquares = 0;
    for (let i = 0; i < frames; i += 1) sumSquares += mono[i] * mono[i];
    const rms = frames > 0 ? Math.sqrt(sumSquares / frames) : 0;

    const ratio = decoded.sampleRate / WAV_SAMPLE_RATE;
    const outFrames = Math.max(1, Math.floor(frames / ratio));
    const pcm = new Int16Array(outFrames);
    for (let i = 0; i < outFrames; i += 1) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, frames - 1);
      const frac = pos - i0;
      const sample = i0 < frames ? mono[i0] * (1 - frac) + mono[i1] * frac : 0;
      pcm[i] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
    }
    return { blob: encodeWav(pcm), seconds: decoded.duration, rms };
  } catch {
    return null; // honest fallback: upload the raw webm unchanged
  }
}

/**
 * Stop recording and upload the recording to POST /api/calls/:submissionId/recording.
 * Fire-and-forget: resolves true when the server accepted the file.
 *
 * @param {string | null} submissionId the persisted call id
 * @returns {Promise<boolean>}
 */
export async function stopAndUploadCallRecording(submissionId) {
  const current = recorder;
  recorder = null;
  if (!current || current.state === "inactive" || !submissionId) {
    teardownMixGraph(); // Task 26: no-op when already cleaned
    return false;
  }

  const blob = await new Promise((resolve) => {
    current.onstop = () => resolve(new Blob(chunks, { type: "audio/webm" }));
    try {
      current.stop();
    } catch {
      resolve(new Blob(chunks, { type: "audio/webm" }));
    }
  });
  chunks = [];
  teardownMixGraph(); // Task 26: release the mix nodes (recording done)
  if (blob.size === 0) return false;

  // Task 27: prefer a clean WAV (exact duration, seekable, universal);
  // fall back to the raw webm when the decode fails. The conversion also
  // VERIFIES the audio: the loudness lands in the console either way.
  const converted = await webmToWav(blob);
  const upload = converted === null
    ? { blob, type: "audio/webm", seconds: -1, rms: -1 }
    : { blob: converted.blob, type: "audio/wav", seconds: converted.seconds, rms: converted.rms };
  console.debug(
    `[recorder] upload ${upload.type}: ${upload.seconds}s, rms=${upload.rms.toFixed(4)}, ${upload.blob.size}B`,
  );

  try {
    const res = await fetch(
      `/api/calls/${encodeURIComponent(submissionId)}/recording`,
      {
        method: "POST",
        headers: { "content-type": upload.type },
        body: upload.blob,
      },
    );
    return res.ok;
  } catch {
    return false; // summary + UI must never wait on (or fail with) the upload
  }
}
