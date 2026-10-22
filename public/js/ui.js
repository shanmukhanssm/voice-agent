/**
 * ui.js - DOM node registry + per-section render helpers.
 *
 * Naming per code-standards.md: renderXxx, one per page section. No state
 * lives here (state.js owns the machine); this module only moves existing
 * DOM nodes between the canonical states hidden / disabled / shown.
 *
 * Feature 11 adds the status-line shadow gate: while a voice channel is
 * CONNECTED its real stage events own the status line, so direct writes
 * through `dom.statusLine` are shadowed; feature 11 writes the real
 * element through writeStatusLine(). (The // MOCK (feature 09) cycler
 * the gate originally shadowed was deleted in feature 15; the gate stays
 * so machine writes can never fight the real events.)
 *
 * Feature 12 adds appendTranscriptBubble(role, text, time): the REAL
 * transcript bubble for live turn:final text (customer bubbles carry ASR
 * text during a connected call), marked data-live-dynamic and cleared
 * whenever the transcript resets. Feature 13: the same helper now renders
 * bot bubbles - turn:final { role: "bot" } carries the REAL LLM reply
 * during a connected call.
 *
 * Feature 15 deletes the // MOCK (feature 06/09) in-call transcript
 * pieces - the seeded-populated render, the cycler-driven mock bubble
 * helper and their constants are gone (see ui-registry.md for the removed
 * names). The transcript starts EMPTY at call start and
 * fills with REAL turn:final bubbles; appendTranscriptBubble is the only
 * bubble path.
 *
 * Task 18-c (features 19/20/23 + live badge): the registry gains the live
 * navbar voice chip ([data-voice-chip], feature 18-c), the summary card's
 * REAL render targets (.summary-body + the three .summary-block-body
 * blocks) and the two failure affordances ([data-summary-fail] /
 * [data-summary-retry], [data-history-fail] / [data-history-retry]); the
 * per-mock-row [data-call-open]/[data-delete-button] snapshots are REMOVED
 * (rows are dynamic now - app.js delegates on the list container).
 * renderHistory gains the "fail" mode (frozen load-failure copy + Retry).
 * setVoiceServiceChip(online) flips the navbar badge (ONLINE mirrors the
 * converted green via CSS).
 */

/**
 * Query one element or throw (a missing registry node is a boot defect,
 * never something to paper over).
 *
 * @param {string} selector
 * @returns {Element}
 */
function query(selector) {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`[ui] missing node: ${selector}`);
  return node;
}

/**
 * Query all elements matching a selector as an array.
 *
 * @param {string} selector
 * @returns {Element[]}
 */
function queryAll(selector) {
  return Array.from(document.querySelectorAll(selector));
}

// Feature 11 status-line shadow gate (see module header). The gate object
// stands in for the real element in the registry: writes through
// `dom.statusLine.textContent` are dropped while the shadow is active, so
// machine writes can never fight the real socket stage events. (The
// // MOCK (feature 09) cycler this originally shadowed was deleted in
// feature 15; the gate stays as the ownership boundary.)
const statusLineEl = query("[data-status-line]");
let statusLineShadowed = false;
const statusLineGate = {
  get textContent() {
    return statusLineEl.textContent;
  },
  set textContent(value) {
    if (!statusLineShadowed) statusLineEl.textContent = value;
  },
};

// Feature 11 in-call stage copy - byte-identical to the locked ui-rules.md
// strings (the state.js mock array they were checked against was deleted
// in feature 15; these constants are the only stage strings).
export const VOICE_STAGE_STATUS = Object.freeze({
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
});

/**
 * Feature 11: shadow direct status-line writes while a voice channel is
 * connected (its real stage events own the line).
 *
 * @param {boolean} active
 * @returns {void}
 */
export function setStatusLineShadow(active) {
  statusLineShadowed = active === true;
}

/**
 * Feature 11: write the status line directly (bypasses the shadow) - used
 * by the real stage events and call:error userMessage rendering.
 *
 * @param {string} text
 * @returns {void}
 */
export function writeStatusLine(text) {
  statusLineEl.textContent = text;
}

