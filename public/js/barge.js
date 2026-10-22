/**
 * barge.js - energy-gate barge-in fallback (Task 21-a, feature 15).
 *
 * WHY: the client barge path (Silero VAD onSpeechStart -> app.js
 * handleSpeechStart -> barge-in + player flush) only fires when a NEW VAD
 * speech segment starts. When the user talks over the bot, Silero is often
 * ALREADY inside a speech segment (overlap), so NO new onSpeechStart fires
 * and the bot's sentence plays to the end. This module is the fallback: it
 * watches the raw mic rms (fed ~60 Hz from the vad.js bar loop through
 * subscribeMicLevels) and fires the SAME onBarge callback when the level
 * says someone is talking over the bot.
 *
 * How the gate avoids self-barging (the bot's own audio leaking back
 * through the speakers into the mic):
 *   - ARM: levels are ignored for ARM_DELAY_MS after playback starts, so
 *     the first leak transient can never fire the gate.
 *   - Rolling-min baseline: the baseline is the MINIMUM level of the last
 *     BASELINE_WINDOW_MS. Humans always have 20-80 ms inter-word dips, so
 *     the min captures the true floor even during continuous speech;
 *     during bot-only playback through speakers the AEC leak is sustained
 *     with no dips, so min ~ current level and the trigger threshold
 *     (max(LEVEL_FLOOR, baseline * BASELINE_FACTOR)) stays above the leak.
 *   - Sustain: the CURRENT level AND every level observed in the last
 *     TRIGGER_SUSTAIN_MS must be strictly above the threshold - a single
 *     loud frame never fires.
 *   - Cooldown + unacked budget: after a fire the gate is deaf for
 *     COOLDOWN_MS; MAX_UNACKED fires without a markUserTurn() in between
 *     (3 barges that produced no user turn - the pathological AEC-less
 *     speaker loop) DISABLE the gate until the next markUserTurn()
 *     re-enables it.
 *
 * The module is pure and log-free for its own decisions (H-G4 posture:
 * app.js owns any warning) and never throws - the caller's onBarge is
 * invoked inside try/catch.
 */

/**
 * Ignore levels for this long after playback starts (ms): the first leak
 * transient of the bot audio must never self-barge.
 */
const ARM_DELAY_MS = 300;

/** Baseline window (ms): the rolling min covers the last 1000 ms of levels. */
const BASELINE_WINDOW_MS = 1000;

/**
 * Sustain window (ms): the CURRENT level and every level observed in the
 * last 150 ms must sit above the threshold - one loud frame never fires.
 */
const TRIGGER_SUSTAIN_MS = 150;

/**
 * Absolute level floor: the min-based threshold never drops below this, so
 * a near-silent leak baseline cannot let room noise count as speech.
 * Task 23: 0.045 -> 0.06 so small ambient bumps under ~0.06 can never barge
 * the bot; the rolling-min baseline rule still dominates for loud rooms.
 */
const LEVEL_FLOOR = 0.06;

/**
 * Trigger factor: speech over the bot sits far above the leak floor, so the
 * level must exceed 2.2x the rolling-min baseline to count as a barge.
 */
const BASELINE_FACTOR = 2.2;

/** Deaf period after a fire (ms): lets the flush + turn switch settle. */
const COOLDOWN_MS = 1500;

/**
 * Fires without a markUserTurn() before the gate disables itself: 3 barges
 * that produced no user turn is the pathological AEC-less speaker loop.
 */
const MAX_UNACKED = 3;

/**
 * Create the energy-gate barge fallback (Task 21-a). While bot audio is NOT
 * playing the gate is inert (it only resets its state - zero risk in
 * silence); while it IS playing, push(level) compares the mic rms against
 * the rolling-min baseline and fires onBarge on a sustained exceedance.
 *
 * @param {object} options
 * @param {() => boolean} options.isPlaying true while bot audio is actually
 *   playing (the caller's own barge handler re-checks isPlaying before
 *   acting - the gate only signals)
 * @param {() => void} options.onBarge called when the gate fires (wrapped
 *   in try/catch: a throwing handler warns and never breaks the feed)
 * @param {() => number} [options.now] monotonic ms clock, defaults to
 *   () => performance.now() (injectable for offline tests)
 * @returns {{push: (level: number) => void, markUserTurn: () => void}}
 *   frozen gate handle: push (feed one mic rms sample) and markUserTurn
 *   (a real user utterance was sent after a barge)
 */
