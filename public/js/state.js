/**
 * state.js - the REAL console call state machine (build-plan features
 * 09 + 15).
 *
 * Plain-JS module, NO state library, NO virtual DOM: transitions drive the
 * existing DOM nodes directly. The state names + transitions below are the
 * locked contract - features 10-19 swap the mock effects for the real
 * pipeline (voice stages, recorder, summary API) and never reshape this
 * machine.
 *
 * Transition map:
 *
 *   idle    --startCall (consent checked)-->   in_call
 *   in_call --endCall-->                       ending
 *   ending  --summaryReady (real summary)-->   summary
 *   summary --newCall (reset)-->               idle
 *
 * Feature 15: the // MOCK (feature 09) stage cycler and the in-call
 * bubble effects are DELETED. During in_call the machine self-animates
 * nothing: the status line is owned by the REAL sources (socket stage
 * events, SpeechPlayer playback start/end, call:error) and the
 * transcript starts EMPTY, filling with real turn:final bubbles.
 *
 * Feature 19 (Task 18-c): the // MOCK (feature 09) 3 s summary delay is
 * DELETED - after endCall the machine rests in `ending` while app.js
 * POSTs the real summary; summaryReady() moves it to `summary` once the
 * real card is rendered (the // MOCK "Interested" chip + mock history
 * rows are retired - the card/chip/list render from real API data).
 */

import {
  dom,
  renderTranscriptEmpty,
  renderSummary,
  renderHistory,
  setCallChip,
  setTimerText,
} from "./ui.js";

/** The four machine states - the real shape features 10-19 build against. */
export const CALL_STATES = Object.freeze({
  IDLE: "idle",
  IN_CALL: "in_call",
  ENDING: "ending",
  SUMMARY: "summary",
});

// Locked status-line copy (byte-identical to ui-rules.md ss Console card).
// ENDING_STATUS is exported so the feature 19 summary-success path (app.js)
// can restore the exact same copy after a "Summary failed." recovery - the
// natural post-summary line in the non-failure flow is this same constant.
const IDLE_STATUS_NO_CONSENT = "Enable recording consent to begin.";
const IDLE_STATUS_READY = "Ready when you are.";
export const ENDING_STATUS = "Call ended — generating summary…";

const TIMER_TICK_MS = 1000;

/**
 * Create the call state machine. One instance per page (app.js wires the
 * DOM events to its methods).
 *
 * @returns {{setConsent: Function, start: Function, end: Function, summaryReady: Function, reset: Function, getState: Function}}
 */
export function createCallMachine() {
  let state = CALL_STATES.IDLE;
  let consentChecked = false;
  let timerIntervalId = null;
  let callStartedAtMs = 0;

  /** Clear every pending machine timer (timer tick). */
  function clearAllTimers() {
    if (timerIntervalId !== null) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
    }
  }

  /** Real mm:ss elapsed since the call started, rendered into the timer chip. */
  function startTimer() {
    callStartedAtMs = Date.now();
    setTimerText("00:00");
    timerIntervalId = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - callStartedAtMs) / 1000);
      setTimerText(formatMmSs(elapsedSeconds));
    }, TIMER_TICK_MS);
  }

  /** @param {number} totalSeconds @returns {string} mm:ss */
  function formatMmSs(totalSeconds) {
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  // -- transitions ---------------------------------------------------------

  /**
   * idle: consent checkbox changed. Enabled Start Call + "Ready when you
   * are." when checked, back to the disabled gate copy when unchecked.
   *
   * @param {boolean} checked
   * @returns {void}
   */
  function setConsent(checked) {
    if (state !== CALL_STATES.IDLE) return;
    consentChecked = checked;
    dom.startButton.disabled = checked !== true;
    dom.statusLine.textContent = checked === true ? IDLE_STATUS_READY : IDLE_STATUS_NO_CONSENT;
  }

  /** idle -> in_call (Start Call clicked with consent). */
  function start() {
    if (state !== CALL_STATES.IDLE || consentChecked !== true) return;
    state = CALL_STATES.IN_CALL;
    dom.startButton.hidden = true;
    dom.endButton.hidden = false;
    dom.consentRow.hidden = true;
    setCallChip("IN CALL", "live");
    // Feature 15: the transcript starts EMPTY - real customer/bot
    // bubbles appear via turn:final as the live turns land.
    renderTranscriptEmpty();
    startTimer();
    // The machine writes NO in-call status of its own: the status line
    // belongs to the REAL sources from here (the connected channel's
    // stage events - the handshake's "Listening…" and the per-turn
    // dance - plus the SpeechPlayer's playback start/end and call:error).
  }

  /**
   * in_call -> ending (End Call clicked): stop the timer, ending copy,
   * skeleton. Feature 19: the // MOCK (feature 09) 3 s delay is GONE - the
   * machine stays in `ending` while app.js POSTs the REAL summary and
   * calls summaryReady() once the real card is rendered (or the locked
   * "Summary failed." + Retry shows on API failure).
   */
  function end() {
    if (state !== CALL_STATES.IN_CALL) return;
    state = CALL_STATES.ENDING;
    clearAllTimers();
    dom.endButton.hidden = true;
    dom.startButton.hidden = false;
    dom.startButton.disabled = true; // not idle: the gate stays closed
    dom.consentRow.hidden = false; // console returns to non-call layout
    setCallChip("READY", "ready");
    dom.statusLine.textContent = ENDING_STATUS;
    renderSummary("skeleton");
  }

  /**
   * ending -> summary (feature 19): the REAL summary POST succeeded and
   * app.js rendered the real card - the machine only records the state
   * transition. (The // MOCK (feature 09) "Interested" chip render and
   * the mock history rows are retired; the card, chip and list render
   * from real API data.)
   */
  function summaryReady() {
    if (state !== CALL_STATES.ENDING) return;
    state = CALL_STATES.SUMMARY;
  }

  /** summary -> idle (New Call): reset everything to the pristine gate. */
  function reset() {
    if (state !== CALL_STATES.SUMMARY) return;
    state = CALL_STATES.IDLE;
    clearAllTimers();
    consentChecked = false;
    dom.consentInput.checked = false;
    dom.startButton.hidden = false;
    dom.startButton.disabled = true;
    dom.endButton.hidden = true;
    dom.consentRow.hidden = false;
    setCallChip("READY", "ready");
    setTimerText("00:00");
    dom.statusLine.textContent = IDLE_STATUS_NO_CONSENT;
    renderTranscriptEmpty();
    renderSummary("hidden");
    renderHistory("empty");
  }

  return Object.freeze({
    setConsent,
    start,
    end,
    summaryReady,
    reset,
    getState: () => state,
  });
}
