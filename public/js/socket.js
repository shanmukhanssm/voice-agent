/**
 * socket.js - feature 11 voice socket channel (browser client).
 *
 * Wraps the VENDORED socket.io client build (public/vendor/
 * socket.io.min.js), which loads as a classic script BEFORE this module
 * graph, exposing the global `io` - no import, no npm client bundle in
 * the browser.
 *
 * Gateway contract (library-docs.md, "socket.io (voice channel)"): the
 * client ALWAYS connects with io("/?XTransformPort=3003",
 * { transports: ["websocket"], path: "/" }) - a relative URL; the Caddy
 * gateway routes by the XTransformPort query. Absolute URLs and explicit
 * ports are banned, and transports stay websocket-only (the long-polling
 * fallback breaks through the gateway).
 *
 * Re-handshake gotcha: bun --hot reloads drop server socket state; the
 * client auto-reconnects (socket.io defaults) and "connect" fires again,
 * so call:start is (re-)emitted on EVERY connect. The server treats a
 * re-handshake as normal - never an error.
 *
 * Protocol: architecture.md "Voice Socket Protocol" (single copy).
 * turn:final carries the ASR stage's user payload since feature 12 and
 * the bot LLM reply (role "bot") since feature 13; bot:speech carries
 * the TTS stage's audio slices { seq, audioBase64, mime, text } since
 * feature 14 (forwarded whole to app.js -> SpeechPlayer.enqueue).
 *
 * connect_error surfacing (Task 17-a): a blocked/dead socket used to
 * retry silently forever (the user saw "nothing happened"). The first
 * connect_error of a call session is surfaced through onError as
 * { code: "connect_failed", userMessage: CONNECT_FAILED_MESSAGE } - the
 * same sentence as the server's DEPENDENCY_DOWN_MESSAGE copy - and is
 * NOT repeated until a successful connect re-arms it (auto-reconnect
 * stays on, socket.io defaults).
 */

// Provenance: public/vendor/socket.io.min.js is the unmodified dist build
// of socket.io-client 4.8.4 (scratch install under /tmp via
// "bun add socket.io-client"; node_modules/socket.io-client/dist/
// socket.io.min.js copied verbatim into public/vendor/).

// Gateway URL: relative, the XTransformPort query carries the routing.
const VOICE_SOCKET_URL = "/?XTransformPort=3003";
// Websocket-only through the gateway; path "/" is the gateway contract.
const VOICE_SOCKET_OPTIONS = { transports: ["websocket"], path: "/" };

// Event names (architecture.md "Voice Socket Protocol").
const EV_CALL_START = "call:start";
const EV_UTTERANCE = "utterance";
const EV_TURN_END = "turn:end";
const EV_BARGE_IN = "barge-in";
const EV_CALL_END = "call:end";
const EV_STAGE = "stage";
const EV_TURN_FINAL = "turn:final";
const EV_BOT_SPEECH = "bot:speech";

// Locked error copy (Task 17-a): byte-identical to the server's
// DEPENDENCY_DOWN_MESSAGE (mini-services/voice-service/index.js) -
// app.js handleVoiceError renders userMessage verbatim.
const CONNECT_FAILED_MESSAGE = "Voice service temporarily unavailable.";

/** All socket events this module listens to (for clean teardown). */
const SERVER_EVENTS = [
  EV_STAGE,
  EV_TURN_FINAL,
  EV_BOT_SPEECH,
  "call:error",
  "connect",
  "disconnect",
  "connect_error",
];

/**
 * Invoke one handler defensively - a throwing handler must never break
 * the page or the socket (app.js contract: socket failure never breaks
 * the mock UI).
 *
 * @param {Function|undefined} handler
 * @param {unknown} arg
 * @returns {void}
 */
