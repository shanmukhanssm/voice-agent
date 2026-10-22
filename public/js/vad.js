/**
 * vad.js - mic capture + Silero VAD + 16 kHz PCM utterance encoding
 * (build-plan feature 10). The ONLY module that ever calls getUserMedia.
 *
 * Provenance (vendored dist under /vendor/vad-web/, no CDN, no runtime
 * fetch outside this origin):
 *   - @ricky0123/vad-web@0.0.31 (latest on the sandbox registry; onnxruntime
 *     transitive dep resolved to onnxruntime-web@1.30.0)
 *   - dist files vendored as-is: bundle.min.js (UMD browser build),
 *     vad.worklet.bundle.min.js (worklet), silero_vad_v5.onnx
 *     (also copied to the locked name silero-vad.onnx), ort/ = vendored
 *     onnxruntime-web wasm runtime (ort.wasm.bundle.min.mjs + glue .mjs +
 *     ort-wasm-simd-threaded.wasm)
 *   - the installed dist has NO ESM build; /vendor/vad-web/vad.web.min.js is
 *     a 15-line ESM entry that loads the unmodified UMD dist and re-exports
 *     MicVAD (see that file's header)
 *
 * Installed-version option names (verified against the shipped real-time-vad
 * .d.ts - they differ from the names quoted in build-plan feature 10):
 *   - stream          -> getStream: () => Promise<MediaStream>  (we hand back
 *     OUR stream so there is exactly ONE getUserMedia call, below)
 *   - workletURL      -> baseAssetPath + "vad.worklet.bundle.min.js"
 *   - modelURL        -> baseAssetPath + modelFiles[model] (model: "v5")
 *   - audioContext    -> audioContext (SUPPORTED: we pass the shared
 *     AudioContext singleton from audio.js)
 *   - the defaults for pauseStream stop the tracks and resumeStream re-runs
 *     getUserMedia - BOTH are overridden so consent uncheck/recheck only
 *     pause()/start() the SAME MicVAD instance on the SAME live stream
 *     (library-docs gotcha: never re-new(); double AudioContexts duplicate
 *     the mic bars).
 *
 * 16 kHz guarantee: the shared AudioContext runs at the device rate, but the
 * vendored worklet resamples to 16 kHz mono before emitting frames
 * (Resampler in vad.worklet.bundle.min.js), and onSpeechEnd yields 16 kHz
 * mono Float32Array - nothing raw-rate is ever encoded or shipped.
 *
 * Endpointing trim (Task 20-a, interactive latency): the vendored 0.0.31
 * FrameProcessor is MS-BASED - defaultFrameProcessorOptions = {
 * positiveSpeechThreshold: 0.3, negativeSpeechThreshold: 0.25,
 * preSpeechPadMs: 800, redemptionMs: 1400, minSpeechMs: 400 } (read from
 * the shipped bundle.min.js) - and it converts ms to frames internally via
 * floor(redemptionMs / msPerFrame). A `redemptionFrames` OPTION IS
 * IGNORED by this build (verified: the name appears only as the internal
 * computed field; MicVAD.new forwards exactly positiveSpeechThreshold /
 * negativeSpeechThreshold / redemptionMs / preSpeechPadMs / minSpeechMs /
 * submitUserSpeechOnPause). The verified equivalent of the newer
 * `redemptionFrames: 5` convention (5 x 96 ms frames = ~480 ms of
 * trailing silence) is therefore `redemptionMs: 480`: the v5 model runs
 * 512-sample frames at 16 kHz = 32 ms/frame, so 480 ms = 15 frames -
 * the same wall-clock target, cut-off risk kept low versus the shipped
 * 1400 ms default (~43 frames) which made turn-taking feel sluggish.
 * positiveSpeechThreshold stays at its 0.3 default.
 *
 * Mic-level feed (Task 21-a): the bar loop offers its RAW rms to ONE
 * optional subscriber (subscribeMicLevels), invoked right after
 * renderMicLevels inside try/catch - a subscriber error is logged once and
 * the subscriber detached, never killing the bar loop. app.js feeds it to
 * the barge.js energy gate (feature 15 fallback: Silero cannot fire a NEW
 * onSpeechStart when the user talks over the bot inside an already-open
 * speech segment, so an energy gate on the raw rms is the barge trigger
 * while bot audio plays). The subscriber reference is cleared in
 * teardownMic.
 *
 * Utterance energy floor (Task 23): onSpeechEnd drops utterances whose
 * whole-utterance rms is below UTTERANCE_RMS_FLOOR so faint room noise /
 * distant sounds never become user turns (see the constant's provenance).
 */