export function createBargeEnergyGate({ isPlaying, onBarge, now } = {}) {
  const clock = typeof now === "function" ? now : () => performance.now();
  /** Stored {t, level} samples of the last BASELINE_WINDOW_MS (pruned). */
  const ring = [];
  /** True when the previous push saw the bot playing (rising-edge detect). */
  let wasPlaying = false;
  /** ARM deadline on the ms clock: levels before it are ignored. */
  let armUntilMs = -1;
  /** Cooldown deadline on the ms clock: levels before it are ignored. */
  let cooldownUntilMs = -1;
  /** Barges fired since the last markUserTurn(). */
  let unackedBarges = 0;
  /** Disabled by the unacked budget; markUserTurn() re-enables. */
  let disabled = false;

  /**
   * Feed one mic rms sample (~60 Hz from the vad bar loop). Inert while no
   * bot audio plays (state reset only). Never throws, never logs.
   *
   * @param {number} level raw mic rms sample (0..1-ish, as the meter uses)
   * @returns {void}
   */
  function push(level) {
    if (disabled) return; // unacked budget spent - markUserTurn re-enables
    if (typeof level !== "number" || !Number.isFinite(level)) return; // defensive: never poison the ring
    const t = clock();
    if (isPlaying() !== true) {
      // Inert in silence: reset the observation state and leave.
      wasPlaying = false;
      armUntilMs = -1;
      cooldownUntilMs = -1;
      ring.length = 0;
      return;
    }
    if (!wasPlaying) {
      // Playback just started (rising edge detected inside push): arm the
      // self-barge guard and ignore this first level. The ARM "timer" is
      // the deadline check below - no setTimeout; the push stream drives
      // it, which keeps the gate correct in hidden tabs (rAF pauses there).
      wasPlaying = true;
      armUntilMs = t + ARM_DELAY_MS;
      return;
    }
    if (t < armUntilMs) return; // ARM: ignore the first-leak transient
    if (t < cooldownUntilMs) return; // cooldown: ignore all levels
    ring.push({ t, level });
    while (ring.length > 0 && ring[0].t < t - BASELINE_WINDOW_MS) {
      ring.shift(); // the baseline only sees the last BASELINE_WINDOW_MS
    }
    // Rolling-min baseline (rationale in the module header): the minimum
    // over the window captures the true floor through inter-word dips.
    let baseline = Infinity;
    for (const sample of ring) {
      if (sample.level < baseline) baseline = sample.level;
    }
    const threshold = Math.max(LEVEL_FLOOR, baseline * BASELINE_FACTOR);
    // Trigger: the current level AND every level observed in the last
    // TRIGGER_SUSTAIN_MS are strictly above the threshold. The current
    // sample was just pushed, so the scan below covers it; the min-based
    // threshold self-protects a sparse ring (baseline ~ current there).
    const sustainSince = t - TRIGGER_SUSTAIN_MS;
    for (let i = ring.length - 1; i >= 0; i -= 1) {
      const sample = ring[i];
      if (sample.t < sustainSince) break;
      if (!(sample.level > threshold)) return; // dip inside the window
    }
    // Fired: hand to the caller (its handler re-checks isPlaying), go deaf
    // for COOLDOWN_MS, and count the unacked barge.
    try {
      onBarge();
    } catch (error) {
      console.warn(
        "[barge] barge handler failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    cooldownUntilMs = t + COOLDOWN_MS;
    unackedBarges += 1;
    if (unackedBarges >= MAX_UNACKED) disabled = true;
  }

  /**
   * The caller signals that a real user utterance was sent after a barge:
   * reset the unacked budget and (if the budget had disabled the gate)
   * re-enable it. Never throws.
   *
   * @returns {void}
   */
  function markUserTurn() {
    unackedBarges = 0;
    disabled = false;
  }

  return Object.freeze({ push, markUserTurn });
}