function safeCall(handler, arg) {
  if (typeof handler !== "function") return;
  try {
    handler(arg);
  } catch (error) {
    console.warn(
      "[voice] handler error:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Create one voice socket channel (one per call). start() opens the
 * socket and (re-)handshakes on every connect; close() tears everything
 * down. Emitting methods no-op safely while the channel is not connected.
 *
 * @param {object} handlers server -> client callbacks:
 *     onStage(stage) - stage from `stage {stage}`;
 *     onError(error) - the `call:error {code, userMessage}` payload;
 *     onTurnFinal(turn) - `turn:final` payload (features 12-13);
 *     onBotSpeech(chunk) - `bot:speech` payload, forwarded WHOLE as
 *         { seq, audioBase64, mime, text } (feature 14 -> SpeechPlayer);
 *     onConnected() / onDisconnected() - optional connection watchers
 *         (app.js shadows the mock status cycler while connected).
 *     onError also fires for socket connect_error (Task 17-a): the FIRST
 *         failure of a call session arrives as
 *         { code: "connect_failed", userMessage: CONNECT_FAILED_MESSAGE },
 *         re-armed by the next successful connect.
 * @returns {{start: Function, sendUtterance: Function, endTurn: Function,
 *            bargeIn: Function, endCall: Function, close: Function,
 *            isConnected: Function}}
 */
export function createVoiceChannel(handlers) {
  const h = handlers !== null && typeof handlers === "object" ? handlers : {};
  let socket = null;
  let connected = false;
  let session = null; // { callId, consent } - re-sent on every (re)connect
  // Task 17-a: connect_error is surfaced AT MOST ONCE per call session;
  // a successful connect re-arms it (auto-reconnect stays on).
  let connectErrorSurfaced = false;

  /**
   * "connect" fires on the first connect AND on every auto-reconnect
   * (bun --hot reloads): re-emit call:start so the server re-handshakes
   * transparently.
   */
  function onConnect() {
    connected = true;
    connectErrorSurfaced = false; // re-arm the connect_error surfacing
    if (session && socket) {
      try {
        socket.emit(EV_CALL_START, { callId: session.callId, consent: session.consent });
      } catch (error) {
        console.warn(
          "[voice] call:start emit failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    safeCall(h.onConnected);
  }

  function onDisconnect() {
    connected = false; // auto-reconnect stays on (socket.io defaults)
    safeCall(h.onDisconnected);
  }

  /**
   * connect_error (Task 17-a): blocked/dead socket - surface the failure
   * to the user at most once per call session (the flag re-arms on the
   * next successful connect). Auto-reconnect stays on (socket.io
   * defaults), so a transient blip recovers without user action.
   */
  function onConnectError() {
    if (connectErrorSurfaced) return;
    connectErrorSurfaced = true;
    safeCall(h.onError, { code: "connect_failed", userMessage: CONNECT_FAILED_MESSAGE });
  }

  /**
   * Open the channel. Refuses (false, no socket) when consent is not
   * exactly true - the client-side H-B5 twin of the server gate.
   *
   * @param {string} callId fresh call id (crypto.randomUUID)
   * @param {boolean} consent consent checkbox state
   * @returns {boolean} true when the channel started
   */
  function start(callId, consent) {
    if (consent !== true) return false;
    const id = typeof callId === "string" ? callId : "";
    if (id.length === 0) return false;
    session = { callId: id, consent: true };
    if (socket) return true; // already open; (re)handshake already handled
    if (typeof io !== "function") {
      console.warn("[voice] vendored socket.io client missing (global io)");
      session = null;
      return false;
    }
    socket = io(VOICE_SOCKET_URL, VOICE_SOCKET_OPTIONS);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on(EV_STAGE, (data) => safeCall(h.onStage, data ? data.stage : undefined));
    socket.on(EV_TURN_FINAL, (data) => safeCall(h.onTurnFinal, data));
    socket.on(EV_BOT_SPEECH, (data) => safeCall(h.onBotSpeech, data));
    socket.on("call:error", (data) => safeCall(h.onError, data));
    return true;
  }

  /**
   * Emit one client -> server event; no-op when not connected.
   *
   * @param {string} event
   * @param {unknown} payload
   * @returns {boolean} true when emitted
   */
  function emit(event, payload) {
    if (!socket || !connected) return false;
    try {
      socket.emit(event, payload);
      return true;
    } catch (error) {
      console.warn(
        "[voice] emit failed:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /** Clean teardown: remove listeners, close the socket, drop state. */
  function close() {
    session = null;
    connected = false;
    if (!socket) return;
    const closing = socket;
    socket = null;
    try {
      SERVER_EVENTS.forEach((event) => closing.off(event));
      closing.close();
    } catch (error) {
      console.warn(
        "[voice] channel close failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return Object.freeze({
    start,
    /** utterance {seq, pcmBase64, sampleRate: 16000} (feature 15 glue). */
    sendUtterance: (chunk) => emit(EV_UTTERANCE, chunk),
    endTurn: () => emit(EV_TURN_END, {}),
    bargeIn: () => emit(EV_BARGE_IN, {}),
    endCall: (durationSec) => {
      const seconds = Number(durationSec);
      return emit(EV_CALL_END, { durationSec: Number.isFinite(seconds) ? seconds : 0 });
    },
    close,
    isConnected: () => connected,
  });
}
