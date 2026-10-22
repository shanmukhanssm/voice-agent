/**
 * envelope.js - the ONE response envelope + the route wrapper.
 *
 * Shape (code-standards.md ss Error Handling, hardening H-C3):
 *   success -> { ok: true, data }
 *   failure -> { ok: false, error: { code, message }, fieldErrors? }
 * (The /api/health 503 also carries data: { db: "down" } per hardening E7.)
 *
 * Route wrapper order per hardening.md ss Trust-Boundary Map
 *   ("validate -> authorize -> rate-limit -> persist"):
 *   zod parse (when a schema is given) -> rate-limit -> handler -> AppError
 *   mapping. Unknown errors -> log with a reference ID -> generic 500 carrying
 *   that ID.
 */
import { z } from "zod";
import { AppError } from "./errors.js";
import { log, newReferenceId } from "./log.js";
import { enforceRateLimit } from "./rate-limit.js";
import { MAX_BODY_BYTES } from "./constants.js";

/** Security headers applied to EVERY response (API + static). */
export const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
});

/**
 * Build the one envelope as a Response. Every /api response goes through it.
 * @param {object} parts
 * @param {number} [parts.status] HTTP status (default 200)
 * @param {unknown} [parts.data] payload on success (or db-status on 503)
 * @param {{ code: string, message: string }} [parts.error] typed error block
 * @param {Record<string, string>} [parts.fieldErrors] per-field detail
 * @param {Record<string, string>} [parts.headers] extra response headers
 * @returns {Response}
 */
export function respond({ status = 200, data, error, fieldErrors, headers }) {
  let body;
  if (error) {
    body = { ok: false, error };
    if (fieldErrors !== undefined) body.fieldErrors = fieldErrors;
    if (data !== undefined) body.data = data;
  } else {
    body = { ok: true, data };
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

/**
 * Read a JSON body with a running byte counter; reject over the cap BEFORE
 * JSON.parse (library-docs.md ss Bun.serve). Over cap -> 413, malformed
 * JSON -> 400 - both in the ONE envelope. An ABSENT or zero-byte body is an
 * empty object, NOT an error: the route schema then decides (required fields
 * -> 400 fieldErrors; defaulted fields -> defaults). Feature 17/19 rely on
 * the empty-body default (POST summary without a body -> durationSec 0).
 * @param {Request} req
 * @param {number} [capBytes] defaults to MAX_BODY_BYTES
 * @returns {Promise<unknown>} parsed JSON
 */
export async function readJson(req, capBytes = MAX_BODY_BYTES) {
  const reader = req.body?.getReader();
  if (!reader) {
    return {}; // no body at all - the schema decides what is required
  }
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > capBytes) {
      try {
        await reader.cancel();
      } catch {
        // body stream already gone - nothing to clean up
      }
      throw new AppError(413, "PayloadTooLarge", "That request didn't look right.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (text.trim() === "") {
    return {}; // zero-byte body - same contract as an absent body
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "ValidationError", "That request didn't look right.");
  }
}

/**
 * Extract the caller IP: the gateway-set header value (last entry of
 * x-forwarded-for = the hop our own gateway appended), falling back to the
 * socket address. The value is only ever used as HMAC key material or in a
 * comparison - it is never logged raw (H-C7).
 * @param {Request} req
 * @param {unknown} [server] Bun server handle (for requestIP)
 * @returns {string}
 */
export function clientIp(req, server) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  try {
    const ip = server?.requestIP?.(req);
    if (ip && typeof ip.address === "string" && ip.address.length > 0) {
      return ip.address;
    }
  } catch {
    // non-TCP or already-consumed request - fall through to "unknown"
  }
  return "unknown";
}

/**
 * Map a thrown value to the ONE envelope. AppError -> status + fixed copy;
 * zod error -> 400 + fieldErrors; anything else -> log with reference ID +
 * generic 500 (never leak internals).
 * @param {unknown} e thrown value
 * @param {string} route route tag for the log line
 * @returns {Response}
 */
export function errorResponse(e, route) {
  if (e instanceof AppError) {
    return respond({
      status: e.status,
      error: { code: e.code, message: e.userMessage },
      fieldErrors: e.fieldErrors,
      headers: e.headers,
    });
  }
  if (e instanceof z.ZodError) {
    return respond({
      status: 400,
      error: { code: "ValidationError", message: "That request didn't look right." },
      fieldErrors: fieldErrorsFromZod(e),
    });
  }
  const refId = newReferenceId();
  log(route, `unhandled_error ref=${refId}`, {
    name: e instanceof Error ? e.name : typeof e,
    message: e instanceof Error ? e.message : String(e),
  });
  return respond({
    status: 500,
    error: {
      code: "InternalError",
      message: `Something went wrong - Reference ${refId}.`,
    },
  });
}

/** Flatten zod issues into { "path.to.field": "message" }. */
function fieldErrorsFromZod(e) {
  const out = {};
  for (const issue of e.issues) {
    const field = issue.path.length > 0 ? issue.path.join(".") : "_";
    if (!(field in out)) out[field] = issue.message;
  }
  return out;
}

/**
 * Wrap a route handler with the mechanical edge: zod parse (when a schema is
 * given) -> rate limit by tier -> handler -> AppError mapping (hardening.md
 * door order: validate -> authorize -> rate-limit -> persist). Handlers
 * return a Response (envelope) or a plain value (wrapped as { ok, data }).
 * @param {object} spec
 * @param {string} spec.route route tag (log + limiter)
 * @param {"read" | "write" | "turns" | "upload"} [spec.tier] rate-limit tier;
 *   omit on AI routes - they call quotaGuard() directly before provider spend
 * @param {z.ZodTypeAny} [spec.schema] strict-boundary schema for JSON bodies
 * @param {number} [spec.capBytes] body byte cap override (feature 17 turns
 *   relay uses MAX_TURN_BODY_BYTES = 8 KB; default is MAX_BODY_BYTES)
 * @param {(ctx: { req: Request, server: unknown, ip: string, body: unknown, params?: unknown }) => Promise<Response | unknown>} spec.handler
 * @returns {(req: Request, server?: unknown, params?: unknown) => Promise<Response>}
 */
export function withRoute({ route, tier, schema, capBytes, handler }) {
  return async function routeHandler(req, server, params) {
    try {
      const ip = clientIp(req, server);
      let body;
      if (schema) {
        const raw = await readJson(req, capBytes);
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw parsed.error;
        body = parsed.data;
      }
      if (tier) {
        await enforceRateLimit({ ip, route, tier });
      }
      const out = await handler({ req, server, ip, body, params });
      if (out instanceof Response) return out;
      return respond({ status: 200, data: out });
    } catch (e) {
      return errorResponse(e, route);
    }
  };
}

/** Unknown /api path -> the 404 error envelope (taxonomy NotFound copy). */
export function apiNotFoundEnvelope() {
  return respond({
    status: 404,
    error: { code: "NotFound", message: "We couldn't find that call." },
  });
}

/** Known /api path, wrong method -> 405 error envelope (H-C5). */
export function methodNotAllowedEnvelope() {
  return respond({
    status: 405,
    error: { code: "MethodNotAllowed", message: "Method not allowed." },
  });
}
