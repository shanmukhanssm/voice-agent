/**
 * calls.js - call persistence REST routes (feature 17, hardening.md ss
 * Trust-Boundary Map rows 2/3/4/8 + feature 23 row for DELETE).
 *
 * All handlers go through the ONE envelope (withRoute -> respond) and keep
 * the hardening order validate -> rate-limit -> persist. DTOs are explicit
 * allowlists (H-C4): the cuid id, providerChain, recordingUrl paths and any
 * error internals are NEVER returned. Idempotency (H-B7): POST /api/calls on
 * a UNIQUE(submissionId) conflict returns the ORIGINAL row with 201; an
 * identical turn re-relay on UNIQUE(callId, idx) returns 201.
 *
 * Deviations from build-plan feature 17 (locked by the task brief): no
 * honeypot/time-trap/origin checks - there is NO HTML form in this app (the
 * body is relayed by client JS), so H-C8 has no surface here; body is
 * strictly { submissionId, consent }.
 */
import { db } from "../lib/db.js";
import { log } from "../lib/log.js";
import { respond, withRoute } from "../lib/envelope.js";
import { NotFound, Conflict, ValidationError } from "../lib/errors.js";
import { CALL_CREATE_SCHEMA, TURN_SCHEMA } from "../lib/validation.js";
import { MAX_TURN_BODY_BYTES } from "../lib/constants.js";

/**
 * Prisma unique-violation probe. The error carries code "P2002", but an
 * instanceof check against PrismaClientKnownRequestError is unreliable under
 * Bun (two runtime copies -> failed instanceof), so the code is matched
 * structurally (dev.log Task 18-b: the 500-vs-201 idempotency catch).
 * @param {unknown} e thrown value
 * @returns {boolean}
 */
function isUniqueConstraintError(e) {
  return e instanceof Error && /** @type {{ code?: string }} */ (e).code === "P2002";
}

/** History-list DTO (H-C4 allowlist; recording surfaces as a boolean only). */
function callListDto(call) {
  return {
    submissionId: call.submissionId,
    status: call.status,
    salesStatus: call.salesStatus,
    durationSec: call.durationSec,
    turnCount: call.turnCount,
    createdAt: call.createdAt,
    hasRecording:
      typeof call.recordingUrl === "string" && call.recordingUrl.length > 0,
  };
}

/** Detail DTO (H-C4 allowlist - no id, no providerChain, no recordingUrl). */
function callDetailDto(call) {
  return {
    submissionId: call.submissionId,
    status: call.status,
    salesStatus: call.salesStatus,
    durationSec: call.durationSec,
    turnCount: call.turnCount,
    consent: call.consent,
    createdAt: call.createdAt,
    endedAt: call.endedAt,
    summary: call.summary,
    requirements: call.requirements,
    objections: call.objections,
    nextSteps: call.nextSteps,
    hasRecording:
      typeof call.recordingUrl === "string" && call.recordingUrl.length > 0,
  };
}

/**
 * POST /api/calls - open a Call row (status "in_progress", consent true).
 * UNIQUE(submissionId) conflict -> the ORIGINAL row, still 201 (H-B7:
 * duplicate relay is not an error; the row is the outcome).
 */
async function createCallHandler({ body }) {
  try {
    const call = await db.call.create({
      data: {
        submissionId: body.submissionId,
        consent: body.consent,
        status: "in_progress",
      },
    });
    return respond({ status: 201, data: callListDto(call) });
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      const existing = await db.call.findUnique({
        where: { submissionId: body.submissionId },
      });
      if (existing) {
        log("calls-create", "duplicate_submission_id_idempotent_201");
        return respond({ status: 201, data: callListDto(existing) });
      }
    }
    throw e;
  }
}