import { MicVAD } from "/vendor/vad-web/vad.web.min.js";
import { getAudioContext, resumeAudioContext } from "./audio.js";
import { renderMicLevels, resetMicLevels } from "./ui.js";

/** Socket protocol sample rate for utterance chunks (architecture.md). */
const SAMPLE_RATE = 16000;
/**
 * PCM bytes per utterance chunk: 24000 decoded bytes -> ~32000 base64 chars,
 * both under the canonical AUDIO_CHUNK_MAX_BYTES cap of 32768 (code-standards
 * table; the canonical value itself is server/voice-service owned, so the
 * client mirrors the bound here with provenance).
 */
const PCM_CHUNK_BYTES = 24000;
/** VU-meter smoothing: rms x gain, clamped to 0..1. */
const BAR_LEVEL_GAIN = 6;
const BAR_COUNT = 5;
/** Per-utterance ring buffer capacity: 30 s of 16 kHz mono samples. */
const RING_CAPACITY_SAMPLES = 16000 * 30;
/**
 * Task 23: utterance energy floor - drop utterances whose robust loudness
 * (sqrt mean square over the whole utterance) is below this so room noise /
 * distant faint sounds never become turns; close-mic speech sits an order
 * of magnitude above (typ. 0.05-0.35 rms vs quiet-room ambience 0.002-0.02,
 * both on the same AnalyserNode time-domain rms scale the meter uses).
 */
const UTTERANCE_RMS_FLOOR = 0.03;

/** @type {MediaStream | null} the ONE getUserMedia stream for the page */
let micStream = null;
/** @type {object | null} the ONE MicVAD instance (never re-new()ed) */
let micVad = null;
/** @type {Promise<void> | null} in-flight initMic (memoized: init once) */
let initPromise = null;
let micReady = false;
/** @type {AnalyserNode | null} mic level meter on the shared context */
let analyser = null;
/** @type {MediaStreamAudioSourceNode | null} analyser feed */
let analyserSource = null;
/** @type {number | null} requestAnimationFrame handle for the bar loop */
let barLoopRafId = null;
/** @type {Float32Array | null} reused time-domain read buffer */
let timeDomainBuffer = null;
/** @type {Array<{seq: number, pcmBase64: string, sampleRate: number}> | null} */
let lastUtteranceChunks = null;
/** @type {((rms: number) => void) | null} the ONE mic-level subscriber */
let micLevelSubscriber = null;

/**
 * Per-utterance ring buffer: SpeechStart resets it, each 16 kHz VAD frame is
 * pushed, SpeechEnd flushes it. Wraps around (oldest dropped) at capacity.
 */
const ring = {
  buffer: new Float32Array(RING_CAPACITY_SAMPLES),
  writeIndex: 0,
  filled: 0,
  /** Drop any partial utterance (new SpeechStart or misfire). */
  reset() {
    this.writeIndex = 0;
    this.filled = 0;
  },
  /** @param {Float32Array} frame 16 kHz mono samples from the VAD worklet */
  push(frame) {
    for (let i = 0; i < frame.length; i += 1) {
      this.buffer[this.writeIndex] = frame[i];
      this.writeIndex = (this.writeIndex + 1) % RING_CAPACITY_SAMPLES;
    }
    this.filled = Math.min(this.filled + frame.length, RING_CAPACITY_SAMPLES);
  },
  /** Oldest-to-newest snapshot of the buffered utterance audio. */
  readAll() {
    const out = new Float32Array(this.filled);
    const start = this.filled < RING_CAPACITY_SAMPLES
      ? 0
      : this.writeIndex;
    out.set(this.buffer.subarray(start, start + this.filled));
    return out;
  },
};

/**
 * Encode one 16 kHz mono Float32Array utterance into socket-ready chunks:
 * Float32 [-1, 1] -> Int16 PCM (little endian) -> base64, split so every
 * base64 string stays under the 32 KB socket frame cap. Consumed by the
 * feature 11 voice socket; feature 10 only holds the result in memory.
 *
 * @param {Float32Array} float32Audio 16 kHz mono samples (VAD utterance)
 * @returns {Array<{seq: number, pcmBase64: string, sampleRate: number}>}
 */
