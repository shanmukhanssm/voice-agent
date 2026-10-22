/**
 * summary.js - POST /api/calls/:submissionId/summary (feature 19; hardening
 * H-G1/G3/G4, library-docs Pattern P4).
 *
 * Flow: call must exist (404) -> idempotent short-circuit (status completed
 * AND a stored summary -> the stored fields, no LLM spend, H-B7) -> zero
 * user turns -> deterministic honest "No Response" summary persisted WITHOUT
 * any provider call -> otherwise AI quota counted BEFORE provider spend
 * (H-G3) -> Xkiro flash -> strict JSON validation (H-G1, one retry) -> ONE
 * Prisma write persists summary/requirements/objections/nextSteps/salesStatus
 * + status "completed" + endedAt + durationSec + providerChain. A failure
 * leaves the call untouched (salesStatus stays null -> retryable).
 */
import { db } from "../lib/db.js";
import { log, newReferenceId } from "../lib/log.js";
import { respond, withRoute } from "../lib/envelope.js";
import { AppError, NotFound } from "../lib/errors.js";
import { quotaGuard } from "../lib/quota.js";
import { SUMMARY_REQUEST_SCHEMA } from "../lib/validation.js";
import { summarizeTranscript } from "../lib/summary-llm.js";

/**
 * Deterministic no-conversation outcome (H-G1: never invent a conversation
 * that did not happen - if no user speech was captured the summary says so).
 */
const NO_RESPONSE_SUMMARY = Object.freeze({
  summary: "The customer did not respond during this call - no speech was captured.",
  requirements: "None captured.",
  objections: "None captured.",
  nextSteps: "Retry the call at a later time.",
  salesStatus: "No Response",
});

/** The one summary DTO shape returned by every success path. */
function summaryDto(call) {
  return {
    summary: call.summary,
    requirements: call.requirements,
    objections: call.objections,
    nextSteps: call.nextSteps,
    salesStatus: call.salesStatus,
  };
}

/**
 * POST /api/calls/:submissionId/summary - body { durationSec } (default 0).
 */
async function summaryHandler({ body, params, ip }) {
  const call = await db.call.findUnique({
    where: { submissionId: params.submissionId },
  });
  if (!call) throw new NotFound();

  // H-B7 idempotency: a completed call with a stored summary replays the
  // stored fields - the LLM is never re-run for the same outcome.
  if (call.status === "completed" && typeof call.summary === "string" && call.summary.length > 0) {
    log("calls-summary", "summary_idempotent_replay", { status: call.status });
    return respond({ status: 200, data: summaryDto(call) });
  }

  const turns = await db.turn.findMany({
    where: { callId: call.id },
    orderBy: { idx: "asc" },
    select: { role: true, text: true },
  });

  if (!turns.some((turn) => turn.role === "user")) {
    // Zero turns or zero user turns: skip the LLM entirely, persist the
    // honest deterministic summary. providerChain stays null (no provider).
    const endedAt = new Date();
    await db.call.update({
      where: { id: call.id },
      data: {
        ...NO_RESPONSE_SUMMARY,
        status: "completed",
        endedAt,
        durationSec: body.durationSec,
      },
    });
    log("calls-summary", "summary_no_user_turns_deterministic", {
      turns: turns.length,
    });
    return respond({ status: 200, data: { ...NO_RESPONSE_SUMMARY } });
  }

  // H-G3: the AI quota is counted BEFORE any provider spend (shared
  // "ai-turn" 60/hour/IP bucket - single-source counting per quota.js).
  await quotaGuard(ip);

  const result = await summarizeTranscript(turns);
  if (!result.ok) {
    // Honest failure per library-docs P4: fixed taxonomy copy, internals and
    // provider payloads never surface; the reference id lives in the log.
    const refId = newReferenceId();
    log("calls-summary", `summary_failed ref=${refId}`, { attempts: result.attempts });
    throw new AppError(502, "DependencyDown", "Summary failed.");
  }

  const endedAt = new Date();
  await db.call.update({
    where: { id: call.id },
    data: {
      ...result.fields,
      status: "completed",
      endedAt,
      durationSec: body.durationSec,
      providerChain: result.provider,
    },
  });
  log("calls-summary", "summary_persisted", { attempts: result.attempts });
  return respond({ status: 200, data: summaryDtoFromFields(result.fields) });
}

/** Same DTO shape for freshly validated LLM fields. */
function summaryDtoFromFields(fields) {
  return {
    summary: fields.summary,
    requirements: fields.requirements,
    objections: fields.objections,
    nextSteps: fields.nextSteps,
    salesStatus: fields.salesStatus,
  };
}

export const summaryRoute = withRoute({
  route: "calls-summary",
  tier: "write",
  schema: SUMMARY_REQUEST_SCHEMA,
  handler: summaryHandler,
});
