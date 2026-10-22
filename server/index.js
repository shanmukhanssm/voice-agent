/**
 * index.js - the ONE main Bun server (architecture.md ss System Boundaries):
 * Bun.serve on :3000 = static files from public/ + REST dispatch to
 * server/routes/ handlers + Prisma/SQLite + uploads ownership. The voice
 * mini-service (:3003) is a separate process and never shares this path.
 *
 * Boot order: env validation (ADR H-01: malformed throws, missing warns)
 * -> Bun.serve. Every response carries the security headers; every /api
 * response goes through the one envelope; handler errors never leak
 * internals (log + reference ID + generic 500).
 */
import { join, resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./lib/config.js";
import { validateEnv } from "./lib/env.js";
import { log } from "./lib/log.js";
import {
  SECURITY_HEADERS,
  apiNotFoundEnvelope,
  methodNotAllowedEnvelope,
  errorResponse,
} from "./lib/envelope.js";
import { healthRoute } from "./routes/health.js";
import {
  createCallRoute,
  listCallsRoute,
  getCallRoute,
  addTurnRoute,
  deleteCallRoute,
} from "./routes/calls.js";
import { summaryRoute } from "./routes/summary.js";
import {
  uploadRecordingRoute,
  getRecordingRoute,
} from "./routes/recording.js";
import {
  getSettingsRoute,
  putSettingsRoute,
  testSettingsRoute,
  internalVoiceConfigRoute,
} from "./routes/settings.js";

// --- boot: validate env BEFORE serving (ADR H-01) -------------------------
const envCompleteness = validateEnv();

// --- route table: EXACT path + method rows (library-docs ss Bun.serve) ----
const API_ROUTES = Object.freeze([
  { method: "GET", path: "/api/health", handler: healthRoute },
  { method: "POST", path: "/api/calls", handler: createCallRoute },
  { method: "GET", path: "/api/calls", handler: listCallsRoute },
  // feature 25 (Task 19-a): settings panel reads/writes + the live LLM ping
  { method: "GET", path: "/api/settings", handler: getSettingsRoute },
  { method: "PUT", path: "/api/settings", handler: putSettingsRoute },
  { method: "POST", path: "/api/settings/test", handler: testSettingsRoute },
]);

// --- parametrized subtree: /api/calls/:submissionId[/turns|/summary] -------
// The ONLY non-exact /api routes (features 17/19). submissionId is the
// client-generated UUID (idempotency key, H-B7); it is matched as a single
// non-empty segment and percent-decoded before it reaches Prisma - a decode
// failure is an unknown path, never an exception.
const CALLS_PARAM_ROUTES = Object.freeze([
  {
    pattern: /^\/api\/calls\/([^/]+)$/,
    handlers: Object.freeze({ GET: getCallRoute, DELETE: deleteCallRoute }),
  },
  {
    pattern: /^\/api\/calls\/([^/]+)\/turns$/,
    handlers: Object.freeze({ POST: addTurnRoute }),
  },
  {
    pattern: /^\/api\/calls\/([^/]+)\/summary$/,
    handlers: Object.freeze({ POST: summaryRoute }),
  },
  // feature 21 quick path: recording upload (raw webm) + playback
  {
    pattern: /^\/api\/calls\/([^/]+)\/recording$/,
    handlers: Object.freeze({ POST: uploadRecordingRoute, GET: getRecordingRoute }),
  },
]);

/**
 * Match one parametrized /api/calls route.
 * @param {string} pathname request pathname (still percent-encoded)
 * @param {string} method request method
 * @returns {{ handler: Function, submissionId: string } | { notAllowed: true } | null}
 *   null = no path match (caller answers 404 envelope); notAllowed = known
 *   path shape, unsupported method (caller answers 405 envelope)
 */
function matchParamRoute(pathname, method) {
  for (const row of CALLS_PARAM_ROUTES) {
    const match = row.pattern.exec(pathname);
    if (!match) continue;
    const handler = row.handlers[method];
    if (!handler) return { notAllowed: true };
    try {
      return { handler, submissionId: decodeURIComponent(match[1]) };
    } catch {
      return null; // malformed percent-encoding -> unknown path
    }
  }
  return null;
}

// --- static files ----------------------------------------------------------
const PUBLIC_ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const ROOT_WITH_SEP = PUBLIC_ROOT.endsWith(sep) ? PUBLIC_ROOT : PUBLIC_ROOT + sep;

/** Explicit MIME map - an extension outside the map is a 404, never guessed. */
const MIME_TYPES = Object.freeze({
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  woff2: "font/woff2",
  mp4: "video/mp4",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  // feature 10 vendored VAD assets: silero-vad.onnx model + onnxruntime wasm
  // (deviation noted in worklog Task 11-a: onnx/wasm are absent from the
  // locked MIME descriptions, added here to serve public/vendor/vad-web/).
  onnx: "application/octet-stream",
  wasm: "application/wasm",
});

/** Plain (non-API) text response with the security headers. */
function plainResponse(status, text, extraHeaders) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function plain404() {
  return plainResponse(404, "Not found");
}

/**
 * Serve one static file from public/. Path traversal is structurally
 * impossible: the request path is decoded, normalized, and rejected unless
 * the resolved absolute path stays inside PUBLIC_ROOT. No directory listing
 * (extension-less paths are 404) and no extension guessing.
 * @param {string} pathname decoded-safe request pathname
 * @returns {Promise<Response>}
 */
async function serveStatic(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return plain404(); // malformed percent-encoding
  }
  if (decoded.includes("\0") || decoded.endsWith("/")) {
    return plain404(); // no directories, no listing
  }
  const resolved = resolve(join(PUBLIC_ROOT, decoded));
  if (!resolved.startsWith(ROOT_WITH_SEP)) {
    return plain404(); // traversal attempt
  }
  const ext = extname(resolved).slice(1).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) return plain404(); // unknown extension -> not served

  const file = Bun.file(resolved);
  if (!(await file.exists())) return plain404();
  return new Response(file, {
    headers: { "content-type": mime, ...SECURITY_HEADERS },
  });
}

