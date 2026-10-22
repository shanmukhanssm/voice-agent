/**
 * app.js - ES-module boot entry for the AI Voice Sales Agent page.
 *
 * Phase 2 scope (build-plan features 05-09): console card, transcript
 * panel, post-call summary card, history section and the REAL call state
 * machine (public/js/state.js). Feature 15 deleted the // MOCK (feature
 * 06/09) in-call pieces - the seeded transcript, the status cycler and
 * the cycler-driven mock bubbles are gone.
 *
 * Phase 3 adds feature 10 (Mic capture & VAD): consent-check is the user
 * gesture that resumes the shared AudioContext and initializes the mic
 * exactly once (public/js/audio.js + public/js/vad.js); Start Call is
 * gated on consent AND mic ready; feature 10 owns only the IDLE-state
 * status line, the Start gating and the live mic bars - the feature 09
 * machine and its mock pipeline are untouched.
 *
 * Feature 11 adds the voice socket channel (public/js/socket.js): one
 * channel per call alongside the feature 09 machine. While a channel is
 * CONNECTED its real stage events own the status line; call:error renders
 * its userMessage verbatim. Features 12-15 own the VAD-to-socket glue,
 * the real transcript bubbles, the SpeechPlayer and barge-in.
 *
 * Phase 4 (Task 18-c) wires the client to the REAL calls API
 * (server/routes/calls.js + summary.js, the ONE envelope from
 * server/lib/envelope.js: success = 2xx { ok: true, data }, failure =
 * non-2xx { ok: false, error: { code, message } }):
 *
 * - Feature 18-c: the navbar voice chip is LIVE - /api/health polled on
 *   boot + every 10 s (data.voice === "up" -> ONLINE, anything else ->
 *   OFFLINE); while a call is live the voice socket connect state
 *   overrides the badge until the next poll. The static OFFLINE markup is
 *   the honest pre-poll default.
 * - Feature 17 client half: Start Call generates ONE callId for both the
 *   persistence row (POST /api/calls) and the socket handshake; every
 *   turn:final is relayed to POST /api/calls/[id]/turns with a per-call
 *   monotonic idx (the server's opener greeting is idx 0) through a tiny
 *   in-memory queue - 404/network keeps the turn queued until the row
 *   create succeeds. Persistence NEVER breaks the call UI.
 * - Feature 19: End Call POSTs /api/calls/[id]/summary { durationSec }
 *   (the // MOCK (feature 09) 3 s delay is deleted from state.js); the
 *   real response renders into the summary card, failure shows the locked
 *   "Summary failed." + Retry (a 404 first re-creates the call row -
 *   idempotent - and drains the queued turns, then retries once).
 * - Features 20/23: the // MOCK (feature 08) history rows/templates are
 *   deleted; real rows render from GET /api/calls?limit=50 (newest
 *   first), a row click fetches GET /api/calls/[id] into the existing
 *   dialog, Delete runs the confirm dialog then DELETE /api/calls/[id]
 *   and refreshes the list.
 */

import {
  dom,
  setStatusLineShadow,
  writeStatusLine,
  VOICE_STAGE_STATUS,
  appendTranscriptBubble,
  renderHistory,
  renderSummary,
  setSummaryChip,
  setVoiceServiceChip,
} from "./ui.js";
import { createCallMachine, CALL_STATES, ENDING_STATUS } from "./state.js";
import { resumeAudioContext, createSpeechPlayer } from "./audio.js";
import { startCallRecording, stopAndUploadCallRecording } from "./recorder.js";
import { createBargeEnergyGate } from "./barge.js";
import {
  initMic,
  pauseMic,
  resumeMic,
  isMicReady,
  getLastUtteranceChunks,
  getMicStream,
  resetMicInit,
  subscribeMicLevels,
} from "./vad.js";
import { createVoiceChannel } from "./socket.js";
import { wireSettings } from "./settings.js";

// Feature 10 status-line copy (mirrored in build-plan feature 10 /
// ui-rules.md Console card; the em dash in the blocked copy is intentional).
// Task 22: EVERY mic failure now surfaces specific actionable copy - the old
// non-NotAllowed path only logged and left the stale consent gate text,
// which misread as a consent problem. New copy is ASCII-only.
const MIC_READY_STATUS = "Mic ready";
const MIC_CHECKING_STATUS = "Checking microphone...";
const MIC_WAIT_PERMISSION_STATUS =
  "Waiting for mic permission - if no prompt appeared, open the app in a new tab.";
const MIC_BLOCKED_STATUS = "Microphone blocked — allow mic access (or open the app in a new tab), then uncheck and re-check consent.";
const MIC_NOT_FOUND_STATUS =
  "No microphone found - connect or enable a mic, then uncheck and re-check consent.";
const MIC_BUSY_STATUS =
  "Microphone is in use by another app - close it, then uncheck and re-check consent.";
const MIC_CONSTRAINT_STATUS =
  "Microphone rejected the audio settings - uncheck and re-check consent to retry.";
const MIC_FAILED_STATUS = "Microphone error - uncheck and re-check consent to retry.";

// Task 22: how long a silent mic-permission prompt may stay pending before
// the status line explains what to do (e.g. a prompt suppressed inside a
// preview iframe keeps getUserMedia pending forever with no error).
const MIC_PERMISSION_WAIT_MS = 8000;

// Feature 11: grace between the call:end flush and the channel close (ms)
// so the final event drains before teardown.
const VOICE_CLOSE_GRACE_MS = 250;

// Feature 19: locked failure copy (build-plan feature 19 UI line).
const SUMMARY_FAILED_STATUS = "Summary failed.";

// Feature 18-c: navbar voice badge poll cadence (ms).
const VOICE_HEALTH_POLL_MS = 10000;

// Feature 19/20: salesStatus -> chip data-role, 1:1 with the six role
// chips the deleted // MOCK (feature 08) rows and the ?devchips=1 strip
// use (the closed enum is SUMMARY_JSON_SCHEMA in build-plan feature 19).
// Rows whose summary never completed render "No Response" (honest for a
// call with no AI verdict yet).
const SALES_STATUS_ROLES = Object.freeze({
  "Converted": "converted",
  "Interested": "interested",
  "Demo Requested": "demo-requested",
  "Follow-up Required": "follow-up-required",
  "Not Interested": "not-interested",
  "No Response": "no-response",
});

const reducedMotion =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Smooth-scroll the two navbar anchors (Console / History) to their sections,
 * honoring prefers-reduced-motion.
 */
function wireSmoothScroll() {
  const anchors = document.querySelectorAll('a[href^="#"]');
  anchors.forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      const hash = anchor.getAttribute("href");
      if (!hash || hash === "#") return;
      const target = document.querySelector(hash);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
      // move the single `active` nav state with the click (scroll-spy
      // refinement lands with the polish pass, feature 24)
      document
        .querySelectorAll(".nav-link")
        .forEach((link) => link.classList.toggle("active", link === anchor));
    });
  });
}

/** Stamp the current year on any [data-year] element (none exists yet). */
function stampYear() {
  const el = document.querySelector("[data-year]");
  if (el) el.textContent = String(new Date().getFullYear());
}

