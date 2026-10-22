/**
 * voice-service - features 11-15 voice socket channel + ASR + LLM + TTS
 * stages (independent bun mini-service). A plain node http server + socket.io
 * Server attached to it (platform-proven shape from
 * examples/websocket/server.ts): path "/" (the Caddy gateway forwards by
 * the XTransformPort query - do NOT change the path), websocket-only
 * (library-docs gotcha: the long-polling fallback breaks through the
 * gateway), generous ping settings.
 *
 * Feature 12 turn:end pipeline (ASR stage): utterance chunks accumulated
 * per turn -> pcm-wav -> Pattern P1 chain [groq, builtin] -> turn:final
 * { role: "user", text } emitted to the CLIENT, which relays it to the
 * persistence API (feature 17). The voice-service writes nothing.
 *
 * Feature 13 LLM sales brain (same turn, SAME 30 s budget): the
 * recognized user turn joins the per-session transcript memory
 * (transcript.js, capped + reset on call lifecycle), the
 * SALES_SYSTEM_PROMPT template is assembled (providers/config.js
 * buildSalesPrompt) and the Pattern P1 LLM chain
 * [groq-8b?, groq-70b?, xkiro-flash?, xkiro-qwen?, builtin] runs. Empty
 * output retries the
 * chain ONCE (library-docs error taxonomy), then call:error
 * { code: "llm_failed" } + listening. Success -> reply capped at
 * TURN_TEXT_MAX (600) -> turn:final { role: "bot", text } + memory +
 * llm_ok.
 *
 * Feature 14 TTS stage (same turn, SAME 30 s budget): the bot reply text
 * (sanitized: trim + collapsed whitespace) feeds the Pattern P1 TTS chain
 * [edge, builtin] (providers/config.js ttsChainSteps; both steps collect
 * fully and report the ACTUAL bytes mime). On success the stage
 * "speaking" is emitted FIRST (server-driven speaking starts when the
 * first audio is ready), then bot:speech chunks go out sequentially
 * ({ seq, audioBase64, mime, text } - <= 32000-char base64 slices via
 * providers/speech-chunks.js, seq across the WHOLE utterance, text = the
 * spoken reply on every chunk). After the last chunk the server emits
 * NOTHING further: the CLIENT flips the status line back to
 * "Listening…" when ITS playback ends (feature 14 UI) - stage
 * "speaking" stays server-owned from the start emit only. Chain
 * exhaustion -> tts_failed { statusCode } + call:error
 * { code: "tts_failed" } + stage listening (the bot TEXT turn:final has
 * already been emitted, so the conversation continues textually - honest
 * degradation). Barge-in while a TTS emission is in flight aborts the
 * chain step (AbortController, status 499 -> no retry), stops the
 * remaining bot:speech sends and logs tts_barged { sent, total } +
 * stage listening (the CLIENT glue that emits barge-in is feature 15).
 *
 * Feature 15 turn metrics (p50 instrumentation for feature 24): every
 * pipeline_end line carries the consolidated per-stage durations asrMs /
 * llmMs / ttsMs / totalMs plus chunks (null when a stage did not run in
 * that turn). The barge-in CLIENT glue lives in public/js/app.js
 * (feature 15): VAD SpeechStart while bot audio is playing emits
 * barge-in and flushes the client playback queue - this service aborts
 * the in-flight TTS stage (tts_barged + listening; feature 14 semantics
 * unchanged).
 *
 * Task 20-a (whole-turn barge abort + LLM latency bound): state.turnAbort
 * is the ONE per-JOB AbortController covering EVERY AI stage of a turn
 * (the opener job and each turn:end pipeline job arm it at job start and
 * clear it in their finally). handleBargeIn aborts it, so an in-flight
 * LLM step unwinds AT ONCE (status 499, no retry) instead of running to
 * its timeout while the user's next turn waits BEHIND it on the per-
 * session queue (the ~30 s stall root cause). runTtsStage no longer
 * creates its own controller: state.ttsAbort ALIASES state.turnAbort
 * while the TTS stage runs (backward-compatible barge detection + the
 * same tts_barged send-stop flag); the alias is the only ttsAbort writer.
 * Every LLM step (xkiro/groq/builtin) additionally arms
 * AbortSignal.timeout(LLM_TIMEOUT_MS) (8 s) via abort-guard.js
 * raceWithGuards - the TTS steps' exact pattern - so a stalled hosted hop
 * costs <= 8 s before the P1 hop, not 20 s (ASR/TTS keep AI_TIMEOUT_MS).
 * A barged brain returns { barged: true } and the pipeline drops the
 * reply SILENTLY (llm_barged + listening - NO call:error, NO bot turn,
 * NO TTS: the user interrupted; the stale reply must never arrive).
 * The DEFAULT llmProvider is "builtin" (measured 2026-10-22: ~0.7 s vs
 * the sensenova reasoning model at 5.5-8.8 s); Xkiro/Groq stay
 * selectable in Settings.
 *
 * Task 18-a (AI opener): THE BOT SPEAKS FIRST on a fresh call. When a
 * session's call:start is processed for the FIRST time (fresh callId - a
 * re-handshake with the SAME callId skips it entirely, logged
 * opener_skipped { reason: "rehandshake" }; the call_start line's
 * rehandshake:true marks exactly that case; a new callId after call:end
 * opens a new call and DOES get an opener), the sales prompt is rendered
 * with an EMPTY transcript and an empty latest utterance, plus a short
 * user-role instruction message (the customer just answered - speak ONLY
 * the opening line). The SAME LLM chain + single retry (runSalesBrain)
 * and the SAME TTS stage (runTtsStage) run, so the emission order is
 * byte-identical to a normal bot turn: turn:final { role: "bot", text }
 * -> stage "speaking" -> bot:speech chunks; the stage is left at
 * "speaking" (the CLIENT restores "Listening..." when ITS playback ends
 * - feature 14 semantics). The opener joins the SAME per-session
 * sequential queue as turn:end jobs (H-E6): a user utterance/turn:end
 * arriving mid-opener is processed AFTER it, never concurrently, and the
 * barge-in abort-guard (state.ttsAbort/state.ttsBarged) applies to the
 * opener's TTS send exactly like a normal send. Failure semantics:
 * LLM fails/empty -> opener_failed { reason class only, H-G4 } +
 * call:error { code: "opener_failed" } + stage listening (never throws
 * out of call:start); TTS fails after a good text -> the text turn:final
 * is STILL emitted, then the normal tts_failed call:error + listening.
 * The opener runs OUTSIDE the H-E2 turn budget (that budget wraps
 * turn:end processing only); per-step AI timeouts (chain.js) bound it.
 * Also Task 18-a: plain HTTP GET /healthz on the same :3003 server (see
 * the dispatcher next to the io construction) - an internal localhost
 * liveness probe for the main server, served before/independent of the
 * socket.io origin gate, no per-request logging.
 *
 * Task 21-a amendment (scripted opener): the opener TEXT is no longer
 * LLM-generated - runOpener emits the user-dictated SCRIPTED_OPENER pitch
 * (constant below; user, 2026-10-22: "Start with: 'I'm actually calling
 * from FlowSmith. We help businesses grow using AI in your workflows. We'll
 * speed up your coding and repetitive tasks.'" - and never ask "How is your
 * day going?"). The LLM chain no longer runs for the opener (runSalesBrain
 * stays a normal-turn path only), so opener_ok carries provider "scripted"
 * with zero LLM latency on the first audio and the opener_failed brain
 * paths are gone; the H-E6 queue job, the barge guards and the feature 14
 * TTS semantics are unchanged, and the opener still joins the transcript
 * memory so the next real turn keeps context.
 *
 * Feature 25 (Task 19-a, runtime provider config): the Settings panel on
 * the main server owns the provider/model/voice choices; BEFORE the
 * opener is built the call:start queue job PULLS the effective settings
 * from GET /internal/voice-config (token-guarded,
 * INTERNAL_CONFIG_TIMEOUT_MS budget) and stores them via
 * setRuntimeProviderConfig() - the chain builders in providers/config.js
 * resolve override ?? env ?? default, so a saved Setting takes effect on
 * the NEXT call with no restart. A null fetch result keeps the last
 * applied override (env fallbacks cover a cold start).
 *
 * Boundaries (architecture.md Invariants): this service emits protocol
 * events only - it NEVER writes the database. NO DB, NO Prisma, NO fs
 * writes (dev.log comes from the shell tee in package.json's dev script),
 * NO imports from public/. Feature 12 additions: providers/ import the
 * PURE, dependency-free canonical constants + AppError from server/lib
 * (single source of truth - the boundary rule forbids touching the
 * DB/static/uploads, not pure modules); env reads live ONLY in
 * providers/config.js (GROQ_API_KEY, XKIRO_API_KEY, XKIRO_BASE_URL); the
 * z-ai-web-dev-sdk is imported ONLY in providers/builtin-*.js
 * (server-side).
 *
 * Middleware runs BEFORE handlers, in this order:
 *   1. H-C6 same-origin gate (io.use, per connection)
 *   2. H-C7 rate gate (socket.use, every event, across ALL events)
 *   3. payload caps gate (socket.use, every event, utterance caps)
 * The call:start handshake is a HARD gate: consent !== true or an invalid
 * callId disconnects immediately. Other protocol violations (events while
 * idle/closed, malformed utterances, over-cap frames) count toward a
 * per-socket limit (>10 -> disconnect). Nothing hostile is ever echoed
 * back; call:error is reserved for infrastructure failure (H-E8).
 *
 * Protocol single copy: architecture.md "Voice Socket Protocol".
 * H-G4 posture: never log payloads - sizes and counts only.
 */

