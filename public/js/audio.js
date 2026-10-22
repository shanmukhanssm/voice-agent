/**
 * audio.js - owner of the ONE AudioContext singleton for the whole page.
 *
 * library-docs.md invariant (Vanilla frontend patterns): mic capture (VAD
 * worklet source) AND bot TTS playback (AudioBufferSource, feature 14) share
 * a single AudioContext - that is what lets the feature 16 MediaRecorder mix
 * contain both sides. Never construct a second context; resume the singleton
 * on user gestures. Feature 14 extends this module with the playback queue
 * (createSpeechPlayer): bot:speech chunks schedule as one gapless chain of
 * AudioBufferSourceNodes on the SHARED context - raw pcm streams per chunk,
 * while every container format (wav, the edge step's webm/opus, ...) is
 * reassembled into the WHOLE utterance buffer before its single decode
 * attempt (a slice of one container never decodes alone).
 */

/** @type {AudioContext | null} */
let sharedContext = null;
/**
 * Recording tap (Task 23): a MediaStreamAudioDestinationNode on the SHARED
 * context. Every scheduled bot source connects to it IN ADDITION to the
 * speakers, so recorder.js can capture the AI side of the conversation.
 * @type {MediaStreamAudioDestinationNode | null}
 */
let botTapDestination = null;

/**
 * Return the page-wide AudioContext, creating it lazily on first call.
 * Callers must reach this from (or after) a user gesture so the context
 * can start running.
 *
 * @returns {AudioContext}
 */