/** Defensive boundary: socket failures must never break the page UI. */
function logVoiceWarning(message, error) {
  console.warn("[voice]", message, error instanceof Error ? error.message : String(error));
}

/**
 * Feature 17/19/20 defensive boundary: calls-API failures log under the
 * '[calls]' prefix and never break the call UI or the page.
 */
function logCallsWarning(message, error) {
  console.warn("[calls]", message, error instanceof Error ? error.message : String(error));
}

/** Fresh call id per call (crypto.randomUUID; dated fallback for old engines). */
function newCallId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `call-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Local clock time as "HH:MM:SS" (24 h) - the transcript bubble timestamp
 * format of the real turn:final bubbles (feature 12; the same format the
 * deleted feature 06 mock bubbles used). An optional Date renders stored
 * timestamps (feature 20 dialog transcript).
 *
 * @param {Date} [date]
 * @returns {string}
 */
function currentClockTime(date) {
  const now = date instanceof Date ? date : new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** Local "HH:MM:SS" from an ISO timestamp (empty when unparseable). */
function clockTimeFromIso(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return currentClockTime(date);
}

/**
 * Feature 17/19/20 REST helper: fetch + parse the ONE envelope
 * (server/lib/envelope.js). Network failures REJECT (callers catch);
 * non-2xx or a malformed body resolves with data: null.
 *
 * @param {string} url relative API path (same origin)
 * @param {RequestInit} [options]
 * @returns {Promise<{status: number, data: unknown}>}
 */
async function fetchEnvelope(url, options) {
  const response = await fetch(url, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // non-JSON body -> data stays null (the status still tells the story)
  }
  const data = response.ok && body !== null && typeof body === "object" && body.ok === true
    ? body.data
    : null;
  return { status: response.status, data };
}

// -- Feature 20: REAL history list (the // MOCK (feature 08) rows are gone) -

/** Cached latest GET /api/calls?limit=50 rows (refreshHistory re-renders). */
let historyRows = [];

/** "Feb 12, 2026" - the date shape the deleted mock rows showed. */
function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return ""; // invalid/missing date -> empty, never breaks the row
  }
}

/** mm:ss from seconds, both parts padded to 2 (the mock rows' chip shape). */
function formatDuration(totalSeconds) {
  const total =
    typeof totalSeconds === "number" && Number.isFinite(totalSeconds) && totalSeconds > 0
      ? Math.floor(totalSeconds)
      : 0;
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/**
 * Feature 20 row chip mapping: status "in_progress" or a missing
 * salesStatus renders the "No Response" role + label (the honest chip for
 * a call whose summary never completed); completed rows map 1:1 through
 * SALES_STATUS_ROLES.
 *
 * @param {object} row one GET /api/calls row DTO
 * @returns {string} chip data-role
 */
function rowChipRole(row) {
  const status = typeof row.salesStatus === "string" ? row.salesStatus : "";
  return SALES_STATUS_ROLES[status] || "no-response";
}

/** @param {object} row @returns {string} chip label text */
function rowChipLabel(row) {
  const status = typeof row.salesStatus === "string" ? row.salesStatus : "";
  return SALES_STATUS_ROLES[status] ? status : "No Response";
}

/**
 * Build one REAL history row - the same markup/classes the deleted mock
 * rows used (text via textContent - strings are data, never markup).
 *
 * @param {object} row one GET /api/calls row DTO
 * @returns {HTMLLIElement}
 */
function buildHistoryRow(row) {
  const li = document.createElement("li");
  li.className = "history-row";
  li.setAttribute("data-call-id", typeof row.submissionId === "string" ? row.submissionId : "");

  const main = document.createElement("button");
  main.className = "history-row-main";
  main.type = "button";
  main.setAttribute("data-call-open", "");
  main.setAttribute("aria-haspopup", "dialog");

  const chip = document.createElement("span");
  chip.className = "status-chip status-chip--sm";
  chip.setAttribute("data-role", rowChipRole(row));
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "status-label";
  label.textContent = rowChipLabel(row);
  chip.append(dot, label);

  const mainText = document.createElement("span");
  mainText.className = "history-main";
  const name = document.createElement("span");
  name.className = "history-name";
  name.textContent = "FlowSmith demo";
  const date = document.createElement("span");
  date.className = "history-date";
  date.textContent = formatDate(row.createdAt);
  mainText.append(name, date);

  const meta = document.createElement("span");
  meta.className = "history-meta";
  const duration = document.createElement("span");
  duration.className = "chip";
  duration.textContent = formatDuration(row.durationSec);
  const turns = document.createElement("span");
  turns.className = "chip";
  turns.textContent = String(typeof row.turnCount === "number" ? row.turnCount : 0);
  meta.append(duration, turns);

  main.append(chip, mainText, meta);

  const deleteButton = document.createElement("button");
  deleteButton.className = "pill-button pill-button--ghost";
  deleteButton.type = "button";
  deleteButton.setAttribute("data-delete-button", "");
  deleteButton.textContent = "Delete";

  li.append(main, deleteButton);
  return li;
}

/** Render the cached rows into the list container (newest first per API). */
function renderHistoryRows() {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  dom.historyList.replaceChildren();
  rows.forEach((row) => {
    if (row !== null && typeof row === "object") dom.historyList.append(buildHistoryRow(row));
  });
  renderHistory(rows.length > 0 ? "rows" : "empty");
}

/**
 * Feature 20: GET /api/calls?limit=50 (boot + refresh after each call +
 * Retry). Failure shows the frozen copy + Retry; an empty list shows the
 * existing empty state.
 */
async function loadHistory() {
  try {
    const { status, data } = await fetchEnvelope("/api/calls?limit=50");
    if (!Array.isArray(data)) throw new Error(`HTTP ${status}`);
    historyRows = data;
    renderHistoryRows();
  } catch (error) {
    logCallsWarning("history load failed", error);
    renderHistory("fail");
  }
}

/** Re-render the cached rows without refetching (New Call reset path). */
function refreshHistory() {
  renderHistoryRows();
}

// -- Feature 18-c: LIVE navbar voice badge ----------------------------------

/**
 * Wire the live voice badge: one /api/health poll on boot + every 10 s.
 * data.voice === "up" -> ONLINE; anything else (down, fetch/parse error)
 * -> OFFLINE. The static OFFLINE markup is the honest pre-poll default;
 * while a call is live the voice socket connect state overrides until the
 * next poll (wireConsole).
 */
function wireVoiceBadge() {
  setVoiceServiceChip(false);
  const poll = () => {
    fetchEnvelope("/api/health")
      .then(({ data }) => {
        const payload = data !== null && typeof data === "object" ? data : {};
        setVoiceServiceChip(payload.voice === "up");
      })
      .catch((error) => {
        setVoiceServiceChip(false);
        logCallsWarning("health poll failed", error);
      });
  };
  poll();
  setInterval(poll, VOICE_HEALTH_POLL_MS);
}

/**
 * Wire the console card to the call state machine (feature 09) plus the
 * feature 10 mic gate. Feature 10 owns the IDLE-state status line and the
 * Start Call gate (disabled until consent AND mic ready); everything that
 * happens from Start Call on remains the feature 09 machine. Task 18-c
 * adds the feature 17/19 persistence paths (call row, turn relay, real
 * summary) alongside the machine - they never reshape it.
 */
function wireConsole() {
  const machine = createCallMachine();

  // -- Feature 17/19 per-call persistence state (hoisted; one call at a
  //    time; everything here is defensive - failures log '[calls]' and
  //    never break the call UI) ------------------------------------------
  /** The call id shared by the persistence row and the socket handshake. */
  let currentSubmissionId = null;
  /** POST /api/calls succeeded (turns may persist). */
  let callRowReady = false;
  /** createCallRow single-flight mutex. */
  let rowCreating = false;
  /** Per-call monotonic counter over turn:final arrival order (opener = 0). */
  let turnIdxCounter = 0;
  /** Turns waiting for the call row (404/network) - drained on recovery. */
  let turnQueue = [];
  /** drainTurnQueue single-flight promise (joined, never doubled). */
  let drainPromise = null;

  /**
   * Active channel for the current call (null when none).
   */
  let voiceChannel = null;

  /**
   * Feature 10 failure branches: EVERY mic error now surfaces specific,
   * actionable copy (Task 22). The technical detail still goes to
   * console.warn. Start stays disabled in all cases until a retry succeeds.
   *
   * @param {unknown} error
   * @returns {void}
   */
  function handleMicFailure(error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError") {
      dom.statusLine.textContent = MIC_BLOCKED_STATUS;
    } else if (name === "NotFoundError") {
      dom.statusLine.textContent = MIC_NOT_FOUND_STATUS;
    } else if (name === "NotReadableError") {
      dom.statusLine.textContent = MIC_BUSY_STATUS;
    } else if (name === "OverconstrainedError") {
      dom.statusLine.textContent = MIC_CONSTRAINT_STATUS;
    } else {
      dom.statusLine.textContent = MIC_FAILED_STATUS;
    }
    console.warn(
      "[vad] mic init failed:",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    showMicHelp(); // Task 27: always pair the error copy with an actionable row
  }

  /**
   * Consent CHECK (user gesture): resume the shared AudioContext, then
   * init/resume the mic exactly once. The status line shows "Checking
   * microphone..." while the mic loads, flips to the permission-wait copy
   * if a prompt stays pending 8 s, becomes "Mic ready" on success (Start
   * Call unlocks - consent AND mic ready), or the Task 22 per-error copy
   * on failure.
   *
   * @returns {Promise<void>}
   */
  async function handleConsentChecked() {
    resumeAudioContext();
    dom.startButton.disabled = true; // gate: consent AND mic ready
    // Task 22: honest loading state + a pending-prompt watchdog. A mic
    // permission prompt that never surfaces (e.g. suppressed inside a
    // preview iframe) keeps getUserMedia pending forever with NO error -
    // without this the line would sit on "Checking microphone..." for good.
    dom.statusLine.textContent = MIC_CHECKING_STATUS;
    const waitTimer = setTimeout(() => {
      if (!isMicReady() && machine.getState() === CALL_STATES.IDLE) {
        dom.statusLine.textContent = MIC_WAIT_PERMISSION_STATUS;
        void maybeAutoRetryMic(); // Task 25: granted-elsewhere -> fresh try
      }
    }, MIC_PERMISSION_WAIT_MS);
    try {
      if (!isMicReady()) {
        await initMic({
          consent: dom.consentInput.checked === true,
          // Features 12/15 glue: registered once (initMic memoizes); the
          // handlers read the CURRENT channel/player at event time.
          onSpeechStart: handleSpeechStart,
          onSpeechEnd: handleSpeechEnd,
        });
      } else {
        await resumeMic();
      }
    } catch (error) {
      clearTimeout(waitTimer);
      handleMicFailure(error);
      return;
    }
    clearTimeout(waitTimer);
    // Task 25: a superseded (hung) attempt can resolve AFTER a retry started
    // - only write the ready state when THIS attempt really owns the mic.
    if (
      isMicReady() &&
      dom.consentInput.checked === true &&
      machine.getState() === CALL_STATES.IDLE
    ) {
      machine.setConsent(true); // sync the feature 09 gate (enables Start)
      dom.statusLine.textContent = MIC_READY_STATUS;
      micAutoRetries = 0; // Task 27: fresh budget for the next cold start
      hideMicHelp();
    } else if (!isMicReady()) {
      // Stale attempt settled: a live retry owns the UI - stay silent.
    } else {
      // Consent was unchecked while the mic was loading: pause again.
      await pauseMic();
    }
  }

  // Task 25: hung-prompt escape hatch. getUserMedia in a preview iframe (or
  // a dismissed prompt) can hang FOREVER with no error, and initMic
  // memoized that dead promise - so granting the permission anywhere else
  // never unblocked the UI ("Waiting for mic permission" forever). Now:
  // watchdog -> permission probe -> resetMicInit + fresh check; plus the
  // same retry when the user returns (focus / tab visible), which is the
  // moment they come back after granting in another tab or site settings.
  let lastMicRetryAt = 0;
  // Task 27: bounded auto-retries. The previous version retried forever
  // every 8s - the status flickered on "Checking microphone..." for minutes
  // when the prompt could never surface (preview iframe), and each retry
  // piled up another hung getUserMedia. Now: 3 auto-retries, then an honest
  // help row (Open in new tab link + a manual Retry button that resets the
  // budget).
  const MIC_AUTO_RETRY_MAX = 3;
  let micAutoRetries = 0;
  /** @type {HTMLElement | null} the actionable help row (lazy-created) */
  let micHelpRow = null;

  /** Remove the help row (mic recovered or consent unchecked). */
  function hideMicHelp() {
    if (micHelpRow !== null) {
      micHelpRow.remove();
      micHelpRow = null;
    }
  }

  /**
   * Show the actionable mic help row under the status line: a real link to
   * open the app in a new tab (the ONLY reliable fix when the preview iframe
   * suppresses the permission prompt) + a manual retry that resets the
   * auto-retry budget.
   */
  function showMicHelp() {
    if (micHelpRow !== null) return; // already visible
    micHelpRow = document.createElement("div");
    micHelpRow.className = "mic-help-row";
    const note = document.createElement("span");
    note.className = "mic-help-note";
    note.textContent = "Mic not responding -";
    const link = document.createElement("a");
    link.className = "mic-help-link";
    link.href = window.location.href;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "open in a new tab";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "pill-button mic-help-retry";
    retry.textContent = "Retry mic";
    retry.addEventListener("click", () => {
      micAutoRetries = 0; // user-driven retry gets a fresh budget
      hideMicHelp();
      dom.statusLine.textContent = MIC_CHECKING_STATUS;
      void handleConsentChecked();
    });
    micHelpRow.append(note, link, retry);
    dom.statusLine.after(micHelpRow);
  }

  async function maybeAutoRetryMic() {
    if (machine.getState() !== CALL_STATES.IDLE) return;
    if (dom.consentInput.checked !== true) return;
    if (isMicReady()) return;
    if (micAutoRetries >= MIC_AUTO_RETRY_MAX) {
      dom.statusLine.textContent = MIC_WAIT_PERMISSION_STATUS;
      showMicHelp(); // honest dead-end: real link + manual retry
      return;
    }
    const now = Date.now();
    if (now - lastMicRetryAt < 3000) return; // debounce: never prompt-spam
    lastMicRetryAt = now;
    micAutoRetries += 1;
    resetMicInit(); // abandon the hung init - the next initMic is fresh
    // Optional probe: when the browser already granted mic permission
    // (granted in another tab / site settings), retry immediately with a
    // live status; when explicitly denied, show the blocked copy instead.
    try {
      if (typeof navigator.permissions?.query === "function") {
        const state = (await navigator.permissions.query({ name: "microphone" })).state;
        if (state === "denied") {
          dom.statusLine.textContent = MIC_BLOCKED_STATUS;
          return;
        }
      }
    } catch {
      // probe unsupported - retry regardless
    }
    dom.statusLine.textContent = MIC_CHECKING_STATUS;
    await handleConsentChecked();
  }

  window.addEventListener("focus", () => {
    void maybeAutoRetryMic();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void maybeAutoRetryMic();
  });

  dom.consentInput.addEventListener("change", (event) => {
    const checked = event.target.checked === true;
    if (machine.getState() !== CALL_STATES.IDLE) return;
    if (!checked) {
      machine.setConsent(false); // Start disabled + exact idle gate copy
      void pauseMic(); // same MicVAD instance paused; stream stays alive
      return;
    }
    // Status line shows "Checking microphone..." while the mic loads.
    void handleConsentChecked();
  });

  // Task 22: a mic that was missing at first check (unplugged, OS-muted
  // adapter coming back) retries automatically - devicechange while idle
  // with consent checked and no ready mic re-runs the exact check path.
  // initMic's memoization + the IDLE guard make this a no-op otherwise.
  if (typeof navigator.mediaDevices?.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      if (
        machine.getState() === CALL_STATES.IDLE &&
        dom.consentInput.checked === true &&
        !isMicReady()
      ) {
        void handleConsentChecked();
      }
    });
  }

  // Task 21-a: feed the barge energy gate from the vad bar loop (~60 Hz).
  // Registered ONCE here at boot; it reads the CURRENT gate at event time
  // (same pattern as handleSpeechStart). Push is cheap and safe when no
  // call is live - a null gate is a no-op and the gate self-guards on
  // its isPlaying().
  subscribeMicLevels((rms) => {
    try {
      if (bargeGate) bargeGate.push(rms);
    } catch {
      // never let a gate error reach the bar loop (defensive - the gate
      // itself never throws by contract)
    }
  });

  // -- Feature 11 voice socket channel -----------------------------------
  // One channel per call, created on the Start Call click path; it runs
  // ALONGSIDE the feature 09 machine. Stage/error events drive the status
  // line while a channel is CONNECTED; a dead/unreachable voice-service
  // just means no stage events (the line keeps its last copy).
  // Feature 12 owns the ASR send glue (handleSpeechEnd) + turn:final
  // receive path; feature 14 owns the bot:speech receive path
  // (SpeechPlayer) + playback-driven status; feature 15 completes the
  // loop: barge-in client glue (handleSpeechStart) and zero mock code.
  // Task 21-a extends feature 15 with the energy-gate barge fallback
  // (public/js/barge.js fed by subscribeMicLevels) for the overlap case -
  // Silero cannot fire a NEW onSpeechStart when the user talks over the
  // bot inside an already-open speech segment - plus the stale-reply
  // text-drop (deadReplyTexts) so interrupted replies never resume.

  /**
   * Feature 14: the bot speech playback queue for the CURRENT call
   * (created on Start, flushed + dropped on End / New Call - so bot
   * audio can never play outside a live call).
   */
  let speechPlayer = null;

  // -- Task 21-a: energy-gate barge fallback + stale-reply drop -----------
  /**
   * Feature 15 fallback gate (public/js/barge.js): fires handleSpeechStart
   * when the mic rms says someone is talking over the bot (Silero cannot
   * fire a NEW onSpeechStart inside an already-open speech segment).
   * Created per call next to the player (isPlaying reads the CURRENT
   * player); nulled with the player lifecycle (flushSpeechPlayer). The
   * boot-level mic-level subscriber reads the CURRENT gate at event time.
   */
  let bargeGate = null;
  /**
   * Text of the reply whose bot:speech chunks arrived last (the reply
   * currently playing or about to play). Recorded BEFORE the stale-drop
   * check in onBotSpeech, so a barge can mark exactly the in-flight reply.
   */
  let currentReplyText = "";
  /**
   * Reply texts interrupted by a barge: the server may still have slices
   * of them in flight; after the flush they must NEVER play. Capped at 8
   * (Set iteration order is insertion - the oldest key is evicted first).
   */
  let deadReplyTexts = new Set();

  /**
   * Flush + drop the player defensively (never throws). Task 21-a: this
   * is the player-cleanup point of the closeVoiceChannel/endVoiceCall
   * lifecycle, so the per-call barge gate dies here too (the boot-level
   * mic-level subscriber tolerates a null gate - its push is a no-op).
   */
  function flushSpeechPlayer() {
    bargeGate = null;
    if (!speechPlayer) return;
    const player = speechPlayer;
    speechPlayer = null;
    try {
      player.flush(); // instant stop + honest onPlaybackEnd if playing
    } catch (error) {
      logVoiceWarning("speech player flush failed", error);
    }
  }

  /**
   * Feature 14 status dedupe: the server's stage "speaking" AND the
   * player's first audible start BOTH write the same locked string from
   * VOICE_STAGE_STATUS - idempotent writes, one status.
   */
  function handleSpeechPlaybackStart() {
    if (machine.getState() !== CALL_STATES.IN_CALL) return;
    writeStatusLine(VOICE_STAGE_STATUS.speaking);
  }

  /**
   * Feature 14: the queue drained and the last source ended - back to
   * "Listening…", but ONLY while the machine is in call and the channel
   * is still connected (End Call owns the line from there on).
   */
  function handleSpeechPlaybackEnd() {
    if (machine.getState() !== CALL_STATES.IN_CALL) return;
    if (!voiceChannel || !voiceChannel.isConnected()) return;
    writeStatusLine(VOICE_STAGE_STATUS.listening);
  }

  /**
   * Feature 15 barge-in glue: on VAD SpeechStart while bot audio is
   * ACTUALLY playing, emit barge-in (the server aborts its in-flight TTS
   * send) and flush the SpeechPlayer - playback stops perceptually
   * instantly (far under the 300 ms budget) and the flush's
   * onPlaybackEnd returns the status to "Listening…" (the server's own
   * post-abort stage "listening" writes the same locked constant -
   * idempotent, never double-set here). A SpeechStart while merely
   * listening is just the next utterance beginning: no barge-in event,
   * no flush. Registered ONCE with initMic (memoized); it reads the
   * CURRENT channel + player at event time. A failure here must never
   * break mic capture (defensive try/catch).
   *
   * Task 21-a extends the trigger and the cleanup: (1) this SAME handler
   * is the bargeGate onBarge callback - the energy gate fires it when the
   * mic rms says someone is talking over the bot while Silero is still
   * inside the already-open speech segment (no NEW onSpeechStart fires
   * on overlap); (2) the interrupted reply's text is marked dead
   * (deadReplyTexts) BEFORE the flush, so bot:speech slices still in
   * flight for that reply are dropped in onBotSpeech and the bot can
   * never seem to "continue its sentence".
   */
  function handleSpeechStart() {
    try {
      const player = speechPlayer;
      if (!player || !player.isPlaying()) return; // guard: playing only
      // Task 21-a stale-drop: mark the currently-playing reply dead (the
      // set is capped at 8; Set iteration order is insertion, so the
      // oldest key is evicted first).
      if (currentReplyText.length > 0) {
        deadReplyTexts.add(currentReplyText);
        if (deadReplyTexts.size > 8) {
          deadReplyTexts.delete(deadReplyTexts.values().next().value);
        }
      }
      const channel = voiceChannel;
      if (channel && channel.isConnected()) channel.bargeIn();
      player.flush();
    } catch (error) {
      logVoiceWarning("barge-in flush failed", error);
    }
  }

  /**
   * Send-side glue (feature 12): on VAD SpeechEnd, stream the flushed
   * utterance chunks over the connected channel and close the turn so the
   * voice-service ASR stage runs. Registered ONCE with initMic (memoized);
   * it reads the CURRENT channel + consent at event time. A socket error
   * here must never break the machine (defensive try/catch).
   */
  function handleSpeechEnd() {
    try {
      const chunks = getLastUtteranceChunks();
      if (!chunks || chunks.length === 0) return;
      const channel = voiceChannel;
      if (!channel || !channel.isConnected()) return;
      if (dom.consentInput.checked !== true) return;
      for (const chunk of chunks) {
        if (!channel.sendUtterance(chunk)) return; // emit failed -> drop the turn
      }
      channel.endTurn();
      // Task 21-a: a real user utterance was sent after the barge - reset
      // the energy gate's unacked budget (markUserTurn never throws by
      // contract; the surrounding try/catch stays).
      if (bargeGate) bargeGate.markUserTurn();
    } catch (error) {
      logVoiceWarning("speech-end send failed", error);
    }
  }

  /** Stage events drive the status line only while the machine is in_call. */
  function handleVoiceStage(stage) {
    if (machine.getState() !== CALL_STATES.IN_CALL) return;
    const copy = VOICE_STAGE_STATUS[stage];
    if (typeof copy === "string") writeStatusLine(copy);
  }

  /**
   * POST one relayed turn (feature 17 client half). Outcome: true =
   * persisted; "keep" = keep queued (404 row-missing, transient 429/5xx,
   * network); "drop" = permanent 4xx (retrying cannot help; the queue
   * must not wedge).
   *
   * @param {string} submissionId
   * @param {{idx: number, role: string, text: string}} item
   * @returns {Promise<boolean|"keep"|"drop">}
   */
  async function postTurn(submissionId, item) {
    try {
      const { status } = await fetchEnvelope(`/api/calls/${submissionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idx: item.idx, role: item.role, text: item.text }),
      });
      if (status === 404) {
        callRowReady = false; // row missing - wait for the recovery create
        return "keep";
      }
      if (status >= 200 && status < 300) return true;
      if (status === 429 || status >= 500) return "keep"; // transient
      if (status >= 400) return "drop"; // permanent 4xx
      return "keep";
    } catch (error) {
      logCallsWarning("turn POST failed", error);
      return "keep"; // network - keep queued
    }
  }

  /**
   * Drain the queued turns in order (single-flight: concurrent callers
   * join the in-flight promise). Stops (keeping the rest queued) on the
   * first failure. The body starts in a Promise.resolve().then() task so
   * a synchronously-completing drain can never poison the guard: the
   * drainPromise assignment always lands BEFORE the finally resets it.
   *
   * @returns {Promise<void>}
   */
  function drainTurnQueue() {
    if (drainPromise) return drainPromise;
    drainPromise = Promise.resolve().then(async () => {
      try {
        while (turnQueue.length > 0 && callRowReady && currentSubmissionId) {
          const outcome = await postTurn(currentSubmissionId, turnQueue[0]);
          if (outcome === "drop") {
            turnQueue.shift(); // unblock the queue; the turn is lost (logged)
            continue;
          }
          if (outcome !== true) break; // "keep": retry after recovery
          turnQueue.shift();
        }
      } catch (error) {
        logCallsWarning("turn queue drain failed", error);
      } finally {
        drainPromise = null;
      }
    });
    return drainPromise;
  }

  /**
   * POST /api/calls for the current call (feature 17). Idempotent
   * server-side on the same submissionId, so the feature 19 recovery
   * re-POST is safe. On success the queued turns drain. Consent false ->
   * no persistence at all (the machine gate makes this near-unreachable).
   *
   * @returns {Promise<boolean>} true when the row exists
   */
  async function createCallRow() {
    if (!currentSubmissionId || rowCreating) return callRowReady;
    if (dom.consentInput.checked !== true) return false; // no consent -> no persistence
    rowCreating = true;
    try {
      const { status, data } = await fetchEnvelope("/api/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: currentSubmissionId, consent: true }),
      });
      if (data !== null) {
        callRowReady = true;
        startCallRecording(getMicStream()); // feature 21: capture from row open
        void drainTurnQueue();
        return true;
      }
      logCallsWarning(`call row create failed (HTTP ${status})`);
      return false;
    } catch (error) {
      logCallsWarning("call row create failed", error);
      return false;
    } finally {
      rowCreating = false;
    }
  }

  /**
   * Feature 17 client half: relay one turn:final to persistence -
   * fire-and-forget, NEVER breaks the call UI (drainTurnQueue owns the
   * failures). idx is the per-call monotonic counter over turn:final
   * arrival order; the server's opener greeting (first bot turn) is 0.
   *
   * @param {{role: string, text: string}} turn
   */
  function relayTurnToCalls(turn) {
    try {
      if (dom.consentInput.checked !== true) return; // no consent -> no persistence
      if (!currentSubmissionId) return;
      const idx = turnIdxCounter;
      turnIdxCounter += 1;
      turnQueue.push({ idx, role: turn.role, text: turn.text });
      void drainTurnQueue();
    } catch (error) {
      logCallsWarning("turn relay failed", error);
    }
  }

  /**
   * Features 12-13 receive path: turn:final { role, text } renders a
   * REAL transcript bubble while in call - role "user" (ASR text) as a
   * customer bubble, role "bot" (LLM reply, feature 13) as a bot bubble.
   * Feature 17: the same turn then relays to the calls API (queue +
   * drain). Defensive: a bad payload or render error never breaks the
   * machine.
   *
   * @param {unknown} turn
   */
  function handleVoiceTurnFinal(turn) {
    try {
      if (
        machine.getState() !== CALL_STATES.IN_CALL ||
        turn === null ||
        typeof turn !== "object" ||
        typeof turn.text !== "string" ||
        turn.text.length === 0
      ) {
        return;
      }
      if (turn.role === "user") {
        appendTranscriptBubble("customer", turn.text, currentClockTime());
      } else if (turn.role === "bot") {
        // Feature 13: the bot bubble carries the REAL LLM reply text.
        appendTranscriptBubble("bot", turn.text, currentClockTime());
      } else {
        return;
      }
      relayTurnToCalls(turn);
    } catch (error) {
      logVoiceWarning("turn:final render failed", error);
    }
  }

  /** call:error renders its userMessage VERBATIM (H-E8 taxonomy copy). */
  function handleVoiceError(error) {
    if (error && typeof error.userMessage === "string") writeStatusLine(error.userMessage);
  }

  /** Close + drop the channel defensively (never throws). */
  function closeVoiceChannel() {
    if (!voiceChannel) {
      flushSpeechPlayer(); // defensive: never a live player without a channel
      return;
    }
    const channel = voiceChannel;
    voiceChannel = null;
    flushSpeechPlayer();
    setStatusLineShadow(false);
    try {
      channel.close();
    } catch (error) {
      logVoiceWarning("channel close failed", error);
    }
  }

  /** Seconds from the machine's timer chip (its visible mm:ss timer). */
  function readTimerSeconds() {
    const match = /^(\d{2}):(\d{2})$/.exec(dom.timerChip.textContent);
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  }

  /**
   * Start Call click path: open one channel per call (the SAME callId the
   * persistence row uses) and the matching feature 14 speech player
   * (in-call only; no player -> no autoplay outside a live call,
   * structurally).
   *
   * @param {string} callId the per-call id (shared with POST /api/calls)
   */
  function startVoiceChannel(callId) {
    closeVoiceChannel(); // defensive: never two live channels/players
    const channel = createVoiceChannel({
      onStage: handleVoiceStage,
      onError: handleVoiceError,
      onTurnFinal: handleVoiceTurnFinal, // features 12-13: real bubbles
      // Feature 14: bot:speech chunks play through the SpeechPlayer.
      // Task 21-a: record the reply text in flight FIRST, then drop stale
      // chunks of a reply a barge already interrupted (deadReplyTexts) -
      // after the flush they must never play.
      onBotSpeech: (chunk) => {
        currentReplyText = typeof chunk.text === "string" ? chunk.text : currentReplyText;
        if (deadReplyTexts.has(chunk.text)) return;
        if (speechPlayer) speechPlayer.enqueue(chunk);
      },
      // While CONNECTED the real stage events OWN the status line; the
      // shadow gate (feature 11) keeps any stray direct machine write
      // from fighting them (the // MOCK cycler it originally shadowed
      // was deleted in feature 15).
      onConnected: () => {
        if (machine.getState() === CALL_STATES.IN_CALL) setStatusLineShadow(true);
        // Feature 18-c: a live voice socket is the strongest ONLINE
        // signal - it overrides the health poll until it drops.
        setVoiceServiceChip(true);
      },
      onDisconnected: () => {
        setStatusLineShadow(false);
        // Feature 18-c: back to OFFLINE until the next health poll.
        setVoiceServiceChip(false);
      },
    });
    let started = false;
    try {
      started = channel.start(callId, dom.consentInput.checked === true);
    } catch (error) {
      logVoiceWarning("channel start failed", error);
    }
    if (started) {
      voiceChannel = channel;
      speechPlayer = createSpeechPlayer({
        onPlaybackStart: handleSpeechPlaybackStart,
        onPlaybackEnd: handleSpeechPlaybackEnd,
      });
      // Task 21-a: the energy-gate barge fallback lives exactly as long
      // as the player (one per call; isPlaying reads the CURRENT player
      // at event time, onBarge is the shared handleSpeechStart path).
      bargeGate = createBargeEnergyGate({
        isPlaying: () => Boolean(speechPlayer !== null && speechPlayer.isPlaying()),
        onBarge: handleSpeechStart,
      });
      currentReplyText = "";
      deadReplyTexts = new Set();
    }
  }

  /** End Call click path: flush call:end, then close after a short grace. */
  function endVoiceCall() {
    flushSpeechPlayer(); // End Call during playback: no audio after the call ends
    void stopAndUploadCallRecording(currentSubmissionId); // feature 21: best-effort upload
    setStatusLineShadow(false); // the machine owns the ending copy again
    const channel = voiceChannel;
    if (!channel) return;
    voiceChannel = null;
    try {
      channel.endCall(readTimerSeconds());
    } catch (error) {
      logVoiceWarning("call:end emit failed", error);
    }
    setTimeout(() => {
      try {
        channel.close();
      } catch (error) {
        logVoiceWarning("channel close failed", error);
      }
    }, VOICE_CLOSE_GRACE_MS);
  }

  // -- Feature 19: the REAL post-call summary -----------------------------
  // The // MOCK (feature 09) 3 s delay is deleted from state.js: after
  // machine.end() shows the skeleton, requestSummary() POSTs the real
  // summary. Success renders the real card; failure shows the locked
  // "Summary failed." + Retry (no chip - salesStatus stays unset).

  /** Hide the summary failure row. */
  function hideSummaryFailure() {
    dom.summaryFail.hidden = true;
  }

  /**
   * Show the summary failure state: skeleton hidden, card stays hidden
   * (no chip), failure row + Retry visible, status line carries the
   * locked copy.
   */
  function showSummaryFailure() {
    renderSummary("hidden");
    hideSummaryFailure();
    dom.summaryFail.hidden = false;
    writeStatusLine(SUMMARY_FAILED_STATUS);
  }

  /** ui-tokens invariant: motion honors prefers-reduced-motion. */
  function scrollSummaryIntoView() {
    try {
      dom.summaryCard.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    } catch (error) {
      logCallsWarning("summary scroll failed", error);
    }
  }

  /**
   * Render the REAL summary response into the existing card: salesStatus
   * -> chip (missing status -> the honest "No Response"), paragraph +
   * the three labeled blocks, then unhide + scroll into view.
   *
   * @param {object} data { summary, requirements, objections, nextSteps, salesStatus }
   */
  function renderRealSummary(data) {
    const status = typeof data.salesStatus === "string" ? data.salesStatus : "No Response";
    setSummaryChip(status, SALES_STATUS_ROLES[status] || "no-response");
    if (typeof data.summary === "string") dom.summaryBody.textContent = data.summary;
    const blocks = [data.requirements, data.objections, data.nextSteps];
    dom.summaryBlockBodies.forEach((node, index) => {
      if (typeof blocks[index] === "string") node.textContent = blocks[index];
    });
    hideSummaryFailure();
    renderSummary("shown");
    scrollSummaryIntoView();
  }

  /**
   * POST /api/calls/[id]/summary { durationSec }. Resolves
   * { status, data } - never rejects (network failures log + status 0).
   *
   * @param {string} submissionId
   * @returns {Promise<{status: number, data: unknown}>}
   */
  async function postSummary(submissionId) {
    try {
      const { status, data } = await fetchEnvelope(`/api/calls/${submissionId}/summary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ durationSec: readTimerSeconds() }),
      });
      if (data === null) logCallsWarning(`summary POST failed (HTTP ${status})`);
      return { status, data };
    } catch (error) {
      logCallsWarning("summary POST failed", error);
      return { status: 0, data: null };
    }
  }

  /**
   * One summary attempt: POST; on 404 recover - the call row never made
   * it, so re-POST /api/calls (idempotent) + drain the queued turns, then
   * retry the summary once. Success renders the real card, moves the
   * machine to summary and refreshes the history list (feature 20).
   *
   * @param {string} submissionId
   * @returns {Promise<boolean>} true when the summary rendered
   */
  async function attemptSummary(submissionId) {
    try {
      let result = await postSummary(submissionId);
      if (result.data === null && result.status === 404) {
        const recovered = await createCallRow();
        if (recovered) {
          await drainTurnQueue(); // the summary reads the server-side turns
          result = await postSummary(submissionId);
        }
      }
      if (result.data === null || typeof result.data !== "object") return false;
      machine.summaryReady(); // ending -> summary (the render below is real)
      renderRealSummary(result.data);
      // Success restores the natural post-summary line (the same locked
      // ending copy the non-failure flow keeps; matters after a Retry).
      writeStatusLine(ENDING_STATUS);
      void loadHistory(); // feature 20: the list refreshes after each call
      return true;
    } catch (error) {
      logCallsWarning("summary attempt failed", error);
      return false;
    }
  }

  /** End Call path: the real summary request (machine.end shows the skeleton). */
  function requestSummary() {
    hideSummaryFailure();
    const submissionId = currentSubmissionId;
    if (!submissionId) {
      showSummaryFailure();
      return;
    }
    void attemptSummary(submissionId).then((ok) => {
      if (!ok) showSummaryFailure();
    });
  }

  /** Feature 19 Retry: skeleton again, then the same attempt + recovery. */
  function retrySummary() {
    dom.summaryRetry.disabled = true;
    hideSummaryFailure();
    renderSummary("skeleton");
    const submissionId = currentSubmissionId;
    const attempt = submissionId ? attemptSummary(submissionId) : Promise.resolve(false);
    void attempt.then((ok) => {
      dom.summaryRetry.disabled = false;
      if (!ok) showSummaryFailure();
    });
  }

  /**
   * Feature 17: one call id drives BOTH the persistence row and the voice
   * socket handshake. The row POST fires FIRST (async, non-blocking),
   * then the channel opens exactly as before. Consent false -> skip ALL
   * persistence (the machine gate makes this near-unreachable;
   * defensive).
   */
  function beginCall() {
    const callId = newCallId();
    currentSubmissionId = callId;
    callRowReady = false;
    turnIdxCounter = 0;
    turnQueue = [];
    if (dom.consentInput.checked === true) void createCallRow();
    startVoiceChannel(callId);
  }

  dom.startButton.addEventListener("click", () => {
    machine.start();
    beginCall(); // feature 17: call row + turn-relay state, then the channel
  });
  dom.endButton.addEventListener("click", () => {
    endVoiceCall();
    // Feature 19: the // MOCK (feature 09) 3 s delay is gone - the machine
    // rests in `ending` while the REAL summary POST runs.
    machine.end();
    requestSummary();
  });
  // Feature 19: Retry re-runs the summary POST (with the row recovery).
  dom.summaryRetry.addEventListener("click", () => {
    retrySummary();
  });
  dom.newCallButton.addEventListener("click", () => {
    closeVoiceChannel(); // defensive (End Call already closed it)
    machine.reset(); // unchecks consent programmatically (no change event)
    void pauseMic(); // H-B5 posture: consent off -> capture paused
    refreshHistory(); // feature 20: re-render the REAL rows (reset shows the empty state)
  });
}

/**
 * Wire the history section (features 20/23): REAL rows replace the
 * deleted // MOCK (feature 08) rows. Rows are dynamic (renderHistoryRows
 * at module level), so the row-open + delete handlers are DELEGATED on
 * the list container. The dialog mechanics are unchanged: showModal,
 * backdrop click closes, close clears the body + stops audio, Escape is
 * native.
 */
function wireHistory() {
  // Call whose detail is currently shown (Retry re-fetches the REAL
  // detail; a stale fetch after close is dropped).
  let activeDetailId = null;
  // Row pending deletion (feature 23 confirm dialog).
  let pendingDeleteId = null;

  /** Pause any audio playing inside the dialog body before it is cleared. */
  function stopDialogAudio() {
    dom.callDialogBody.querySelectorAll("audio").forEach((audio) => audio.pause());
  }

  /** One call-dialog-stat pair (Date / Duration / Turns). */
  function buildDialogStat(labelText, valueText) {
    const stat = document.createElement("div");
    stat.className = "call-dialog-stat";
    const label = document.createElement("span");
    label.className = "call-dialog-stat-label";
    label.textContent = labelText;
    const value = document.createElement("span");
    value.className = "call-dialog-stat-value";
    value.textContent = valueText;
    stat.append(label, value);
    return stat;
  }

  /** One summary block (label + body) - the mock detail's block classes. */
  function buildSummaryBlock(labelText, bodyText) {
    const block = document.createElement("div");
    block.className = "summary-block";
    const label = document.createElement("h3");
    label.className = "summary-block-label";
    label.textContent = labelText;
    const body = document.createElement("p");
    body.className = "summary-block-body";
    body.textContent = bodyText;
    block.append(label, body);
    return block;
  }

  /** One hairline dialog section with its title. */
  function buildDialogSection(titleText) {
    const section = document.createElement("section");
    section.className = "call-dialog-section";
    const title = document.createElement("h4");
    title.className = "call-dialog-section-title";
    title.textContent = titleText;
    section.append(title);
    return section;
  }

  /**
   * Render the REAL call detail (feature 20): meta stats + Call Summary
   * blocks + the transcript list - the same classes the deleted mock
   * templates used. role "user" renders a customer bubble, role "bot" an
   * agent bubble (the labels the mock templates used). A Recording section
   * (feature 21 quick path) renders a native audio player when the call has
   * an uploaded recording. Sections with no content are omitted
   * (an in-progress call has no summary yet).
   *
   * @param {object} data { call, turns } from GET /api/calls/[id]
   */
  function renderCallDetail(data) {
    const payload = data !== null && typeof data === "object" ? data : {};
    const call = payload.call !== null && typeof payload.call === "object" ? payload.call : {};
    const turns = Array.isArray(payload.turns) ? payload.turns : [];
    const turnCount = typeof call.turnCount === "number" ? call.turnCount : turns.length;
    const body = document.createDocumentFragment();

    const meta = document.createElement("div");
    meta.className = "call-dialog-meta";
    meta.append(
      buildDialogStat("Date", formatDate(call.createdAt)),
      buildDialogStat("Duration", formatDuration(call.durationSec)),
      buildDialogStat("Turns", String(turnCount)),
    );
    body.append(meta);

    if (typeof call.summary === "string" && call.summary.length > 0) {
      const summarySection = buildDialogSection("Call Summary");
      const summaryBody = document.createElement("p");
      summaryBody.className = "summary-body";
      summaryBody.textContent = call.summary;
      summarySection.append(summaryBody);
      const blocks = document.createElement("div");
      blocks.className = "summary-blocks";
      const labeled = [
        ["Customer Requirements", call.requirements],
        ["Objections", call.objections],
        ["Next Steps", call.nextSteps],
      ];
      let hasBlocks = false;
      labeled.forEach(([labelText, value]) => {
        if (typeof value === "string" && value.length > 0) {
          blocks.append(buildSummaryBlock(labelText, value));
          hasBlocks = true;
        }
      });
      if (hasBlocks) summarySection.append(blocks);
      body.append(summarySection);
    }

    if (call.hasRecording === true && typeof call.submissionId === "string") {
      const recSection = buildDialogSection("Recording");
      const audio = document.createElement("audio");
      audio.className = "recording-player";
      audio.controls = true;
      audio.preload = "none";
      audio.src = `/api/calls/${encodeURIComponent(call.submissionId)}/recording`;
      recSection.append(audio);
      body.append(recSection);
    }

    if (turns.length > 0) {
      const transcriptSection = buildDialogSection("Transcript");
      const list = document.createElement("ol");
      list.className = "transcript-list call-dialog-transcript";
      turns.forEach((turn) => {
        if (turn === null || typeof turn !== "object" || typeof turn.text !== "string") return;
        const isBot = turn.role === "bot";
        const row = document.createElement("li");
        row.className = isBot ? "bubble-row bubble-row--bot" : "bubble-row bubble-row--customer";
        const bubble = document.createElement("div");
        bubble.className = isBot ? "bubble bubble--bot" : "bubble bubble--customer";
        const text = document.createElement("p");
        text.className = "bubble-text";
        text.textContent = turn.text;
        bubble.append(text);
        const time = document.createElement("span");
        time.className = "bubble-time";
        time.textContent = clockTimeFromIso(turn.createdAt);
        row.append(bubble, time);
        list.append(row);
      });
      transcriptSection.append(list);
      body.append(transcriptSection);
    }

    stopDialogAudio();
    dom.callDialogBody.replaceChildren(body);
  }

  /** Dialog-body load failure: the frozen copy + Retry (same classes). */
  function renderDialogLoadFail() {
    const fail = document.createElement("div");
    fail.className = "history-fail";
    const text = document.createElement("p");
    text.className = "history-fail-text";
    text.textContent = "Couldn't load call history.";
    const retry = document.createElement("button");
    retry.className = "pill-button";
    retry.type = "button";
    retry.setAttribute("data-call-dialog-retry", "");
    retry.textContent = "Retry";
    fail.append(text, retry);
    stopDialogAudio();
    dom.callDialogBody.replaceChildren(fail);
  }

  /**
   * Fetch + render the REAL detail for one call (feature 20). A response
   * landing after the dialog closed (or for a newer open) is dropped.
   *
   * @param {string} id submissionId
   * @returns {Promise<void>}
   */
  async function loadCallDetail(id) {
    stopDialogAudio();
    dom.callDialogBody.replaceChildren();
    try {
      const { status, data } = await fetchEnvelope(`/api/calls/${id}`);
      if (data === null) throw new Error(`HTTP ${status}`);
      if (activeDetailId !== id || !dom.callDialog.open) return; // closed meanwhile
      renderCallDetail(data);
    } catch (error) {
      logCallsWarning("call detail load failed", error);
      if (activeDetailId !== id || !dom.callDialog.open) return;
      renderDialogLoadFail();
    }
  }

  /**
   * Open the call detail dialog for one history row: title + status chip
   * come from the row (instant), the body is fetched from
   * GET /api/calls/[id] (the per-row mock templates are gone).
   *
   * @param {Element} row the .history-row element (carries data-call-id)
   */
  function openCallDialog(row) {
    const id = row.getAttribute("data-call-id");
    if (!id) return;
    activeDetailId = id;
    dom.callDialogTitle.textContent = "FlowSmith demo";
    const rowChip = row.querySelector(".history-row-main .status-chip");
    const rowLabel = row.querySelector(".history-row-main .status-label");
    if (rowChip) dom.callDialogChip.setAttribute("data-role", rowChip.getAttribute("data-role") || "");
    if (rowLabel) dom.callDialogChipLabel.textContent = rowLabel.textContent;
    if (!dom.callDialog.open && typeof dom.callDialog.showModal === "function") {
      dom.callDialog.showModal();
    }
    void loadCallDetail(id);
  }

  // Feature 20: delegated row listeners (rows are dynamic now).
  dom.historyList.addEventListener("click", (event) => {
    const deleteButton = event.target.closest("[data-delete-button]");
    if (deleteButton) {
      const row = deleteButton.closest(".history-row");
      pendingDeleteId = row ? row.getAttribute("data-call-id") : null;
      if (typeof dom.confirmDialog.showModal === "function") dom.confirmDialog.showModal();
      return;
    }
    const openButton = event.target.closest("[data-call-open]");
    if (openButton) {
      const row = openButton.closest(".history-row");
      if (row) openCallDialog(row);
    }
  });

  // Feature 20: list load-failure Retry refetches GET /api/calls?limit=50.
  dom.historyRetry.addEventListener("click", () => {
    void loadHistory();
  });

  dom.callDialogClose.addEventListener("click", () => dom.callDialog.close());

  // Backdrop click: a click landing on the dialog element itself is
  // outside the inner wrapper. Escape closes natively.
  dom.callDialog.addEventListener("click", (event) => {
    if (event.target === dom.callDialog) dom.callDialog.close();
  });

  // Emptying the body on close also stops any playing recording audio
  // (and drops any in-flight detail fetch).
  dom.callDialog.addEventListener("close", () => {
    activeDetailId = null;
    stopDialogAudio();
    dom.callDialogBody.replaceChildren();
  });

  // Feature 20: dialog-body Retry re-fetches the REAL detail for the
  // active call (the mock re-clone is gone).
  dom.callDialogBody.addEventListener("click", (event) => {
    const retryButton = event.target.closest("[data-call-dialog-retry]");
    if (!retryButton || !activeDetailId) return;
    void loadCallDetail(activeDetailId);
  });

  // Feature 23: confirm Yes -> DELETE /api/calls/[id] -> refresh the list
  // (also after failures - the truthful state); Cancel closes.
  dom.confirmYes.addEventListener("click", () => {
    dom.confirmDialog.close();
    const id = pendingDeleteId;
    pendingDeleteId = null;
    if (!id) return;
    void (async () => {
      try {
        const { status } = await fetchEnvelope(`/api/calls/${id}`, { method: "DELETE" });
        if (status !== 200) logCallsWarning(`delete failed (HTTP ${status})`);
      } catch (error) {
        logCallsWarning("delete failed", error);
      }
      void loadHistory();
    })();
  });
  dom.confirmNo.addEventListener("click", () => {
    pendingDeleteId = null;
    dom.confirmDialog.close();
  });
}

/**
 * // MOCK (feature 07) - show the chip verification strip only with the
 * ?devchips=1 query flag; the strip is removed by feature 19.
 */
function wireDevChips() {
  const flag = new URLSearchParams(window.location.search).get("devchips");
  if (flag === "1") dom.devChips.hidden = false;
}

/**
 * ui-tokens invariant: all motion respects prefers-reduced-motion. Pausing
 * the orb stops the loop now; feature 24 refines this to a held poster
 * frame (plus removing the CSS glow pulse, already killed globally).
 */
function applyReducedMotionOrb() {
  if (reducedMotion && dom.orbVideo) {
    dom.orbVideo.removeAttribute("autoplay");
    dom.orbVideo.pause();
  }
}

wireSmoothScroll();
stampYear();
wireVoiceBadge();
wireConsole();
wireHistory();
// Feature 25: the navbar gear + settings dialog (module is defensive -
// absent dialog nodes simply skip the wiring).
wireSettings();
// Feature 20: REAL rows replace the // MOCK (feature 08) list on boot.
void loadHistory();
wireDevChips();
applyReducedMotionOrb();