// --- server ----------------------------------------------------------------
const server = Bun.serve({
  // Task 22: deploy platforms inject PORT; the sandbox default stays 3000.
  port: Number(Bun.env.PORT ?? 3000),

  /**
   * Fetch handler: (1) /api/* dispatch through the envelope route wrapper -
   * an EXACT path+method table plus the small parametrized /api/calls
   * matcher (the only param routes); (2) static files from public/;
   * unknown static -> plain 404, unknown /api -> the 404 error envelope,
   * known /api path with a wrong method -> the 405 error envelope.
   * @param {Request} req
   * @returns {Promise<Response>}
   */
  async fetch(req) {
    try {
      const url = new URL(req.url);

      // feature 25 (Task 19-a): the server-to-server voice-config feed
      // answers BEFORE /api dispatch and BEFORE static serving. The
      // handler owns GET-only + the constant-time token compare (both
      // failures are the same bare 403), and the gateway blocks
      // /internal/* at the edge (Caddyfile) before this point.
      if (url.pathname === "/internal/voice-config") {
        return await internalVoiceConfigRoute(req);
      }

      if (url.pathname.startsWith("/api/")) {
        const exact = API_ROUTES.filter((row) => row.path === url.pathname);
        if (exact.length > 0) {
          const route = exact.find((row) => row.method === req.method);
          if (!route) return methodNotAllowedEnvelope();
          return await route.handler(req, server);
        }
        const param = matchParamRoute(url.pathname, req.method);
        if (param === null) return apiNotFoundEnvelope();
        if (param.notAllowed) return methodNotAllowedEnvelope();
        return await param.handler(req, server, {
          submissionId: param.submissionId,
        });
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return plainResponse(405, "Method not allowed", { Allow: "GET, HEAD" });
      }
      const staticPath = url.pathname === "/" ? "/index.html" : url.pathname;
      return await serveStatic(staticPath);
    } catch (e) {
      // last-resort edge: log + reference ID; envelope for /api, plain 500
      // for static so a storage hiccup never leaks internals either way.
      const url = new URL(req.url);
      const isApi = url.pathname.startsWith("/api/");
      if (isApi) return errorResponse(e, "router");
      const refId =
        e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
      log("static", `static_serve_failed ${refId}`);
      return plainResponse(500, "Something went wrong.");
    }
  },

  /**
   * Bun-level error hook (safety net; fetch already catches everything).
   * @param {Error} error
   * @param {Request} req
   * @returns {Response}
   */
  error(error, req) {
    let isApi = false;
    try {
      isApi = new URL(req.url).pathname.startsWith("/api/");
    } catch {
      isApi = false;
    }
    log("server", `uncaught_error ${error instanceof Error ? error.name : "unknown"}`);
    if (isApi) {
      return errorResponse(error, "server");
    }
    return plainResponse(500, "Something went wrong.");
  },
});

log("server", `listening on :${server.port} v${config.appVersion}`, {
  env: envCompleteness,
});