/** Registry of every node the machine and the wiring touch. */
export const dom = {
  timerChip: query("[data-timer-chip]"),
  callChip: query("[data-call-chip]"),
  callChipLabel: query("[data-call-chip-label]"),
  orbVideo: query("[data-orb]"),
  transcriptPanel: query("[data-transcript-panel]"),
  transcriptEmpty: query("[data-transcript-empty]"),
  transcriptList: query("[data-transcript-list]"),
  consentRow: query("[data-consent-row]"),
  consentInput: query("[data-consent-input]"),
  startButton: query("[data-start-button]"),
  endButton: query("[data-end-button]"),
  statusLine: statusLineGate,
  micBars: query("[data-mic-bars]"),
  micBarEls: queryAll("[data-mic-bars] .mic-bar"),
  summaryCard: query("[data-summary-card]"),
  summaryChip: query("[data-summary-chip]"),
  summaryChipLabel: query("[data-summary-chip-label]"),
  // feature 19: REAL render targets of the summary card
  summaryBody: query("[data-summary-card] .summary-body"),
  summaryBlockBodies: queryAll("[data-summary-card] .summary-block-body"),
  summarySkeleton: query("[data-summary-skeleton]"),
  // feature 19: summary failure row + its Retry
  summaryFail: query("[data-summary-fail]"),
  summaryRetry: query("[data-summary-retry]"),
  newCallButton: query("[data-new-call-button]"),
  devChips: query("[data-dev-chips]"),
  // feature 18-c: live navbar voice badge
  voiceChip: query("[data-voice-chip]"),
  voiceChipLabel: query("[data-voice-chip-label]"),
  historyEmpty: query("[data-history-empty]"),
  historyList: query("[data-history-list]"),
  // feature 20: list load-failure block + Retry (frozen copy)
  historyFail: query("[data-history-fail]"),
  historyRetry: query("[data-history-retry]"),
  confirmDialog: query("[data-confirm-dialog]"),
  confirmYes: query("[data-confirm-yes]"),
  confirmNo: query("[data-confirm-no]"),
  callDialog: query("[data-call-dialog]"),
  callDialogTitle: query("#call-dialog-title"),
  callDialogChip: query("[data-call-dialog-chip]"),
  callDialogChipLabel: query("[data-call-dialog-chip-label]"),
  callDialogBody: query("[data-call-dialog-body]"),
  callDialogClose: query("[data-call-dialog-close]"),
};

/**
 * Build one transcript bubble row (text via textContent - strings are
 * data, never markup). The ONE bubble DOM for real live turn:final rows
 * (feature 12+); the data-live-dynamic marker lets the transcript reset
 * drop exactly the dynamic rows.
 *
 * @param {{role: string, text: string, time: string}} entry
 * @param {string} dynamicAttr marker attribute for dynamic cleanup
 * @returns {HTMLLIElement}
 */
function buildBubbleRow(entry, dynamicAttr) {
  const isBot = entry.role === "bot";
  const row = document.createElement("li");
  row.className = isBot ? "bubble-row bubble-row--bot" : "bubble-row bubble-row--customer";
  row.setAttribute(dynamicAttr, "");
  const bubble = document.createElement("div");
  bubble.className = isBot ? "bubble bubble--bot" : "bubble bubble--customer";
  const text = document.createElement("p");
  text.className = "bubble-text";
  text.textContent = entry.text;
  const time = document.createElement("span");
  time.className = "bubble-time";
  time.textContent = entry.time;
  bubble.appendChild(text);
  row.appendChild(bubble);
  row.appendChild(time);
  return row;
}

/** Auto-scroll the transcript panel to the newest bubble. */
function scrollTranscriptToNewest() {
  dom.transcriptPanel.scrollTop = dom.transcriptPanel.scrollHeight;
}

/**
 * Render the transcript panel EMPTY (feature 15 call-start behavior):
 * the empty state copy ("Your conversation will appear here in real
 * time.") shows and every dynamic live bubble is dropped. The machine
 * calls this at call START (the transcript fills with real turn:final
 * bubbles as the live turns land) and at reset.
 *
 * @returns {void}
 */
export function renderTranscriptEmpty() {
  resetDynamicBubbles();
  dom.transcriptList.hidden = true;
  dom.transcriptEmpty.hidden = false;
}