import { createServer } from "http";
import { Server } from "socket.io";
import {
  AUDIO_CHUNK_MAX_BYTES,
  SOCKET_MSG_PER_SEC,
  SOCKET_RATE_WINDOW_MS,
  SOCKET_TURN_BUDGET_MS,
  UTTERANCE_CHUNK_STORE_MAX,
  VOICE_SERVICE_PORT,
} from "./constants.js";
// Provenance: canonical pure constant owned by server/lib (single copy).
import { TURN_TEXT_MAX } from "../../server/lib/constants.js";
import { runChain } from "./providers/chain.js";
import {
  asrChainSteps,
  buildSalesPrompt,
  fetchVoiceConfig,
  llmChainSteps,
  setRuntimeProviderConfig,
  ttsChainSteps,
} from "./providers/config.js";
import { buildSpeechChunks } from "./providers/speech-chunks.js";
import { assembleWav } from "./providers/pcm-wav.js";
import {
  appendTranscriptTurn,
  createTranscriptMemory,
  resetTranscriptMemory,
} from "./transcript.js";
import {
  createSession,
  endCall,
  isLive,
  isValidUtterance,
  startCall,
} from "./session.js";

// H-E8: the only error copy this service emits (infrastructure failure,
// DependencyDown class - "Voice service temporarily unavailable." WITH the
// period). Protocol violations never echo - they disconnect.
const DEPENDENCY_DOWN_MESSAGE = "Voice service temporarily unavailable.";

// Library-docs.md error taxonomy (LLM output empty after trim -> retry
// the chain once -> this fixed copy; errors.js: taxonomy sentences are
// never invented, so the locked em dash byte is kept via the escape).
const TURN_TOO_LONG_MESSAGE = "The turn took too long \u2014 try again.";

// Task 18-a (AI opener): fixed user-facing copy for the one NEW failure
// class this task introduces - the bot's first line could not be produced
// (not in the locked errors.js taxonomy table, so the task-locked sentence
// is kept byte-identical; it states the honest way out, ending call).
const OPENER_FAILED_MESSAGE =
  "The agent could not start the conversation. Please end the call and try again.";

// Task 21-a (scripted opener): the user-dictated opening pitch (spoken on
// every fresh call; replaces the Task 18-a LLM-generated opener - zero LLM
// latency on the first audio and the pitch is exactly what the user wants
// said; user, 2026-10-22, product spelling "FlowSmith" per the Task 20-a
// rename). ASCII; locked copy once written.
const SCRIPTED_OPENER =
  "Hey, I'm actually calling from FlowSmith. We help businesses grow using AI " +
  "in their workflows - we basically build AI automations that speed up your " +
  "repetitive tasks and make the daily work quick and easy to organize.";

// Protocol violation disconnect threshold: more than 10 counted violations
// on one socket -> disconnect(true) (payload caps + session gates).
const VIOLATION_DISCONNECT_LIMIT = 10;

// H-C7 sustained abuse: more than 2x the per-second budget within any
// rolling 1 s window -> disconnect(true).
const RATE_ABUSE_MULTIPLIER = 2;

// Log throttle for rate drops: at most one rate_dropped line per second.
const RATE_DROP_LOG_INTERVAL_MS = 1000;

// client -> server events (architecture.md "Voice Socket Protocol")
const EV_CALL_START = "call:start";
const EV_UTTERANCE = "utterance";
const EV_TURN_END = "turn:end";
const EV_BARGE_IN = "barge-in";
const EV_CALL_END = "call:end";