export function encodeUtteranceChunks(float32Audio) {
  if (!(float32Audio instanceof Float32Array) || float32Audio.length === 0) {
    return [];
  }
  const pcm = new Int16Array(float32Audio.length);
  for (let i = 0; i < float32Audio.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Audio[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += PCM_CHUNK_BYTES) {
    const end = Math.min(offset + PCM_CHUNK_BYTES, bytes.length);
    chunks.push({
      seq: chunks.length,
      pcmBase64: bytesToBase64(bytes.subarray(offset, end)),
      sampleRate: SAMPLE_RATE,
    });
  }
  return chunks;
}

/**
 * Base64 one Uint8Array in sub-chunks (String.fromCharCode spread is
 * stack-limited, so never apply more than 8192 bytes at once).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  let binary = "";
  const APPLY_CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += APPLY_CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + APPLY_CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Register the ONE consumer of the raw mic rms (Task 21-a): invoked ~60 Hz
 * from the bar loop right after renderMicLevels. app.js uses it to feed the
 * barge.js energy gate; a later call replaces the previous subscriber
 * (there is only ever one). A subscriber that throws is detached (warned
 * once) so the bar loop always survives - see startBarLoop.
 *
 * @param {(rms: number) => void} fn subscriber receiving the raw rms value
 * @returns {void}
 */
export function subscribeMicLevels(fn) {
  if (typeof fn === "function") micLevelSubscriber = fn;
}

/**
 * Chunks of the most recent flushed utterance - the feature 11 socket
 * handoff point (feature 10 keeps them in memory only, no socket code).
 *
 * @returns {Array<{seq: number, pcmBase64: string, sampleRate: number}> | null}
 */
export function getLastUtteranceChunks() {
  return lastUtteranceChunks;
}

/**
 * True once initMic has fully succeeded (stream + VAD + meter live). Start
 * Call stays disabled until this is true AND consent is checked.
 *
 * @returns {boolean}
 */
export function isMicReady() {
  return micReady;
}

/**
 * The ONE live mic stream (feature 21 quick path): recorder.js taps this to
 * record the call audio. Null before initMic succeeds or after teardown.
 *
 * @returns {MediaStream | null}
 */
export function getMicStream() {
  return micStream;
}

/**
 * Initialize mic capture + VAD + the level meter. MUST only be called after
 * the consent checkbox is checked (H-B5): app.js enforces the gate, and this
 * function additionally refuses when the consent flag argument is not true.
 * Memoized - every later call while ready or in flight returns the same
 * result, so getUserMedia runs exactly once per page.
 *
 * @param {object} options
 * @param {boolean} options.consent must be exactly true (consent checkbox)
 * @param {() => void} [options.onSpeechStart] forwarded VAD callback
 * @param {(audio: Float32Array) => void} [options.onSpeechEnd] forwarded
 * @returns {Promise<void>} resolves when the mic is live and ready
 */
export function initMic({ consent, onSpeechStart, onSpeechEnd }) {
  if (consent !== true) {
    return Promise.reject(new Error("[vad] initMic refused: consent flag is not true"));
  }
  if (micReady) return Promise.resolve();
  if (initPromise !== null) return initPromise;
  initPromise = startMic({ onSpeechStart, onSpeechEnd });
  return initPromise;
}

/** Monotonic generation for startMic attempts (Task 25: hung-init escape). */
let initEpoch = 0;

/**
 * Abandon a possibly-hung mic init (Task 25): a getUserMedia whose prompt
 * never surfaces (preview iframe, dismissed prompt) keeps initPending
 * FOREVER, and initMic memoizes it - so uncheck/recheck consent re-awaited
 * the same dead promise and the UI was stuck on "Waiting for mic
 * permission" even after the user granted permission elsewhere.
 *
 * Call this before a RETRY when the mic is not ready: it invalidates any
 * in-flight startMic (its late settle is ignored + its stream stopped) and
 * lets the next initMic start a FRESH getUserMedia, which succeeds
 * instantly once the site-level permission is granted.
 */
export function resetMicInit() {
  if (micReady) return;
  initEpoch += 1;
  initPromise = null;
}

/**
 * Internal init body: the single getUserMedia call, the analyser tap on the
 * shared AudioContext, and MicVAD.new over the same stream. On any failure
 * the partial state is torn down (tracks stopped, meter detached) and the
 * error rethrown so the next consent check can retry cleanly.
 *
 * @param {object} handlers
 * @param {() => void} [handlers.onSpeechStart]
 * @param {(audio: Float32Array) => void} [handlers.onSpeechEnd]
 * @returns {Promise<void>}
 */
async function startMic({ onSpeechStart, onSpeechEnd }) {
  const epoch = (initEpoch += 1); // Task 25: supersede detection
  let stream = null;
  try {
    // The ONE getUserMedia call on the page (consent gate enforced upstream).
    // Task 22: some devices/drivers fail CONSTRAINT processing with
    // NotFoundError / OverconstrainedError / NotReadableError even though a
    // bare audio request would succeed - retry once with bare constraints
    // before giving up (the outer catch still tears down + rethrows the
    // final error so app.js can surface its per-error copy).
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      const retryable = error instanceof Error &&
        ["NotFoundError", "OverconstrainedError", "NotReadableError"].includes(error.name);
      if (!retryable) throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    micStream = stream;

    // Level meter: same stream -> shared context -> AnalyserNode (never to
    // destination: no local monitoring feedback).
    const context = getAudioContext();
    // Resume the shared context but NEVER block init on it: the resume
    // promise stays pending forever under autoplay policy without user
    // activation, and addModule/nodes below work on a suspended context.
    void resumeAudioContext();
    analyserSource = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyserSource.connect(analyser);
    timeDomainBuffer = new Float32Array(analyser.fftSize);
    startBarLoop();

    micVad = await MicVAD.new({
      model: "v5",
      baseAssetPath: "/vendor/vad-web/",
      onnxWASMBasePath: "/vendor/vad-web/ort/",
      audioContext: context,
      processorType: "auto",
      startOnLoad: true,
      getStream: async () => stream,
      // Task 20-a endpointing trim (see the module header): ~480 ms of
      // trailing silence instead of the shipped 1400 ms redemptionMs -
      // the verified ms-based equivalent of the newer
      // `redemptionFrames: 5` option, which THIS 0.0.31 build ignores.
      redemptionMs: 480,
      // Never stop OUR tracks on pause(); the stream stays alive for the
      // meter, the feature 16 recorder and uncheck/recheck resumes.
      pauseStream: async () => undefined,
      // Never re-run getUserMedia on start(); reuse the SAME live stream.
      resumeStream: async () => stream,
      onSpeechStart: () => {
        ring.reset();
        if (typeof onSpeechStart === "function") onSpeechStart();
      },
      onFrameProcessed: (_probs, frame) => {
        ring.push(frame);
      },
      onSpeechEnd: (audio) => {
        const utterance = audio instanceof Float32Array && audio.length > 0
          ? audio
          : ring.readAll();
        // Task 23: energy floor - compute the robust loudness (sqrt mean of
        // squares over the whole utterance) and drop utterances below
        // UTTERANCE_RMS_FLOOR so room noise / distant faint sounds never
        // become user turns. The ring already reset on speech start, so no
        // reset here. Non-finite guard: a non-Float32Array or empty input
        // keeps the existing behavior unchanged.
        if (utterance instanceof Float32Array && utterance.length > 0) {
          let sumSquares = 0;
          for (let i = 0; i < utterance.length; i += 1) {
            sumSquares += utterance[i] * utterance[i];
          }
          const utteranceRms = Math.sqrt(sumSquares / utterance.length);
          if (utteranceRms < UTTERANCE_RMS_FLOOR) {
            console.debug(
              `[vad] utterance dropped: below energy floor (rms=${utteranceRms.toFixed(3)})`,
            );
            return;
          }
        }
        lastUtteranceChunks = encodeUtteranceChunks(utterance);
        // Feature 10 holds the chunks in memory; feature 11's socket will
        // stream them. Chunk count + size here, never per-frame logging.
        console.debug(
          `[vad] utterance flushed: ${lastUtteranceChunks.length} chunk(s), ` +
          `${utterance.length} samples @ ${SAMPLE_RATE} Hz`,
        );
        if (typeof onSpeechEnd === "function") onSpeechEnd(utterance);
      },
    });
    // Task 25: a resetMicInit() during this attempt (hung prompt retried)
    // invalidates THIS attempt - stop its stream and resolve silently so a
    // late settle never fights the newer attempt or fakes a ready state.
    if (epoch !== initEpoch) {
      try {
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        // already dead - nothing to do
      }
      return;
    }
    micReady = true;
  } catch (error) {
    // Superseded attempt failing late: never tear down the newer attempt's
    // state - just stop own tracks and rethrow (app.js ignores stale
    // rejections via its isMicReady() result guard).
    if (epoch !== initEpoch) {
      try {
        if (stream) stream.getTracks().forEach((track) => track.stop());
      } catch {
        // already dead - nothing to do
      }
      throw error;
    }
    teardownMic();
    throw error;
  }
}

/**
 * Pause the SAME MicVAD instance (consent unchecked while idle; stream and
 * VAD object stay alive - re-checking consent resumes without re-prompting).
 * Flattens the mic bars and stops the meter loop. Never rejects.
 *
 * @returns {Promise<void>}
 */
export async function pauseMic() {
  stopBarLoop();
  resetMicLevels();
  if (micVad === null || !micReady) return;
  try {
    await micVad.pause();
  } catch (error) {
    console.warn(
      "[vad] pause failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Resume the SAME MicVAD instance on consent re-check (never re-new());
 * restarts the meter loop. Never rejects.
 *
 * @returns {Promise<void>}
 */
export async function resumeMic() {
  if (micVad === null || !micReady) return;
  try {
    await micVad.start();
    startBarLoop();
  } catch (error) {
    console.warn(
      "[vad] resume failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** rAF meter loop: time-domain RMS -> per-bar 0..1 fill levels. */
function startBarLoop() {
  if (barLoopRafId !== null || analyser === null || timeDomainBuffer === null) {
    return;
  }
  const loop = () => {
    if (analyser === null || timeDomainBuffer === null) return;
    analyser.getFloatTimeDomainData(timeDomainBuffer);
    let sumSquares = 0;
    for (let i = 0; i < timeDomainBuffer.length; i += 1) {
      sumSquares += timeDomainBuffer[i] * timeDomainBuffer[i];
    }
    const rms = Math.sqrt(sumSquares / timeDomainBuffer.length);
    const level = Math.min(1, rms * BAR_LEVEL_GAIN);
    const lit = level * BAR_COUNT;
    const levels = [];
    for (let bar = 0; bar < BAR_COUNT; bar += 1) {
      levels.push(Math.max(0, Math.min(1, lit - bar)));
    }
    renderMicLevels(levels);
    // Task 21-a: offer the RAW rms to the single subscriber (app.js feeds
    // the barge energy gate with it). A subscriber error must never kill
    // the bar loop: warn once and detach.
    if (micLevelSubscriber !== null) {
      try {
        micLevelSubscriber(rms);
      } catch (error) {
        console.warn(
          "[vad] mic level subscriber failed (detached):",
          error instanceof Error ? error.message : String(error),
        );
        micLevelSubscriber = null;
      }
    }
    barLoopRafId = requestAnimationFrame(loop);
  };
  barLoopRafId = requestAnimationFrame(loop);
}

/** Stop the meter loop and drop its pending frame (if any). */
function stopBarLoop() {
  if (barLoopRafId !== null) {
    cancelAnimationFrame(barLoopRafId);
    barLoopRafId = null;
  }
}

/**
 * Tear down EVERYTHING this module owns (init failure path): meter nodes,
 * rAF loop, VAD reference, and the mic tracks so a failed init never leaves
 * a captured device open (least privilege).
 */
function teardownMic() {
  stopBarLoop();
  resetMicLevels();
  if (analyserSource !== null) {
    analyserSource.disconnect();
    analyserSource = null;
  }
  analyser = null;
  timeDomainBuffer = null;
  micVad = null;
  micReady = false;
  lastUtteranceChunks = null;
  // Task 21-a: the mic-level subscriber dies with the mic (app.js holds
  // the gate side; a re-init re-registers through subscribeMicLevels).
  micLevelSubscriber = null;
  initPromise = null;
  if (micStream !== null) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  ring.reset();
}