/**
 * Feature 12: append one REAL transcript bubble for a live turn:final
 * payload (role "bot" | "customer"; the customer bubble carries ASR
 * text and - since feature 13 - the bot bubble carries the LLM reply
 * during a connected call). Text is written via textContent (never
 * markup); this is the ONLY bubble path since feature 15 deleted the
 * mock helpers.
 *
 * @param {"bot"|"customer"} role
 * @param {string} text
 * @param {string} timeStr "HH:MM:SS" clock time
 * @returns {void}
 */
export function appendTranscriptBubble(role, text, timeStr) {
  dom.transcriptEmpty.hidden = true;
  dom.transcriptList.hidden = false;
  dom.transcriptList.appendChild(
    buildBubbleRow({ role, text, time: timeStr }, "data-live-dynamic"),
  );
  scrollTranscriptToNewest();
}

/** Remove the dynamic live bubbles (transcript reset / empty render). */
function resetDynamicBubbles() {
  queryAll("[data-live-dynamic]").forEach((node) => node.remove());
}

/**
 * Set the timer chip text (mm:ss, tabular numerals via CSS).
 *
 * @param {string} text
 * @returns {void}
 */
export function setTimerText(text) {
  dom.timerChip.textContent = text;
}

/**
 * Set the console status chip label + role (role drives the dot color:
 * "ready" = gray dot, "live" = accent dot).
 *
 * @param {string} label
 * @param {string} role
 * @returns {void}
 */
export function setCallChip(label, role) {
  dom.callChipLabel.textContent = label;
  dom.callChip.setAttribute("data-role", role);
}

/**
 * Render the summary region.
 *
 * @param {"hidden"|"skeleton"|"shown"} mode
 * @returns {void}
 */
export function renderSummary(mode) {
  dom.summaryCard.hidden = mode !== "shown";
  dom.summarySkeleton.hidden = mode !== "skeleton";
  dom.newCallButton.hidden = mode !== "shown";
}

/**
 * Set the summary sales-status chip (closed six-value enum, role color).
 *
 * @param {string} label e.g. "Interested"
 * @param {string} role e.g. "interested"
 * @returns {void}
 */
export function setSummaryChip(label, role) {
  dom.summaryChipLabel.textContent = label;
  dom.summaryChip.setAttribute("data-role", role);
}

/**
 * Drive the 5 mic-level bars with REAL input volume (feature 10): one 0..1
 * fill value per bar. Inline height/opacity override the static CSS while
 * live input drives the bars; the CSS rules stay untouched (feature 10
 * contract: JS overrides, never deletes). The container keeps its
 * aria-hidden="true" (decorative meter).
 *
 * @param {number[]} levels exactly BAR_COUNT (5) values in [0, 1]
 * @returns {void}
 */
export function renderMicLevels(levels) {
  dom.micBarEls.forEach((bar, index) => {
    const fill = index < levels.length ? Math.max(0, Math.min(1, levels[index])) : 0;
    bar.style.height = `${(6 + 10 * fill).toFixed(2)}px`;
    bar.style.opacity = (0.35 + 0.65 * fill).toFixed(3);
  });
}

/**
 * Clear the inline live-volume overrides so the bars return to the static
 * CSS look (used when the mic is paused/idle).
 *
 * @returns {void}
 */
export function resetMicLevels() {
  dom.micBarEls.forEach((bar) => {
    bar.style.removeProperty("height");
    bar.style.removeProperty("opacity");
  });
}

/**
 * Render the history region (feature 20): "empty" shows the empty state
 * copy, "rows" shows the REAL list, "fail" shows the frozen load-failure
 * copy + Retry.
 *
 * @param {"empty"|"rows"|"fail"} mode
 * @returns {void}
 */
export function renderHistory(mode) {
  dom.historyEmpty.hidden = mode !== "empty";
  dom.historyList.hidden = mode !== "rows";
  dom.historyFail.hidden = mode !== "fail";
}

/**
 * Feature 18-c: flip the LIVE navbar voice badge. ONLINE mirrors the
 * converted/positive green (CSS role token); OFFLINE keeps the default
 * muted dot. The voice socket connect state (while a call is live) and
 * the 10 s /api/health poll are the two writers.
 *
 * @param {boolean} online
 * @returns {void}
 */
export function setVoiceServiceChip(online) {
  dom.voiceChipLabel.textContent = online ? "ONLINE" : "OFFLINE";
  dom.voiceChip.setAttribute("data-role", online ? "online" : "offline");
}