/** One ASCII JSON line per event. NEVER log payloads (H-G4 posture). */
function logEvent(event, fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/**
 * Clip client-supplied strings for logs (log hygiene: hostile callers can
 * send huge values; the log carries a bounded prefix, never payloads).
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function clip(value, max = 64) {
  if (typeof value !== "string" || value.length === 0) return "?";
  return value.length > max ? `${value.slice(0, max)}...(${value.length})` : value;
}

/**
 * H-C7 token bucket: capacity tokens, refilling at capacity per second.
 * tryTake(nowMs) consumes one token; false means the event is over budget
 * and must be DROPPED, never processed.
 */
function createTokenBucket(capacity) {
  let tokens = capacity;
  let lastMs = Date.now();
  return {
    tryTake(nowMs) {
      tokens = Math.min(capacity, tokens + ((nowMs - lastMs) / 1000) * capacity);
      lastMs = nowMs;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

const httpServer = createServer();
const io = new Server(httpServer, {
  // DO NOT change the path - it is used by the gateway to forward to this
  // port (examples/websocket/server.ts).
  path: "/",
  // Websocket-only: the long-polling fallback breaks through the gateway.
  transports: ["websocket"],
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Task 18-a: internal localhost liveness probe on the SAME http server
// (plain HTTP GET /healthz -> 200 {"ok":true}, nothing else - no secrets,
// no version info, no per-request logging; the main server will call it).
// It is served BEFORE/independent of the socket.io origin gate: that gate
// (io.use below) only runs on socket.io handshakes, never on plain HTTP
// requests. Wiring note (provenance: socket.io 4.8.4 attach behavior, read
// from the installed engine.io/build/server.js): at attach time engine.io
// strips every existing 'request' listener and installs ONE wrapper whose
// path check ("/" === req.url.slice(0, 1), because the socket.io path is
// locked to "/") matches EVERY url - so a request handler passed to
// createServer() would never run. The dispatcher below therefore captures
// the untouched engine.io wrapper and re-installs it as the fallthrough:
// only the exact GET /healthz path is answered here, everything else is
// delegated byte-identically to socket.io/engine.io (websocket upgrades
// arrive on 'upgrade' and never pass through this handler).
const engineIoRequestHandler = httpServer.listeners("request")[0];
httpServer.removeAllListeners("request");
httpServer.on("request", (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  if (typeof engineIoRequestHandler === "function") engineIoRequestHandler(req, res);
});

/**
 * 1. H-C6 same-origin gate (per connection). Browsers do NOT attach
 * Sec-Fetch-* (Fetch Metadata) headers to WebSocket handshakes, so the
 * gate uses whichever browser same-origin signal is available:
 *   - sec-fetch-site PRESENT: it wins - allow only "same-origin" or
 *     "none"; anything else is blocked.
 *   - sec-fetch-site ABSENT: fall back to the Origin header, which the
 *     WebSocket spec REQUIRES browsers to send on the handshake and the
 *     gateway forwards. The origin must match the forwarded Host header
 *     by FULL authority (WHATWG URL .host = host AND port, e.g.
 *     "localhost:81") OR by BARE hostname (URL .hostname, e.g.
 *     "localhost"): Caddy forwards Host WITHOUT the port ({host} =
 *     hostname only), so a page on a non-default port (this sandbox's :81
 *     gateway) can only match on the hostname. No host allowlist, no env
 *     reads. Accepted residual risk (one sentence): a lying origin from
 *     the SAME machine on a different port passes the hostname compare.
 *   - BOTH absent (AMENDED Task 17-a, 2026-10-21): FAIL OPEN with ONE
 *     unverified_origin log line (counts/ids only, H-G4 - no header
 *     dumps). Rationale: the gateway-proxied websocket-only transport
 *     legitimately arrives without Fetch Metadata AND without Origin
 *     (metadata-stripping webviews/proxies strip both from WS upgrades;
 *     real user handshakes were blocked - user-facing outage). The abuse
 *     boundary for header-less clients remains the existing per-socket
 *     schema validation, the rate gate (H-C7) and the payload caps, so
 *     fail-open on absence is the accepted residual risk; explicit
 *     cross-site signals and origin-vs-Host mismatches are still blocked.
 * All rejections happen at the namespace handshake with next(Error) -
 * socket.io then emits "connect_error" to the client and closes the raw
 * socket (a bare disconnect(true) here would leave the handshake hanging).
 * One blocked_origin log line per block; only clipped authorities, never
 * full header dumps.
 */
io.use((socket, next) => {
  const headers = socket.handshake.headers;
  const first = (value) => (Array.isArray(value) ? value[0] : value);

  // Case 1: explicit Fetch Metadata header - explicit values only.
  const site = first(headers["sec-fetch-site"]);
  if (typeof site === "string") {
    if (site === "same-origin" || site === "none") {
      next();
      return;
    }
    logEvent("blocked_origin", { socket: socket.id, secFetchSite: clip(site, 32) });
    next(new Error("origin blocked"));
    return;
  }

  // Case 2: sec-fetch-site absent - Origin-vs-forwarded-Host (browser WS).
  const origin = first(headers.origin);
  if (typeof origin !== "string" || origin.length === 0) {
    // Case 3 (amended Task 17-a): both signals absent -> ALLOW. The
    // gateway-proxied websocket-only transport legitimately arrives
    // header-less (metadata-stripping webviews/proxies strip Fetch
    // Metadata AND Origin); the abuse boundary for header-less clients
    // remains the per-socket schema validation, the rate gate (H-C7)
    // and the payload caps - accepted residual risk. Explicit
    // cross-site signals are still blocked (Cases 1-2 above).
    logEvent("unverified_origin", { socket: socket.id });
    next();
    return;
  }
  let originAuthority = null;
  let originHostname = null;
  try {
    const parsed = new URL(origin);
    originAuthority = parsed.host; // host AND port, e.g. "localhost:81"
    originHostname = parsed.hostname; // host only, e.g. "localhost"
  } catch {
    originAuthority = null; // invalid URL -> block below
  }
  const forwardedHost = first(headers.host);
  const hostPresent = typeof forwardedHost === "string";
  // The gateway forwards Host WITHOUT the port (Caddy v2 {host} placeholder
  // = hostname only), while URL.host includes it - a page on a non-default
  // port (the :81 sandbox gateway) can only match on the hostname. Accepted
  // residual risk: a lying origin from the SAME machine on a different port
  // passes the hostname compare.
  const originAllowed =
    originAuthority !== null &&
    hostPresent &&
    (originAuthority === forwardedHost || originHostname === forwardedHost);
  if (originAllowed) {
    next();
    return;
  }
  logEvent("blocked_origin", {
    socket: socket.id,
    secFetchSite: "absent",
    originHost: originAuthority === null ? "invalid" : clip(originAuthority),
    originHostname: originHostname === null ? "invalid" : clip(originHostname),
    host: hostPresent ? clip(forwardedHost) : "absent",
  });
  next(new Error("origin blocked"));
});

/** Count one protocol violation; > limit disconnects the socket. */
function registerViolation(socket, state, kind) {
  state.violations += 1;
  logEvent("violation", { socket: socket.id, kind, count: state.violations });
  if (state.violations > VIOLATION_DISCONNECT_LIMIT) {
    logEvent("disconnect_violations", { socket: socket.id, count: state.violations });
    socket.disconnect(true);
  }
}

/**
 * 2. H-C7 rate gate (every event, across ALL events): token bucket per
 * socket. Over-budget events are DROPPED (never processed); sustained
 * abuse (>2x budget within any rolling 1 s window) disconnects.
 */
function rateGate(socket, state) {
  return (event, next) => {
    const nowMs = Date.now();
    // Rolling 1 s window of incoming events (dropped ones included).
    state.recentEventTimesMs.push(nowMs);
    const cutoffMs = nowMs - SOCKET_RATE_WINDOW_MS;
    while (state.recentEventTimesMs.length > 0 && state.recentEventTimesMs[0] < cutoffMs) {
      state.recentEventTimesMs.shift();
    }
    if (state.recentEventTimesMs.length > SOCKET_MSG_PER_SEC * RATE_ABUSE_MULTIPLIER) {
      logEvent("disconnect_rate", {
        socket: socket.id,
        windowEvents: state.recentEventTimesMs.length,
        budgetPerWindow: SOCKET_MSG_PER_SEC * RATE_ABUSE_MULTIPLIER,
      });
      socket.disconnect(true);
      return;
    }
    if (!state.bucket.tryTake(nowMs)) {
      state.droppedEvents += 1;
      if (nowMs - state.lastDropLogAtMs >= RATE_DROP_LOG_INTERVAL_MS) {
        state.lastDropLogAtMs = nowMs;
        logEvent("rate_dropped", {
          socket: socket.id,
          event: typeof event[0] === "string" ? event[0] : "unknown",
          dropped: state.droppedEvents,
        });
      }
      return; // DROPPED - never processed, no handler runs, no echo.
    }
    next();
  };
}

/**
 * 3. Payload caps gate (every event, before the handlers): an utterance
 * whose pcmBase64 is not a string or exceeds AUDIO_CHUNK_MAX_BYTES base64
 * chars is dropped + violation-counted; >10 violations -> disconnect.
 */
function payloadCapGate(socket, state) {
  return (event, next) => {
    if (event[0] !== EV_UTTERANCE) {
      next();
      return;
    }
    const payload = event.length > 1 ? event[1] : null;
    const pcmBase64 =
      payload !== null && typeof payload === "object" ? payload.pcmBase64 : undefined;
    if (typeof pcmBase64 !== "string" || pcmBase64.length > AUDIO_CHUNK_MAX_BYTES) {
      registerViolation(socket, state, "utterance_payload_cap");
      return;
    }
    next();
  };
}

/**
 * H-E2: arm the 30 s turn budget timer (wraps turn processing). onExpire
 * is the per-turn expiry hook (marks that turn's flag so a late pipeline
 * result is dropped); expiry also emits the call:error + returns the
 * stage to listening so the next utterance can start.
 *
 * @param {object} socket
 * @param {object} state
 * @param {() => void} [onExpire]
 */
function startTurnBudget(socket, state, onExpire) {
  clearTurnBudget(state);
  state.turnBudgetTimerId = setTimeout(() => {
    state.turnBudgetTimerId = null;
    if (typeof onExpire === "function") onExpire();
    if (!isLive(state.session)) return;
    logEvent("turn_timeout", {
      socket: socket.id,
      callId: clip(state.session.callId),
      budgetMs: SOCKET_TURN_BUDGET_MS,
    });
    socket.emit("call:error", {
      code: "turn_timeout",
      userMessage: DEPENDENCY_DOWN_MESSAGE,
    });
    socket.emit("stage", { stage: "listening" });
  }, SOCKET_TURN_BUDGET_MS);
}

/**
 * Cap the bot reply at TURN_TEXT_MAX (600) BEFORE emitting (build-plan
 * feature 13): plain slice, preferring the last word boundary inside the
 * capped range when one exists.
 *
 * @param {string} text already-trimmed reply text
 * @returns {string}
 */
function capTurnText(text) {
  if (text.length <= TURN_TEXT_MAX) return text;
  const sliced = text.slice(0, TURN_TEXT_MAX);
  const lastSpace = sliced.lastIndexOf(" ");
  return lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;
}

/**
 * Task 2-c: split a sanitized reply into its FIRST sentence and the rest
 * so runTtsStage can synthesize + send the first sentence immediately
 * (first-audio latency) while the remainder is synthesized next. Pure
 * helper: no I/O, no logging, never throws.
 *
 * Rules (task 2-c spec):
 * - A sentence boundary is the first run of terminators (. ! ? including
 *   doubled forms like "??" / "!?" / "?!") followed by end-of-text OR a
 *   space + ASCII capital/digit (a new sentence starts there). Runs like
 *   "..." are consumed whole; a terminator followed by a lowercase letter
 *   (e.g. "e.g. we") is NOT a boundary and scanning continues.
 * - No valid boundary found -> { first: text, rest: "" } (single chunk,
 *   identical to today's behavior).
 * - Tiny first chunks are FINE and FASTER (task 2-c: no minimum-length
 *   gluing; only glue when the candidate first sentence is empty, e.g. a
 *   reply that opens with "..." -> keep scanning so the first chunk is
 *   never an empty string).
 * - Note on the spec's "<= 80 chars -> single chunk" cap: the task's own
 *   dictated unit expectations require "Hey there. We help businesses
 *   grow using AI." (45 chars) to split, so the cap is superseded by the
 *   boundary rule; short replies WITHOUT a boundary still come back as a
 *   single chunk via the no-boundary rule.
 *
 * @param {string} text sanitized reply text (trim + collapsed whitespace)
 * @returns {{first: string, rest: string}} rest === "" means single chunk
 */
function splitFirstSentence(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { first: "", rest: "" };
  }
  const isTerminator = (ch) => ch === "." || ch === "!" || ch === "?";
  let i = 0;
  while (i < text.length) {
    if (!isTerminator(text[i])) {
      i += 1;
      continue;
    }
    // Consume the whole terminator run ("??", "!?", "...", "!!!").
    let end = i;
    while (end < text.length && isTerminator(text[end])) end += 1;
    if (end >= text.length) {
      // Terminator run reaches the end of text: the whole text is the
      // first sentence, nothing left to split.
      return { first: text, rest: "" };
    }
    if (text[end] === " ") {
      const next = text[end + 1] ?? "";
      const startsNewSentence =
        (next >= "A" && next <= "Z") || (next >= "0" && next <= "9");
      const first = text.slice(0, end);
      if (startsNewSentence && first.trim().length > 0) {
        return { first, rest: text.slice(end + 1).trim() };
      }
    }
    // Not a sentence boundary ("3.5", "vs. we", empty prefix) - keep
    // scanning after this terminator run.
    i = end;
  }
  return { first: text, rest: "" };
}

/**
 * FEATURE 13: run the LLM sales-brain chain for one turn (runs inside
 * the per-session queue and the 30 s turn budget). Library-docs error
 * taxonomy: LLM text empty after trim -> retry the chain ONCE (two runs
 * max, fresh steps per run); still empty -> { ok: false, empty: true }.
 * Chain exhaustion (Pattern P1 AppError 503) -> { ok: false,
 * empty: false, statusCode }. Provider attribution wraps each step so
 * the winning step's name is captured; Pattern P1 itself stays the
 * verbatim library-docs envelope. Never logs prompt or reply text
 * (H-G4) - attempts, counters, durations, status codes only.
 *
 * @param {object} socket
 * @param {object} state per-socket state (state.llmCalls counter;
 *   state.turnAbort carries the whole-turn barge signal, Task 20-a)
 * @param {{role: string, content: string}[]} messages chat-style messages
 *   for the chain (the normal turn path sends the assembled sales prompt
 *   as ONE user message; the Task 18-a opener adds a second user-role
 *   instruction message)
 * @returns {Promise<{ok: true, text: string, provider: string|null,
 *   ms: number}|{ok: false, barged: true, empty: false, statusCode: 499,
 *   ms: number}|{ok: false, empty: boolean, statusCode: number,
 *   ms: number}>}
 */
async function runSalesBrain(socket, state, messages) {
  const startedMonoMs = Math.round(performance.now());
  for (let attempt = 1; attempt <= 2; attempt++) {
    // H-G3 posture: count every LLM call per session; real quota
    // enforcement (60 turns/hour/IP, checked BEFORE spend) lands on the
    // main-server relay in feature 17.
    state.llmCalls += 1;
    let provider = null;
    // Task 20-a: the whole-turn barge signal rides into EVERY LLM step
    // (abort-guard.js guards: a pre-aborted signal rejects in ~0 ms, so
    // post-hop steps unwind instantly).
    const steps = llmChainSteps(messages, state.turnAbort?.signal).map((step) => ({
      name: step.name,
      run: async () => {
        const output = await step.run();
        provider = step.name;
        return output;
      },
    }));
    let raw = null;
    let failure = null;
    try {
      raw = await runChain(steps);
    } catch (error) {
      failure = error;
    }
    if (failure !== null) {
      // Task 20-a: a barge-in abort (guard status 499) or an aborted turn
      // controller ends the brain IMMEDIATELY - no retry, no residue (a
      // 499 hops through every remaining P1 step and exhausts into the
      // 503 AppError, so the signal/flag check is what classifies it).
      const statusCode = typeof failure.status === "number" ? failure.status : 0;
      if (statusCode === 499 || state.ttsBarged || state.turnAbort?.signal.aborted) {
        return {
          ok: false,
          barged: true,
          empty: false,
          statusCode: 499,
          ms: Math.round(performance.now()) - startedMonoMs,
        };
      }
      return {
        ok: false,
        empty: false,
        statusCode,
        ms: Math.round(performance.now()) - startedMonoMs,
      };
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text.length > 0) {
      // The abort landed in the window after the step resolved but before
      // this check: drop the late reply exactly like a failed one.
      if (state.ttsBarged || state.turnAbort?.signal.aborted) {
        return {
          ok: false,
          barged: true,
          empty: false,
          statusCode: 499,
          ms: Math.round(performance.now()) - startedMonoMs,
        };
      }
      return {
        ok: true,
        text,
        provider,
        ms: Math.round(performance.now()) - startedMonoMs,
      };
    }
    logEvent("llm_empty", {
      socket: socket.id,
      attempt,
      llmCalls: state.llmCalls,
    });
  }
  return {
    ok: false,
    empty: true,
    statusCode: 0,
    ms: Math.round(performance.now()) - startedMonoMs,
  };
}

/**
 * FEATURE 14: run the TTS stage for one turn (runs inside the
 * per-session queue and the 30 s turn budget, after the bot turn:final
 * has already been emitted).
 *
 *   sanitized reply -> Pattern P1 chain [edge, builtin]
 *     - chain exhausted -> tts_failed { statusCode } + call:error
 *       { code: "tts_failed" } + listening (text turn already emitted -
 *       the conversation continues textually; honest degradation)
 *     - barge-in (state.ttsBarged) at ANY point -> tts_barged
 *       { sent, total } + listening, no further bot:speech sends
 *     - turn budget expired mid-stage -> tts_late_dropped (the client
 *       already received turn_timeout + listening)
 *     - success -> stage "speaking" FIRST, then bot:speech chunks
 *       sequentially ({ seq, audioBase64, mime, text }); after the last
 *       chunk NOTHING further is emitted - the client returns the status
 *       to "Listening…" when ITS playback ends (feature 14 UI), so the
 *       server leaves the stage at "speaking" (server-driven speaking
 *       starts when the first audio is ready).
 *     - Task 2-c (first-audio latency): the reply is split by
 *       splitFirstSentence - when it has a first sentence + remainder,
 *       the FIRST sentence is synthesized, sent (seq 0..n, text = first
 *       sentence), and THEN the remainder is synthesized and sent (seq
 *       continues, text = remainder). 2 sequential synthesis runs max;
 *       the guards (ttsBarged / turnAbort signal / turn.expired / client
 *       connection) are re-checked BETWEEN the two sends with the same
 *       transitions as before. tts_ok gains firstChunkMs (first-audio
 *       latency; ms stays the TOTAL) + restProvider on split flows; a
 *       rest failure after chunk 1 was sent logs tts_rest_failed (honest
 *       partial - no call:error mid-speech).
 *
 * The chain is wired with the per-JOB turn AbortController (Task 20-a:
 * state.ttsAbort aliases state.turnAbort - ONE abort owner for the whole
 * turn): barge-in aborts the in-flight step (status 499 -> Pattern P1
 * hops without retry), stops the remaining bot:speech sends and the
 * whole turn's other AI stages. Never logs audio or reply text (H-G4) -
 * provider, ms, chunk counts and byte sizes only.
 *
 * @param {object} socket
 * @param {object} state per-socket state (state.turnAbort owner;
 *   state.ttsAbort aliases it while this stage runs, state.ttsBarged)
 * @param {{expired: boolean}} turn per-turn expiry flag (see handleTurnEnd)
 * @param {string} replyText the capped bot reply that was already emitted
 * @returns {Promise<number|null>} the TTS stage duration in ms (null when
 *   the stage was skipped before timing started) - the pipeline_end
 *   turn-metrics field ttsMs (feature 15)
 */
async function runTtsStage(socket, state, turn, replyText) {
  // Input = sanitized reply text (build-plan feature 14): trim +
  // collapsed whitespace; each step re-sanitizes defensively.
  const sanitized = typeof replyText === "string" ? replyText.replace(/\s+/g, " ").trim() : "";
  if (sanitized.length === 0) {
    logEvent("tts_skipped", { socket: socket.id, reason: "empty_text" });
    socket.emit("stage", { stage: "listening" });
    return null;
  }
  // Task 20-a: state.turnAbort (owned by the queue job) is the ONE abort
  // owner for the whole turn - TTS included. state.ttsAbort ALIASES it
  // while this stage runs (backward-compatible barge detection in
  // handleBargeIn); this stage clears the alias in finally WITHOUT
  // touching state.turnAbort (the job's finally owns that lifecycle).
  // Defensive fallback: if no turn controller exists the chain still
  // runs, bounded only by its own AI_TIMEOUT guards.
  state.ttsAbort = state.turnAbort ?? null;
  state.ttsBarged = false;
  const startedMonoMs = Math.round(performance.now());
  try {
    // Task 2-c: sentence split for FIRST-AUDIO latency. split.rest === ""
    // means single chunk - same behavior as before this task. Otherwise
    // the FIRST sentence is synthesized + sent immediately (the seq
    // counter continues), then the remainder is synthesized and sent as
    // the following seq (2 synthesis runs max, strictly SEQUENTIAL -
    // voice-service is single-threaded and parallel edge calls risk
    // socket write reordering). The client's SpeechPlayer queues
    // bot:speech chunks sequentially and deadReplyTexts matches
    // per-chunk text (chunk.text), so each chunk carries its own text
    // field (first / rest).
    const split = splitFirstSentence(sanitized);
    const twoChunks = split.rest !== "";
    const elapsedMs = () => Math.round(performance.now()) - startedMonoMs;

    // Provider attribution for tts_ok: wrap each step so the winning
    // step's name is captured; Pattern P1 itself stays the verbatim
    // library-docs envelope. provider = the chunk that produced the
    // FIRST audio; restProvider = the remainder chunk (split flow only).
    let provider = null;
    let restProvider = null;
    const makeSteps = (text, slot) =>
      ttsChainSteps(
        text,
        state.turnAbort ? state.turnAbort.signal : undefined,
      ).map((step) => ({
        name: step.name,
        run: async () => {
          const output = await step.run();
          if (slot === "rest") restProvider = step.name;
          else provider = step.name;
          return output;
        },
      }));

    // One Pattern P1 chain run for one chunk of text (same envelope the
    // pre-split single run used: fresh steps per run, P1 retry/hop
    // semantics, barge-in signal threaded through).
    const synthPart = async (text, slot) => {
      let speech = null;
      let failure = null;
      try {
        speech = await runChain(makeSteps(text, slot));
      } catch (error) {
        failure = error;
      }
      return { speech, failure };
    };

    const usableSpeech = (speech) =>
      speech !== null &&
      typeof speech === "object" &&
      Array.isArray(speech.chunks) &&
      speech.chunks.length > 0 &&
      typeof speech.mime === "string" &&
      speech.mime.length > 0;

    // Emission shared state: ONE seq counter across BOTH chunks (client
    // SpeechPlayer reassembles by arrival order), accumulated byte count
    // and the first-audio latency stamp.
    let sent = 0;
    let totalBytes = 0;
    let firstChunkMs = null;

    // Send one chunk's slices with the SAME per-slice guards as today
    // (barge-in, turn budget). Returns null on success, otherwise the
    // bail class for the caller to log/transition exactly as today.
    const speakSlices = (slices, mime, chunkText) => {
      for (const slice of slices) {
        if (state.ttsBarged) return "barged";
        if (turn.expired) return "expired";
        socket.emit("bot:speech", {
          seq: sent,
          audioBase64: slice.audioBase64,
          mime,
          text: chunkText,
        });
        if (firstChunkMs === null) firstChunkMs = elapsedMs();
        sent += 1;
        totalBytes += slice.bytes;
      }
      return null;
    };

    // Barge transition (identical event fields + emit as today's paths).
    const bailBarged = (plannedTotal) => {
      logEvent("tts_barged", { socket: socket.id, sent, total: plannedTotal });
      socket.emit("stage", { stage: "listening" });
      return elapsedMs();
    };

    // ---- chunk 1: first sentence (or the whole reply when unsplit) ----
    const firstText = twoChunks ? split.first : sanitized;
    const firstRun = await synthPart(firstText, "first");
    const usable = usableSpeech(firstRun.speech);
    if (firstRun.failure !== null || !usable) {
      if (state.ttsBarged) {
        // Barge-in aborted the chain mid-synthesis (status 499 hops, P1
        // exhausts instantly) - the barge path owns the transition.
        return bailBarged(0);
      }
      const statusCode =
        firstRun.failure !== null && typeof firstRun.failure.status === "number"
          ? firstRun.failure.status
          : 0;
      logEvent("tts_failed", { socket: socket.id, statusCode, ms: elapsedMs() });
      socket.emit("call:error", {
        code: "tts_failed",
        userMessage: DEPENDENCY_DOWN_MESSAGE,
      });
      socket.emit("stage", { stage: "listening" });
      return elapsedMs();
    }
    if (turn.expired) {
      logEvent("tts_late_dropped", { socket: socket.id, provider, ms: elapsedMs() });
      return elapsedMs();
    }
    if (state.ttsBarged) {
      return bailBarged(0);
    }
    const firstSlices = buildSpeechChunks(firstRun.speech.chunks);
    if (firstSlices.length === 0) {
      // Chain succeeded but carried zero audio bytes - honest failure.
      logEvent("tts_failed", { socket: socket.id, statusCode: 0, ms: elapsedMs() });
      socket.emit("call:error", {
        code: "tts_failed",
        userMessage: DEPENDENCY_DOWN_MESSAGE,
      });
      socket.emit("stage", { stage: "listening" });
      return elapsedMs();
    }
    // Server-driven speaking starts when the first audio is ready: the
    // stage flips BEFORE the first bot:speech chunk.
    socket.emit("stage", { stage: "speaking" });
    const firstBail = speakSlices(firstSlices, firstRun.speech.mime, firstText);
    if (firstBail === "barged") {
      return bailBarged(firstSlices.length);
    }
    if (firstBail === "expired") {
      // Budget fired mid-emission (turn_timeout already emitted to the
      // client) - stop sending, drop the remainder honestly.
      logEvent("tts_late_dropped", {
        socket: socket.id,
        sent,
        total: firstSlices.length,
      });
      return elapsedMs();
    }

    // ---- chunk 2: the remainder (split flow only) ----
    if (twoChunks) {
      // Task 2-c guard re-check (BETWEEN the two sends): the SAME guards
      // the pre-send path checks today - barge-in (state.ttsBarged) AND
      // its abort twin (state.turnAbort?.signal.aborted), the turn
      // budget, and the client connection. Each bail uses the same
      // transition as the corresponding pre-send path above.
      if (state.ttsBarged || state.turnAbort?.signal.aborted) {
        return bailBarged(firstSlices.length);
      }
      if (turn.expired) {
        logEvent("tts_late_dropped", {
          socket: socket.id,
          sent,
          total: firstSlices.length,
        });
        return elapsedMs();
      }
      if (socket.connected === false) {
        // Client connection gone (disconnect teardown owns the state
        // reset) - nothing to emit, log the honest drop.
        logEvent("tts_late_dropped", {
          socket: socket.id,
          reason: "disconnected",
          sent,
          total: firstSlices.length,
          ms: elapsedMs(),
        });
        return elapsedMs();
      }
      const restRun = await synthPart(split.rest, "rest");
      const restUsable = usableSpeech(restRun.speech);
      if (restRun.failure !== null || !restUsable) {
        if (state.ttsBarged) {
          // Barge aborted the rest chain mid-synthesis (499 hops, P1
          // exhausts instantly) - the barge path owns the transition.
          return bailBarged(firstSlices.length);
        }
        // Rest synthesis failed AFTER the first chunk was already sent.
        // Honest partial: the full reply text was already emitted
        // (turn:final) and the user is hearing chunk 1, so no call:error
        // (a mid-speech dependency-down toast would contradict the audio
        // playing) and no stage emit - the client restores "Listening..."
        // when ITS playback ends (feature 14). Reason class only (H-G4).
        const statusCode =
          restRun.failure !== null && typeof restRun.failure.status === "number"
            ? restRun.failure.status
            : 0;
        logEvent("tts_rest_failed", {
          socket: socket.id,
          statusCode,
          sent,
          ms: elapsedMs(),
        });
        return elapsedMs();
      }
      const restSlices = buildSpeechChunks(restRun.speech.chunks);
      if (restSlices.length === 0) {
        logEvent("tts_rest_failed", {
          socket: socket.id,
          statusCode: 0,
          sent,
          ms: elapsedMs(),
        });
        return elapsedMs();
      }
      const restBail = speakSlices(restSlices, restRun.speech.mime, split.rest);
      if (restBail === "barged") {
        return bailBarged(firstSlices.length + restSlices.length);
      }
      if (restBail === "expired") {
        logEvent("tts_late_dropped", {
          socket: socket.id,
          sent,
          total: firstSlices.length + restSlices.length,
        });
        return elapsedMs();
      }
    }

    logEvent("tts_ok", {
      socket: socket.id,
      provider,
      // ms stays the TOTAL stage duration (synthesis + emission);
      // firstChunkMs is the first-audio latency (stage start -> first
      // bot:speech emit). restProvider rides along on split flows.
      ms: elapsedMs(),
      chunks: sent,
      bytes: totalBytes,
      firstChunkMs: firstChunkMs ?? elapsedMs(),
      ...(twoChunks && restProvider !== null ? { restProvider } : {}),
    });
    // FEATURE 14 contract: emit NOTHING further here - the CLIENT sets
    // "Listening..." when ITS playback of the utterance ends.
    return elapsedMs();
  } finally {
    state.ttsAbort = null;
    state.ttsBarged = false;
  }
}

/** H-E2: clear the turn budget timer (turn done or session torn down). */
function clearTurnBudget(state) {
  if (state.turnBudgetTimerId !== null) {
    clearTimeout(state.turnBudgetTimerId);
    state.turnBudgetTimerId = null;
  }
}

/**
 * Task 18-a (AI opener), AMENDED Task 21-a (scripted opener): the bot
 * SPEAKS FIRST on a fresh call. Runs as a per-session queue job (enqueued
 * by handleCallStart) so it is ordered against turn:end jobs on the SAME
 * queue (H-E6): a user utterance/turn:end arriving while the opener runs
 * is processed AFTER it, never concurrently.
 *
 *   barge guard FIRST (state.ttsBarged / state.turnAbort?.signal.aborted
 *     -> opener_barged + listening; the abort may have landed while the
 *     queue job was still pulling the runtime config)
 *     -> reply = capTurnText(SCRIPTED_OPENER) (the user-dictated pitch; a
 *     scripted line cannot fail, so the Task 18-a LLM chain and its
 *     opener_failed brain paths are gone - runSalesBrain no longer runs
 *     here)
 *     -> turn:final { role: "bot", text } -> transcript memory bot turn
 *     (the NEXT real LLM turn has the opener as context) -> opener_ok
 *     { ms, chars, provider: "scripted" } -> runTtsStage (the SAME
 *     feature 14 TTS stage: stage "speaking" BEFORE the first bot:speech
 *     chunk, barge-in abort-guarded sends via state.ttsAbort/
 *     state.ttsBarged, tts_failed -> call:error + listening while the
 *     text turn:final stays emitted). On success NOTHING is emitted after
 *     the last chunk - the stage stays "speaking" and the CLIENT restores
 *     "Listening..." when ITS playback ends (feature 14 semantics).
 *
 * The opener runs OUTSIDE the H-E2 turn budget (that budget wraps turn:end
 * processing only). The H-E6 queue job, the barge guards and the TTS
 * failure semantics are unchanged - only the LLM hop is gone. The
 * last-resort catch keeps the Task 18-a failure transition: a scripted
 * line cannot fail, but nothing ever throws out of the call:start
 * processing path.
 *
 * @param {object} socket
 * @param {object} state per-socket state
 * @returns {Promise<void>}
 */
async function runOpener(socket, state) {
  const turn = { expired: false };
  const startedMonoMs = Math.round(performance.now());
  try {
    // Barge guard FIRST (Task 20-a per-JOB controller): the abort may have
    // landed while the queue job was still pulling the runtime config - a
    // barged opener must never reach the client (silent, no call:error).
    if (state.ttsBarged || state.turnAbort?.signal.aborted) {
      logEvent("opener_barged", { socket: socket.id });
      socket.emit("stage", { stage: "listening" });
      return;
    }
    // Task 21-a: the user-dictated pitch. A scripted line cannot fail -
    // no LLM chain, no empty-output retry, no opener_failed brain paths.
    const reply = capTurnText(SCRIPTED_OPENER);
    // Cap + emit + memory exactly like the normal bot turn path
    // (runTurnPipeline), then hand the text to the SAME TTS stage.
    socket.emit("turn:final", { role: "bot", text: reply });
    appendTranscriptTurn(state.transcript, "bot", reply);
    logEvent("opener_ok", {
      socket: socket.id,
      ms: Math.round(performance.now()) - startedMonoMs,
      chars: reply.length,
      provider: "scripted",
    });
    await runTtsStage(socket, state, turn, reply);
  } catch {
    // Last resort beyond the queue guard (enqueueTurn never rejects): an
    // unexpected error still owns the failure transition instead of
    // leaving the call stuck mid-opener. Reason class only (H-G4).
    logEvent("opener_failed", { socket: socket.id, reason: "unexpected" });
    socket.emit("call:error", {
      code: "opener_failed",
      userMessage: OPENER_FAILED_MESSAGE,
    });
    socket.emit("stage", { stage: "listening" });
  }
}

/**
 * call:start: HARD handshake gate. consent !== true or an invalid callId
 * never reaches the session and is never counted toward the violation
 * counter - the socket is disconnected on the spot (client observes
 * "disconnect"), logged with a reason field, no payload echo. A valid
 * handshake marks the session live + stage listening; a re-handshake while
 * live is a normal reset (restarted flag from session.js), never an error.
 */
function handleCallStart(socket, state, payload) {
  const result = startCall(state.session, payload);
  if (result.violation !== null) {
    logEvent("call_start_rejected", { socket: socket.id, reason: result.violation });
    socket.disconnect(true);
    return;
  }
  state.session = result.session;
  // Feature 13: the transcript memory + LLM call counter are per live
  // session - a (re-)handshake resets both (bun --hot reconnects and
  // reloads re-handshake transparently; history never leaks across
  // calls).
  resetTranscriptMemory(state.transcript);
  state.llmCalls = 0;
  logEvent("call_start", {
    socket: socket.id,
    callId: clip(result.session.callId),
    rehandshake: result.restarted,
  });
  socket.emit("stage", { stage: "listening" });
  // The H-E2 bookkeeping resets at handshake. A turn already queued before
  // the re-handshake still drains on the same socket (its budget timer was
  // cleared here, so it completes bounded only by the per-step AI
  // timeouts); the client re-handshakes only on reload/reconnect.
  clearTurnBudget(state);
  // Task 18-a (AI opener): the bot speaks FIRST - once per live session
  // period, keyed by callId. state.openerCallId records the callId the
  // opener ran for; a re-handshake with the SAME callId (the call_start
  // line above logged rehandshake:true - the client re-sends call:start
  // after a socket drop / bun --hot reload while the call stays live)
  // is SKIPPED entirely and logged opener_skipped { reason:
  // "rehandshake" }. A NEW callId (fresh uuid per Start Call, and New Call
  // after call:end) opens a new call and DOES get the opener. The flag
  // resets with the session/call lifecycle (nulled on call:end and
  // disconnect below; fresh per connection), so each live session period
  // owns at most one opener.
  if (state.openerCallId === result.session.callId) {
    logEvent("opener_skipped", { socket: socket.id, reason: "rehandshake" });
    return;
  }
  state.openerCallId = result.session.callId;
  // H-E6 ordering: the opener joins the SAME per-session sequential queue
  // as turn:end jobs (enqueueTurn), so a user utterance/turn:end arriving
  // during the opener is processed after it - never concurrently.
  // Feature 25 (Task 19-a): BEFORE the opener the job pulls the runtime
  // provider config from the main server (one token-guarded fetch; <=
  // INTERNAL_CONFIG_TIMEOUT_MS (2.5 s) worst case ONLY when the main
  // server is down, ~ms normally) so the session's chains use the
  // configured provider/model. Since Task 21-a the scripted opener itself
  // needs no LLM - the fetch still lands here so the FIRST normal turn's
  // chain is already resolved. A null result keeps the last applied
  // override (the resolvers' env fallback covers a cold start).
  enqueueTurn(socket, state, async () => {
    const rc = await fetchVoiceConfig("call_start");
    if (rc) setRuntimeProviderConfig(rc);
    // Task 20-a: the opener job owns the SAME per-JOB whole-turn abort
    // controller as a turn:end job - barge-in aborts the opener's LLM/
    // TTS exactly like a normal turn.
    const turnAbort = new AbortController();
    state.turnAbort = turnAbort;
    try {
      await runOpener(socket, state);
    } finally {
      if (state.turnAbort === turnAbort) state.turnAbort = null;
    }
  });
}

/**
 * utterance: only when live AND consent true; shape-validated (the 32 KB
 * base64 frame cap already ran in the payload-caps gate). FEATURE 12:
 * the chunk payloads accumulate in arrival order (socket.io preserves
 * per-socket order) for the turn:end ASR run. Bounded store: beyond
 * UTTERANCE_CHUNK_STORE_MAX the NEWEST chunks are dropped and counted
 * (memory bound; the client VAD ring is 30 s / ~40 chunks). H-G4: chunks
 * are never logged - sizes and counts only.
 */
function handleUtterance(socket, state, payload) {
  if (!isLive(state.session)) {
    registerViolation(socket, state, "utterance_not_live");
    return;
  }
  if (!isValidUtterance(payload)) {
    registerViolation(socket, state, "utterance_shape");
    return;
  }
  if (state.utteranceChunks.length >= UTTERANCE_CHUNK_STORE_MAX) {
    state.droppedChunkCount += 1;
    return;
  }
  state.utteranceChunks.push({ seq: payload.seq, pcmBase64: payload.pcmBase64 });
}

/**
 * Take (and reset) the accumulated utterance chunks + drop counter.
 *
 * @param {object} state
 * @returns {{chunks: object[], droppedChunks: number}}
 */
function takeUtteranceChunks(state) {
  const chunks = state.utteranceChunks;
  const droppedChunks = state.droppedChunkCount;
  state.utteranceChunks = [];
  state.droppedChunkCount = 0;
  return { chunks, droppedChunks };
}

/**
 * H-E6 posture: turns on one socket process ONE AT A TIME - each turn:end
 * appends its job to the per-session promise queue; a job never runs
 * while the previous one is still in flight. runTurnPipeline handles its
 * own failures, so the queue never rejects; the catch here is the
 * last-resort guard that keeps the queue alive no matter what.
 *
 * @param {object} socket
 * @param {object} state
 * @param {() => Promise<void>} job
 * @returns {void}
 */
function enqueueTurn(socket, state, job) {
  const run = async () => {
    try {
      await job();
    } catch (error) {
      logEvent("turn_error", {
        socket: socket.id,
        message: clip(String(error instanceof Error ? error.message : error), 120),
      });
    }
  };
  state.turnQueue = state.turnQueue.then(run, run);
}

/**
 * FEATURE 12 ASR stage for one turn (runs inside the per-session queue):
 *
 *   chunks -> none? asr_skipped + listening (VAD misfire honesty)
 *   else   -> pcm-wav -> Pattern P1 chain [groq, builtin]
 *             - chain output empty -> asr_empty + listening (no
 *               turn:final - silence honesty)
 *             - chain exhausted -> call:error { code: "asr_failed" }
 *               + listening, asr_failed { statusCode } only (H-G4)
 *             - success -> turn:final { role: "user", text } +
 *               asr_ok { provider, ms, chars }
 *
 *   FEATURE 13 LLM hop (same queue job, SAME 30 s budget): the user
 *   turn joins the transcript memory -> buildSalesPrompt -> Pattern P1
 *   chain [groq-8b?, groq-70b?, xkiro-flash?, xkiro-qwen?, builtin]
 *             - empty output -> retry the chain ONCE (taxonomy); still
 *               empty -> call:error { code: "llm_failed" } with the
 *               "too long" taxonomy copy + listening, NO bot turn
 *             - chain exhausted -> call:error { code: "llm_failed" }
 *               + listening, llm_failed { statusCode } only (H-G4)
 *             - success -> reply capped at TURN_TEXT_MAX (600) ->
 *               turn:final { role: "bot", text } + transcript memory +
 *               llm_ok { provider, ms, chars, llmCalls }
 *   FEATURE 14 TTS hop (same queue job, SAME 30 s budget): the sanitized
 *   bot reply feeds the Pattern P1 chain [edge, builtin] -> stage
 *   "speaking" FIRST -> sequential bot:speech chunks; after the last
 *   chunk the server emits NOTHING (the CLIENT restores "Listening…"
 *   when its playback ends); failure -> call:error { code:
 *   "tts_failed" } + listening; barge-in aborts the chain + stops the
 *   sends (tts_barged + listening). See runTtsStage.
 *   the 30 s SOCKET_TURN_BUDGET_MS timer wraps the whole turn (H-E2);
 *   after expiry a late result is dropped (the client already received
 *   turn_timeout + listening). The budget timer is cleared on every path
 *   (finally). Logs carry sizes/counts/status codes only (H-G4).
 *   FEATURE 15 turn metrics: the finally block logs pipeline_end with
 *   the consolidated asrMs / llmMs / ttsMs / totalMs / chunks fields
 *   (null = the stage did not run in this turn) - the p50
 *   instrumentation feature 24 tunes against.
 *
 * @param {object} socket
 * @param {object} state
 * @param {{expired: boolean}} turn per-turn expiry flag (see handleTurnEnd)
 * @param {number} startedMonoMs monotonic pipeline_start timestamp
 * @returns {Promise<void>}
 */
async function runTurnPipeline(socket, state, turn, startedMonoMs) {
  const { chunks, droppedChunks } = takeUtteranceChunks(state);
  // FEATURE 15 turn metrics: per-stage durations, null until the stage
  // actually runs in this turn (stale/skip/failure-before-stage paths
  // keep the null). Emitted consolidated on pipeline_end (finally).
  let asrMs = null;
  let llmMs = null;
  let ttsMs = null;
  // Task 20-a: the per-JOB whole-turn abort owner - EVERY AI stage of
  // this turn (LLM + TTS) races its signal; handleBargeIn aborts it so a
  // stalled LLM hop cannot hold the per-session queue. Cleared in the
  // finally ONLY when it still belongs to this job.
  const turnAbort = new AbortController();
  state.turnAbort = turnAbort;
  try {
    if (turn.expired) {
      // The budget fired before this queued turn could start: the client
      // already received turn_timeout + listening; drop it (chunks die).
      logEvent("asr_stale_dropped", {
        socket: socket.id,
        chunks: chunks.length,
        droppedChunks,
      });
      return;
    }
    if (chunks.length === 0) {
      logEvent("asr_skipped", {
        socket: socket.id,
        reason: "no_chunks",
        droppedChunks,
      });
      socket.emit("stage", { stage: "listening" });
      return;
    }
    const wav = assembleWav(chunks.map((chunk) => chunk.pcmBase64));
    // Provider attribution for asr_ok: wrap each step so the winning
    // step's name is captured; Pattern P1 itself stays the verbatim
    // library-docs envelope.
    let provider = null;
    const steps = asrChainSteps(wav).map((step) => ({
      name: step.name,
      run: async () => {
        const output = await step.run();
        provider = step.name;
        return output;
      },
    }));
    const asrStartedMonoMs = Math.round(performance.now());
    let rawText = null;
    let asrFailure = null;
    try {
      rawText = await runChain(steps);
    } catch (error) {
      asrFailure = error;
    }
    asrMs = Math.round(performance.now()) - asrStartedMonoMs;
    if (asrFailure !== null) {
      // Chain exhaustion (AppError 503 DependencyDown) or an unexpected
      // chain error - the architecture failure path: call:error with the
      // taxonomy copy, logged by status code only (H-G4).
      logEvent("asr_failed", {
        socket: socket.id,
        statusCode: typeof asrFailure.status === "number" ? asrFailure.status : 0,
        ms: asrMs,
      });
      if (!turn.expired) {
        socket.emit("call:error", {
          code: "asr_failed",
          userMessage: DEPENDENCY_DOWN_MESSAGE,
        });
        socket.emit("stage", { stage: "listening" });
      }
      return;
    }
    if (turn.expired) {
      logEvent("asr_late_dropped", { socket: socket.id, provider, ms: asrMs });
      return;
    }
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (text.length === 0) {
      // Silence / misfire honesty: an empty transcript is NOT a turn.
      logEvent("asr_empty", { socket: socket.id, provider, ms: asrMs });
      socket.emit("stage", { stage: "listening" });
      return;
    }
    socket.emit("turn:final", { role: "user", text });
    logEvent("asr_ok", {
      socket: socket.id,
      provider,
      ms: asrMs,
      chars: text.length,
    });
    // FEATURE 13 (LLM sales brain): the recognized user turn joins the
    // session transcript memory FIRST (the prompt history includes it),
    // then the sales prompt is assembled and the LLM chain runs inside
    // the SAME 30 s turn budget (H-E2 wraps ASR + LLM; the turn
    // completes after the bot reply is emitted, or the timer fires
    // turn_timeout + listening).
    appendTranscriptTurn(state.transcript, "user", text);
    const prompt = buildSalesPrompt({
      history: state.transcript.turns,
      latestUserText: text,
    });
    const brain = await runSalesBrain(socket, state, [{ role: "user", content: prompt }]);
    llmMs = brain.ms;
    if (!brain.ok) {
      if (brain.barged) {
        // Task 20-a: the user interrupted - NO call:error, NO bot turn,
        // NO TTS. The stage returns to listening and the turn ends; the
        // stale reply must never arrive.
        logEvent("llm_barged", { socket: socket.id });
        socket.emit("stage", { stage: "listening" });
        return;
      }
      if (brain.empty) {
        // Library-docs taxonomy: still empty after the one retry - the
        // per-attempt llm_empty lines are already logged. No bot turn.
        socket.emit("call:error", {
          code: "llm_failed",
          userMessage: TURN_TOO_LONG_MESSAGE,
        });
      } else {
        // Chain exhaustion - the architecture failure path, logged by
        // status code only (H-G4).
        logEvent("llm_failed", {
          socket: socket.id,
          statusCode: brain.statusCode,
          ms: brain.ms,
        });
        socket.emit("call:error", {
          code: "llm_failed",
          userMessage: DEPENDENCY_DOWN_MESSAGE,
        });
      }
      socket.emit("stage", { stage: "listening" });
      return;
    }
    if (turn.expired) {
      // The budget fired while the LLM ran: the client already received
      // turn_timeout + listening - drop the late result.
      logEvent("llm_late_dropped", {
        socket: socket.id,
        provider: brain.provider,
        ms: brain.ms,
      });
      return;
    }
    // Task 20-a success-path barge guard: the abort landed after the LLM
    // completed (post-hop window) - drop the late reply the same silent
    // way (barge is separate from the budget's llm_late_dropped).
    if (state.ttsBarged || state.turnAbort?.signal.aborted) {
      logEvent("llm_barged", { socket: socket.id });
      socket.emit("stage", { stage: "listening" });
      return;
    }
    // Cap BEFORE emitting (TURN_TEXT_MAX, word-boundary cut preferred).
    const reply = capTurnText(brain.text);
    socket.emit("turn:final", { role: "bot", text: reply });
    appendTranscriptTurn(state.transcript, "bot", reply);
    logEvent("llm_ok", {
      socket: socket.id,
      provider: brain.provider,
      ms: brain.ms,
      chars: reply.length,
      llmCalls: state.llmCalls,
    });
    // FEATURE 14 (TTS stage): the bot reply text is spoken over the
    // SAME turn and budget - runTtsStage owns the "speaking" flip, the
    // bot:speech emission, the tts_failed/barged/late paths and the
    // barge-in AbortController. On the success path it intentionally
    // emits NOTHING after the last chunk (the client's playback end
    // restores "Listening…"); every failure path returns the stage to
    // listening so the next utterance can start. Its measured duration
    // feeds the pipeline_end turn metrics (feature 15).
    ttsMs = (await runTtsStage(socket, state, turn, reply)) ?? null;
  } finally {
    // Task 20-a: release the turn abort owner (only if it is still this
    // job's - a newer job may already have replaced it).
    if (state.turnAbort === turnAbort) state.turnAbort = null;
    clearTurnBudget(state);
    // FEATURE 15 turn metrics (p50 instrumentation for feature 24): ONE
    // consolidated line per turn - the per-stage durations ride on
    // pipeline_end as extra fields (null = the stage did not run).
    // Timings/sizes/counts only - never text/audio (H-G4).
    const totalMs = Math.round(performance.now()) - startedMonoMs;
    logEvent("pipeline_end", {
      socket: socket.id,
      monoMs: Math.round(performance.now()),
      elapsedMs: totalMs,
      asrMs,
      llmMs,
      ttsMs,
      totalMs,
      chunks: chunks.length,
      droppedChunks,
    });
  }
}

/**
 * turn:end: only when live. Emits stage thinking (feature 11 behavior,
 * kept - the ASR stage runs under it), arms the H-E2 30 s turn budget
 * around the WHOLE turn, and enqueues the FEATURE 12 pipeline job on the
 * per-session queue (sequential, H-E6 posture).
 */
function handleTurnEnd(socket, state) {
  if (!isLive(state.session)) {
    registerViolation(socket, state, "turn_end_not_live");
    return;
  }
  socket.emit("stage", { stage: "thinking" });
  const startedMonoMs = Math.round(performance.now());
  logEvent("pipeline_start", {
    socket: socket.id,
    callId: clip(state.session.callId),
    monoMs: startedMonoMs,
  });
  // H-E2: the 30 s SOCKET_TURN_BUDGET_MS timer wraps turn processing
  // (ASR + the feature 13 LLM hop; the turn completes after the bot
  // reply is emitted, or the timer fires); expiry emits call:error
  // { code: "turn_timeout" } + stage listening
  // and marks THIS turn so its late result is dropped. A newer turn:end
  // re-arms the timer (the older turn then completes without a watchdog,
  // bounded by the per-step AI timeouts).
  const turn = { expired: false };
  startTurnBudget(socket, state, () => {
    turn.expired = true;
  });
  enqueueTurn(socket, state, () => runTurnPipeline(socket, state, turn, startedMonoMs));
}

/**
 * barge-in: only when live. FEATURE 14 server side, extended by Task 20-a
 * to the WHOLE turn: while the turn's AI stages are in flight the barge
 * aborts state.turnAbort (the per-JOB controller every stage races).
 * With TTS in flight (state.ttsAbort aliases the turn controller) this is
 * exactly the feature 14 semantics: the chain step rejects (status 499 ->
 * Pattern P1 hops without retry), the remaining bot:speech sends stop and
 * runTtsStage logs tts_barged { sent, total } + emits stage listening
 * (single owner of that transition). Without TTS in flight (ASR/LLM
 * running) the abort still unwinds the turn instantly so a stalled LLM
 * hop cannot hold the per-session queue; the pipeline drops the result
 * silently (llm_barged + listening - the user interrupted). With NO AI
 * stage in flight this stays the feature 11 log-only line (the CLIENT
 * glue that emits barge-in and flushes its playback queue is feature 15).
 */
function handleBargeIn(socket, state) {
  if (!isLive(state.session)) {
    registerViolation(socket, state, "barge_in_not_live");
    return;
  }
  if (state.ttsAbort) {
    // TTS stage of the turn is in flight (Task 20-a: state.ttsAbort
    // ALIASES state.turnAbort - aborting it aborts the WHOLE turn's AI
    // stages, not just TTS). Same feature 14 semantics: flag + abort +
    // the ttsAborted log line; runTtsStage logs tts_barged + listening.
    state.ttsBarged = true;
    try {
      state.ttsAbort.abort();
    } catch {
      // abort cannot realistically throw; guarded so the handler never does
    }
    logEvent("barge_in", {
      socket: socket.id,
      callId: clip(state.session.callId),
      ttsAborted: true,
    });
    return;
  }
  if (state.turnAbort) {
    // Task 20-a: an AI stage without TTS is in flight (ASR/LLM) - abort
    // the WHOLE turn so a stalled LLM hop cannot run to its timeout while
    // the user's next turn waits BEHIND it on the per-session queue (the
    // steps unwind at once; the pipeline drops the result silently).
    try {
      state.turnAbort.abort();
    } catch {
      // abort cannot realistically throw; guarded so the handler never does
    }
  }
  logEvent("barge_in", { socket: socket.id, callId: clip(state.session.callId) });
}

/**
 * call:end: only when live; malformed durationSec is ignored (session
 * stays live, no violation); valid -> closed (terminal), timers cleared.
 */
function handleCallEnd(socket, state, payload) {
  const result = endCall(state.session, payload);
  if (result.reason === "not_live") {
    registerViolation(socket, state, "call_end_not_live");
    return;
  }
  if (result.ignored) {
    logEvent("call_end_ignored", { socket: socket.id, reason: result.reason });
    return;
  }
  state.session = result.session;
  clearTurnBudget(state);
  state.utteranceChunks = [];
  state.droppedChunkCount = 0;
  // Feature 13 hygiene: no transcript turns survive a closed call.
  resetTranscriptMemory(state.transcript);
  state.llmCalls = 0;
  // Feature 14 hygiene: no TTS emission survives a closed call.
  state.ttsAbort = null;
  state.ttsBarged = false;
  // Task 20-a hygiene: the whole-turn abort owner resets with the call
  // lifecycle (the running job's finally skips its clear because the
  // field no longer points at its controller).
  state.turnAbort = null;
  // Task 18-a hygiene: the opener flag resets with the call lifecycle -
  // the next live period (new callId) owns a fresh opener.
  state.openerCallId = null;
  logEvent("call_end", { socket: socket.id, durationSec: result.durationSec });
}

/** Per-connection wiring: per-socket state, gates, then handlers. */
io.on("connection", (socket) => {
  const state = {
    session: createSession(),
    bucket: createTokenBucket(SOCKET_MSG_PER_SEC),
    recentEventTimesMs: [],
    droppedEvents: 0,
    lastDropLogAtMs: 0,
    violations: 0,
    turnBudgetTimerId: null,
    // H-E6 posture: per-session turn queue - one turn at a time.
    turnQueue: Promise.resolve(),
    // FEATURE 12: utterance chunks accumulated for the next turn:end
    // (bounded store, see handleUtterance).
    utteranceChunks: [],
    droppedChunkCount: 0,
    // FEATURE 13: per-session sales transcript memory (transcript.js)
    // + LLM call counter (H-G3 posture; real quota enforcement lands on
    // the main-server relay in feature 17).
    transcript: createTranscriptMemory(),
    llmCalls: 0,
    // FEATURE 14: per-turn TTS emission state - state.ttsAbort is NOT a
    // second controller (Task 20-a): it ALIASES state.turnAbort (the ONE
    // per-JOB whole-turn abort owner below) while the TTS stage runs, and
    // state.ttsBarged stops further bot:speech sends.
    turnAbort: null,
    ttsAbort: null,
    ttsBarged: false,
    // Task 18-a (AI opener): callId the opener already ran for on this
    // session (a re-handshake with the SAME callId skips the opener;
    // reset with the session/call lifecycle at call:end / disconnect).
    openerCallId: null,
  };

  logEvent("connection", { socket: socket.id });

  // Middleware BEFORE handlers, in order: rate gate (2), payload caps (3).
  // (The same-origin gate (1) already ran as io.use before this handler.)
  socket.use(rateGate(socket, state));
  socket.use(payloadCapGate(socket, state));

  socket.on(EV_CALL_START, (payload) => handleCallStart(socket, state, payload));
  socket.on(EV_UTTERANCE, (payload) => handleUtterance(socket, state, payload));
  socket.on(EV_TURN_END, () => handleTurnEnd(socket, state));
  socket.on(EV_BARGE_IN, () => handleBargeIn(socket, state));
  socket.on(EV_CALL_END, (payload) => handleCallEnd(socket, state, payload));

  socket.on("disconnect", (reason) => {
    clearTurnBudget(state);
    state.utteranceChunks = [];
    state.droppedChunkCount = 0;
    resetTranscriptMemory(state.transcript);
    state.llmCalls = 0;
    state.ttsAbort = null;
    state.ttsBarged = false;
    // Task 20-a hygiene: the whole-turn abort owner dies with the socket.
    state.turnAbort = null;
    state.openerCallId = null;
    logEvent("disconnect", {
      socket: socket.id,
      reason: typeof reason === "string" ? reason : "unknown",
    });
  });
});

httpServer.listen(VOICE_SERVICE_PORT, () => {
  logEvent("listening", { port: VOICE_SERVICE_PORT });
});

// Graceful shutdown (platform-proven example shape; no fs, no env reads).
process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});