export function getAudioContext() {
  if (sharedContext === null) {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

/**
 * The bot-audio recording tap (Task 23): lazily creates the destination on
 * the shared context and returns its MediaStream. Must be called BEFORE the
 * first bot utterance of a call (recorder.js does this at Start Call) so the
 * MediaRecorder is built with both tracks from the start.
 *
 * @returns {MediaStream} one live audio track mirroring all bot playback
 */
export function ensureBotTapStream() {
  const context = getAudioContext();
  if (botTapDestination === null) {
    botTapDestination = context.createMediaStreamDestination();
  }
  return botTapDestination.stream;
}

/**
 * Resume the shared context (autoplay policy: browsers start it suspended
 * until a user gesture). Safe to call on every gesture; no-op when running.
 *
 * @returns {Promise<void>} resolves when the context is running (or warns)
 */
export async function resumeAudioContext() {
  const context = getAudioContext();
  if (context.state !== "suspended") return;
  try {
    await context.resume();
  } catch (error) {
    console.warn(
      "[audio] context resume failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

// --- Feature 14: bot speech playback queue --------------------------------

// bot:speech mime values (server emits the ACTUAL bytes format):
// raw s16le mono 24 kHz pcm -> built PER CHUNK manually (true streaming,
// zero extra latency); every container (complete RIFF/WAVE, the edge
// step's webm/opus, ogg, ...) -> the utterance's slices are reassembled
// into ONE buffer first (a slice of a container never decodes alone) and
// gets ONE decodeAudioData attempt, skipped on failure (honest
// degradation, never wedges the queue).
const PCM_MIME_PREFIX = "audio/pcm";
const WAV_MIME_PREFIX = "audio/wav";
const PCM_SAMPLE_RATE = 24000;
// Scheduling lookahead: the next source never starts sooner than 20 ms
// from now (keeps the chain gapless without racing the clock).
const SCHEDULE_AHEAD_S = 0.02;
// Container reassembly tail-idle window: when no further chunk arrives
// for the pending utterance within this window, the buffer is finalized
// and decoded. Tradeoff, stated honestly: container formats start
// playback ~150 ms after the LAST chunk of the utterance (raw pcm
// streams live per chunk and pay nothing). Task 20-a: 250 -> 150 ms -
// the server emits a turn's slices in one tight burst (locally within
// ~20 ms), so a shorter window shaves perceived first-audio latency; a
// false finalize on a laggy link degrades honestly (that chunk group is
// skipped, never wedges the queue).
const CONTAINER_TAIL_IDLE_MS = 150;

/**
 * Decode a base64 chunk into bytes (Web-standard atob; a 32000-char
 * chunk is well within budget).
 *
 * @param {string} base64
 * @returns {Uint8Array} empty when the input is not valid base64
 */
function base64ToBytes(base64) {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * Raw s16le little-endian mono 24 kHz pcm -> Float32 AudioBuffer on the
 * shared context ( getInt16(i*2, true) / 32768 per sample).
 *
 * @param {AudioContext} context
 * @param {Uint8Array} bytes sample bytes (an even count - the server
 *   slices on 2-byte boundaries)
 * @returns {AudioBuffer | null} null when there are no whole samples
 */
function pcmToAudioBuffer(context, bytes) {
  const frameCount = Math.floor(bytes.byteLength / 2);
  if (frameCount === 0) return null;
  const audioBuffer = context.createBuffer(1, frameCount, PCM_SAMPLE_RATE);
  const channel = audioBuffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < frameCount; i += 1) {
    channel[i] = view.getInt16(i * 2, true) / 32768;
  }
  return audioBuffer;
}

/**
 * Total length of a complete RIFF/WAVE file that STARTS at these bytes
 * (declared size at offset 4, little-endian, + 8 for the RIFF/WAVE
 * fields themselves) - the reassembly target for sliced wavs.
 *
 * @param {Uint8Array} bytes
 * @returns {number | null} null when these bytes do not start a RIFF
 */
function riffTotalLength(bytes) {
  if (bytes.byteLength < 12) return null;
  if (
    bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46
  ) {
    return null; // not "RIFF"
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(4, true) + 8;
}

/**
 * Create the bot speech playback queue (feature 14; in-call only - the
 * player is created on Start Call and flushed/closed on End Call, so no
 * audio can ever play outside a live call). Chunks enqueue onto the
 * SHARED AudioContext and play IN ORDER with no gaps: each source
 * schedules at the previous source's end time (small lookahead). Raw pcm
 * buffers schedule per chunk (true streaming); container formats (wav,
 * webm/opus, ...) reassemble the WHOLE utterance first and decode once,
 * on the first of: a new-utterance boundary (seq 0 / new text), the
 * CONTAINER_TAIL_IDLE_MS tail-idle window, or the wav's declared total -
 * so containers start ~150 ms after the utterance's last chunk (stated
 * tradeoff), pcm pays nothing. The first audible start fires onPlaybackStart ONCE per
 * utterance (an utterance = one bot reply, keyed by its text); when the
 * queue drains and the last source ends, onPlaybackEnd fires (also
 * once). flush() stops everything instantly (barge-in budget: well under
 * 300 ms) and DROPS any still-pending utterance.
 *
 * Defensive: a bad or undecodable chunk is skipped (counted + warned),
 * never wedging the queue.
 *
 * @param {object} handlers
 * @param {() => void} [handlers.onPlaybackStart] first audible start of
 *   an utterance (status line -> "Speaking…")
 * @param {() => void} [handlers.onPlaybackEnd] the queue drained and the
 *   last source ended (status line -> "Listening…")
 * @returns {{enqueue: Function, flush: Function, isPlaying: Function}}
 */
export function createSpeechPlayer({ onPlaybackStart, onPlaybackEnd } = {}) {
  const context = getAudioContext();
  /** @type {Set<AudioBufferSourceNode>} scheduled, not yet ended sources */
  const activeSources = new Set();
  /** Next chain start time (seconds on the context clock); 0 when idle. */
  let nextStartTime = 0;
  /** Text of the utterance whose onPlaybackStart already fired. */
  let startedText = null;
  /** Decode generations: flush() invalidates in-flight decodes. */
  let epoch = 0;
  /**
   * Pending container reassembly for ONE utterance (null when none):
   * { text, mime, parts, received, total } - identity is the reply text
   * (one reply = one text). total is the RIFF declared size ONLY when the
   * first bytes start a complete-RIFF wav (declared-total fast path);
   * every other container accumulates until an utterance boundary, the
   * tail-idle timer or flush() settles it.
   */
  let containerPending = null;
  /** Tail-idle timer id for containerPending (null when none armed). */
  let containerTailTimerId = null;
  /** decodeAudioData calls in flight (counted so the drain is exact). */
  let pendingDecodes = 0;
  /** Skipped-chunk counter (defensive-decode diagnostics only). */
  let skippedChunks = 0;

  function reportSkip(reason) {
    skippedChunks += 1;
    console.warn(`[audio] bot speech chunk skipped (${reason}); total ${skippedChunks}`);
  }

  /** True while audio is playing or a decode that will play is in flight. */
  function busy() {
    return activeSources.size > 0 || containerPending !== null || pendingDecodes > 0;
  }

  /** Queue drained: fire onPlaybackEnd once and re-arm the chain. */
  function maybeEnd() {
    if (startedText === null || busy()) return;
    startedText = null;
    nextStartTime = 0;
    if (typeof onPlaybackEnd === "function") {
      try {
        onPlaybackEnd();
      } catch (error) {
        console.warn(
          "[audio] playback end handler failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /**
   * Schedule one decoded buffer at the chain's end (gapless), firing
   * onPlaybackStart the first time a NEW utterance becomes audible.
   *
   * @param {AudioBuffer} audioBuffer
   * @param {string} text utterance key the buffer belongs to
   */
  function scheduleBuffer(audioBuffer, text) {
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    // Task 23: mirror the playback into the recording tap (when one exists)
    // so the saved conversation contains the AI side too. A disconnect of
    // the tap must never break playback, hence the try/catch.
    if (botTapDestination !== null) {
      try {
        source.connect(botTapDestination);
      } catch {
        // tap unavailable - playback continues untouched
      }
    }
    const startTime = Math.max(nextStartTime, context.currentTime + SCHEDULE_AHEAD_S);
    source.start(startTime);
    nextStartTime = startTime + audioBuffer.duration;
    activeSources.add(source);
    source.onended = () => {
      activeSources.delete(source);
      try {
        source.disconnect();
      } catch {
        // already disconnected - nothing to do
      }
      maybeEnd();
    };
    if (startedText !== text) {
      startedText = text;
      if (typeof onPlaybackStart === "function") {
        try {
          onPlaybackStart();
        } catch (error) {
          console.warn(
            "[audio] playback start handler failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }

  /**
   * Decode + schedule a complete byte payload: raw pcm builds its
   * AudioBuffer manually; every container gets ONE decodeAudioData
   * attempt and is skipped on failure.
   *
   * @param {Uint8Array} bytes
   * @param {string} mime
   * @param {string} text
   */
  function decodeAndSchedule(bytes, mime, text) {
    if (mime.startsWith(PCM_MIME_PREFIX)) {
      const audioBuffer = pcmToAudioBuffer(context, bytes);
      if (!audioBuffer) {
        reportSkip("no whole pcm samples");
        maybeEnd();
        return;
      }
      scheduleBuffer(audioBuffer, text);
      return;
    }
    const copy = bytes.slice(0).buffer; // decodeAudioData detaches its input
    const currentEpoch = epoch;
    pendingDecodes += 1;
    context
      .decodeAudioData(copy)
      .then((audioBuffer) => {
        if (currentEpoch === epoch) scheduleBuffer(audioBuffer, text);
      })
      .catch(() => {
        if (currentEpoch === epoch) reportSkip(`undecodable ${mime} container`);
      })
      .finally(() => {
        // A decode dropped by flush() (epoch moved) must NOT decrement
        // the fresh counter flush() already zeroed - otherwise the drain
        // count goes negative and the queue can end early. The count
        // stays exact: only current-epoch decodes decrement.
        if (currentEpoch !== epoch) return;
        pendingDecodes -= 1;
        maybeEnd();
      });
  }

  /**
   * Merge the accumulated parts into one contiguous byte buffer (pure;
   * also exercised end-to-end by the offline scratch harness).
   *
   * @param {Uint8Array[]} parts
   * @returns {Uint8Array}
   */
  function mergeParts(parts) {
    const merged = new Uint8Array(
      parts.reduce((total, part) => total + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    return merged;
  }

  /**
   * Finalize the pending container utterance: merge + decode-and-schedule
   * the WHOLE buffer, then drop the pending state + tail timer. The
   * buffer may still be incomplete/undecodable (the utterance never
   * completed) - the decode failing is the honest-degradation skip,
   * counted + warned, never a wedge.
   *
   * @returns {void}
   */
  function finalizePending() {
    if (containerPending === null) return;
    const pending = containerPending;
    containerPending = null;
    if (containerTailTimerId !== null) {
      clearTimeout(containerTailTimerId);
      containerTailTimerId = null;
    }
    decodeAndSchedule(mergeParts(pending.parts), pending.mime, pending.text);
  }

  /**
   * (Re-)arm the tail-idle timer for the pending utterance - it resets on
   * EVERY arriving chunk, so it fires only when the stream for this
   * utterance has gone quiet (finished, or died mid-send).
   *
   * @returns {void}
   */
  function armContainerTailTimer() {
    if (containerTailTimerId !== null) clearTimeout(containerTailTimerId);
    containerTailTimerId = setTimeout(() => {
      containerTailTimerId = null;
      finalizePending(); // (b) tail-idle: no chunk for the utterance in time
    }, CONTAINER_TAIL_IDLE_MS);
  }

  /**
   * Append one container byte payload to the pending utterance buffer.
   * A complete-RIFF wav chooses the declared-total fast path (decodes the
   * moment the declared size has arrived - zero extra latency); every
   * other container (and a headerless wav) decodes on an utterance
   * boundary or the tail-idle timer, because ONE slice of a container
   * never decodes alone.
   *
   * @param {Uint8Array} bytes
   * @param {string} mime
   * @param {string} text
   */
  function feedContainerSlice(bytes, mime, text) {
    if (containerPending === null) {
      // New utterance identity. The RIFF check is ONLY the declared-total
      // fast path for wav - no container is ever required to start with
      // one; headerless containers finalize via boundary/timer/flush.
      const total = mime.startsWith(WAV_MIME_PREFIX) ? riffTotalLength(bytes) : null;
      containerPending = { text, mime, parts: [], received: 0, total };
    }
    containerPending.parts.push(bytes);
    containerPending.received += bytes.byteLength;
    if (
      containerPending.total !== null &&
      containerPending.received >= containerPending.total
    ) {
      finalizePending(); // (wav fast path) declared total complete - no tail wait
      return;
    }
    armContainerTailTimer();
  }

  /**
   * Enqueue one bot:speech chunk { seq, audioBase64, mime, text }.
   * Bad/undecodable chunks are skipped (warn + count), never thrown.
   *
   * @param {unknown} chunk
   * @returns {void}
   */
  function enqueue(chunk) {
    if (
      chunk === null ||
      typeof chunk !== "object" ||
      typeof chunk.audioBase64 !== "string" ||
      chunk.audioBase64.length === 0 ||
      typeof chunk.mime !== "string" ||
      chunk.mime.length === 0
    ) {
      reportSkip("malformed payload");
      maybeEnd();
      return;
    }
    const text = typeof chunk.text === "string" ? chunk.text : "";
    const bytes = base64ToBytes(chunk.audioBase64);
    if (bytes.byteLength === 0) {
      reportSkip("empty or invalid base64");
      maybeEnd();
      return;
    }
    // Utterance boundary (a): the server numbers each reply's chunks from
    // seq 0, and one reply = one text - either signal means any still-
    // pending PREVIOUS utterance is complete and must decode FIRST (the
    // whole-buffer decode keeps the utterance order on the gapless chain).
    const seq = typeof chunk.seq === "number" ? chunk.seq : null;
    if (
      containerPending !== null &&
      (seq === 0 || text !== containerPending.text)
    ) {
      finalizePending();
    }
    if (chunk.mime.startsWith(PCM_MIME_PREFIX)) {
      // Raw pcm keeps true streaming: per-chunk manual AudioBuffer, no
      // reassembly, no tail delay.
      decodeAndSchedule(bytes, chunk.mime, text);
      return;
    }
    feedContainerSlice(bytes, chunk.mime, text);
  }

  /**
   * Stop every scheduled/playing source IMMEDIATELY (perceptually
   * instant stop - far under the 300 ms barge-in budget), clear all
   * pending state and fire onPlaybackEnd if something was playing (so
   * the status returns to "Listening…").
   *
   * @returns {void}
   */
  function flush() {
    epoch += 1;
    const wasPlaying = startedText !== null || activeSources.size > 0 || pendingDecodes > 0;
    // (c) finalize-or-drop, per the flush contract: a call is ending - the
    // pending utterance is DROPPED, never decoded after End Call; the
    // epoch guard already isolates in-flight decodes.
    containerPending = null;
    if (containerTailTimerId !== null) {
      clearTimeout(containerTailTimerId);
      containerTailTimerId = null;
    }
    pendingDecodes = 0; // in-flight decodes are dropped by the epoch guard
    nextStartTime = 0;
    startedText = null;
    for (const source of activeSources) {
      try {
        source.stop(); // perceptually instant (well under 300 ms)
      } catch {
        // already stopped - nothing to do
      }
    }
    activeSources.clear();
    if (wasPlaying && typeof onPlaybackEnd === "function") {
      try {
        onPlaybackEnd();
      } catch (error) {
        console.warn(
          "[audio] flush end handler failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** True while bot audio is playing or a container reassembly is in flight. */
  function isPlaying() {
    return busy();
  }

  // Keep the shared context running even if a gesture raced us (no-op
  // when already running; failure just warns - the status stays honest).
  if (context.state === "suspended") {
    void context.resume().catch(() => {});
  }

  return Object.freeze({ enqueue, flush, isPlaying });
}