/** GET /api/calls?limit=50 - history DTO list, newest first (H-B3 index). */
async function listCallsHandler({ req }) {
  const raw = new URL(req.url).searchParams.get("limit");
  let limit = 50;
  if (raw !== null) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new ValidationError(undefined, {
        limit: "limit must be an integer between 1 and 100.",
      });
    }
    limit = parsed;
  }
  const calls = await db.call.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      submissionId: true,
      status: true,
      salesStatus: true,
      durationSec: true,
      turnCount: true,
      createdAt: true,
      recordingUrl: true, // only ever surfaced as the hasRecording boolean
    },
  });
  return respond({ status: 200, data: calls.map(callListDto) });
}

/**
 * GET /api/calls/:submissionId - detail + turns ascending by idx.
 * Unknown submissionId -> 404 envelope.
 */
async function getCallHandler({ params }) {
  const call = await db.call.findUnique({
    where: { submissionId: params.submissionId },
    include: {
      turns: {
        orderBy: { idx: "asc" },
        select: { idx: true, role: true, text: true, createdAt: true },
      },
    },
  });
  if (!call) throw new NotFound();
  const turns = call.turns.map((turn) => ({
    idx: turn.idx,
    role: turn.role,
    text: turn.text,
    createdAt: turn.createdAt,
  }));
  return respond({ status: 200, data: { call: callDetailDto(call), turns } });
}

/**
 * POST /api/calls/:submissionId/turns - relay one socket turn:final into the
 * transcript. Turn create + turnCount refresh happen in ONE transaction so
 * Call.turnCount is always the exact turn count. UNIQUE(callId, idx) with an
 * identical payload -> idempotent 201 (H-B7); different content at the same
 * idx -> honest 409.
 */
async function addTurnHandler({ body, params }) {
  const call = await db.call.findUnique({
    where: { submissionId: params.submissionId },
    select: { id: true },
  });
  if (!call) throw new NotFound();

  const turnData = { callId: call.id, idx: body.idx, role: body.role, text: body.text };
  try {
    await db.$transaction(async (tx) => {
      await tx.turn.create({ data: turnData });
      const turnCount = await tx.turn.count({ where: { callId: call.id } });
      await tx.call.update({ where: { id: call.id }, data: { turnCount } });
    });
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      const existing = await db.turn.findUnique({
        where: { callId_idx: { callId: call.id, idx: body.idx } },
      });
      if (existing && existing.role === body.role && existing.text === body.text) {
        log("calls-turn", "duplicate_turn_idx_idempotent_201", { idx: body.idx });
      } else {
        throw new Conflict("That turn index already holds different content.");
      }
    } else {
      throw e;
    }
  }
  return respond({
    status: 201,
    data: { idx: body.idx, role: body.role, text: body.text },
  });
}

/**
 * DELETE /api/calls/:submissionId - remove the Call row; turns cascade via
 * the schema relation (onDelete: Cascade, H-B2). Unknown -> 404 envelope.
 * (The recording-file unlink joins this route when feature 18/23 land.)
 */
async function deleteCallHandler({ params }) {
  const call = await db.call.findUnique({
    where: { submissionId: params.submissionId },
    select: { id: true },
  });
  if (!call) throw new NotFound();
  await db.call.delete({ where: { id: call.id } });
  return respond({ status: 200, data: { ok: true } });
}

export const createCallRoute = withRoute({
  route: "calls-create",
  tier: "write",
  schema: CALL_CREATE_SCHEMA,
  handler: createCallHandler,
});

export const listCallsRoute = withRoute({
  route: "calls-list",
  tier: "read",
  handler: listCallsHandler,
});

export const getCallRoute = withRoute({
  route: "calls-detail",
  tier: "read",
  handler: getCallHandler,
});

export const addTurnRoute = withRoute({
  route: "calls-turn",
  tier: "turns",
  capBytes: MAX_TURN_BODY_BYTES,
  schema: TURN_SCHEMA,
  handler: addTurnHandler,
});

export const deleteCallRoute = withRoute({
  route: "calls-delete",
  tier: "write",
  handler: deleteCallHandler,
});
