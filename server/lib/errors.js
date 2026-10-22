/**
 * errors.js - AppError + the six typed error classes (hardening.md
 * ss Error Taxonomy, H-E8). Names, statuses and user-facing copy are the
 * taxonomy's fixed sentences - never invented, never raw provider errors.
 *
 * The route edge (server/lib/envelope.js) is mechanical: AppError -> its
 * status + userMessage; anything else -> log with a reference ID + a
 * generic 500 carrying that ID. Socket errors reuse these classes as
 * call:error { code, userMessage }.
 */

/**
 * Base typed error. Everything thrown on purpose is one of the six classes.
 * @typedef {object} AppErrorInit
 * @property {Record<string, string>} [headers] extra response headers
 *   (e.g. Retry-After on 429)
 * @property {Record<string, string>} [fieldErrors] per-field detail for 400s
 */
export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code stable machine code (class name)
   * @param {string} userMessage the taxonomy's fixed user-facing sentence
   * @param {AppErrorInit} [init] optional headers / fieldErrors
   */
  constructor(status, code, userMessage, init) {
    super(userMessage);
    this.name = code;
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
    this.headers = init?.headers;
    this.fieldErrors = init?.fieldErrors;
  }
}

/** 400 - "That request didn't look right." (+ field detail when a form exists). */
export class ValidationError extends AppError {
  constructor(userMessage, fieldErrors) {
    super(
      400,
      "ValidationError",
      userMessage ?? "That request didn't look right.",
      { fieldErrors },
    );
  }
}

/**
 * 401 - reserved class; no auth exists in V1 (hardening.md ss Auth & Session).
 * No throw sites in V1; the default copy reuses the taxonomy's safe sentence.
 */
export class AuthError extends AppError {
  constructor(userMessage) {
    super(401, "AuthError", userMessage ?? "That request didn't look right.");
  }
}

/** 404 - "We couldn't find that call." */
export class NotFound extends AppError {
  constructor(userMessage) {
    super(404, "NotFound", userMessage ?? "We couldn't find that call.");
  }
}

/** 409 - "This call was already saved." */
export class Conflict extends AppError {
  constructor(userMessage) {
    super(409, "Conflict", userMessage ?? "This call was already saved.");
  }
}

/**
 * 429 - "Too many tries - wait {Retry-After}s." (taxonomy) with the
 * Pattern-P2 quota variant "Too many tries - wait a moment." as default.
 * Callers that know the window pass the computed seconds.
 */
export class RateLimited extends AppError {
  /**
   * @param {number} [retryAfterSeconds] seconds until the window resets;
   *   when provided the response carries a Retry-After header
   */
  constructor(retryAfterSeconds) {
    const message =
      typeof retryAfterSeconds === "number"
        ? `Too many tries - wait ${retryAfterSeconds}s.`
        : "Too many tries - wait a moment.";
    super(429, "RateLimited", message, {
      headers:
        typeof retryAfterSeconds === "number"
          ? { "Retry-After": String(retryAfterSeconds) }
          : undefined,
    });
  }
}

/**
 * 503 - default copy "Voice service temporarily unavailable." (provider
 * chains). The health DB probe passes "Service temporarily unavailable."
 * (fallback-table copy for SQLite) so the page never blames the voice
 * service for a storage outage.
 */
export class DependencyDown extends AppError {
  constructor(userMessage) {
    super(
      503,
      "DependencyDown",
      userMessage ?? "Voice service temporarily unavailable.",
    );
  }
}
