/**
 * recording.js - call recording upload + playback (feature 21 quick path).
 *
 * POST /api/calls/:submissionId/recording  raw audio/webm body -> saved under
 * db/recordings/<cuid>.webm, the Call row gets recordingUrl (filename ONLY)
 * + recordingBytes. GET serves the file back.
 *
 * Safety: the filename is never taken from the request - it is generated
 * server-side from the Prisma cuid, so path traversal is structurally
 * impossible. Errors use the ONE envelope; the file response is raw bytes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../lib/db.js";
import { log } from "../lib/log.js";
import { respond, SECURITY_HEADERS } from "../lib/envelope.js";
import { NotFound, ValidationError } from "../lib/errors.js";
import { RECORDING_MAX_BYTES } from "../lib/constants.js";

const RECORDINGS_ROOT = fileURLToPath(new URL("../../db/recordings/", import.meta.url));
const ROOT_WITH_SEP = RECORDINGS_ROOT.endsWith(sep) ? RECORDINGS_ROOT : RECORDINGS_ROOT + sep;

/** Tiny per-IP upload throttle (hardening order kept honest without withRoute). */
const uploads = new Map(); // ip -> { n, resetAt }
const UPLOAD_WINDOW_MS = 60_000;
const UPLOAD_MAX_PER_WINDOW = 6;

/**
 * @param {Request} req
 * @returns {boolean} true when this IP is over the upload budget
 */
function overUploadBudget(req) {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const now = Date.now();
  const entry = uploads.get(ip);
  if (!entry || entry.resetAt < now) {
    uploads.set(ip, { n: 1, resetAt: now + UPLOAD_WINDOW_MS });
    return false;
  }
  entry.n += 1;
  return entry.n > UPLOAD_MAX_PER_WINDOW;
}

/**
 * POST handler - raw binary upload (withRoute's JSON parser is bypassed).
 * @param {{ req: Request, server: unknown, submissionId: string }} parts
 */
export async function uploadRecordingHandler({ req, submissionId }) {
  if (overUploadBudget(req)) {
    return respond({
      status: 429,
      error: { code: "rate_limited", message: "Too many uploads. Try again shortly." },
    });
  }
  if (typeof submissionId !== "string" || submissionId.length === 0 || submissionId.length > 80) {
    throw new ValidationError();
  }
  const call = await db.call.findUnique({
    where: { submissionId },
    select: { id: true },
  });
  if (!call) throw new NotFound();

  const len = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(len) || len <= 0) {
    throw new ValidationError(undefined, { body: "Recording body is empty." });
  }
  if (len > RECORDING_MAX_BYTES) {
    throw new ValidationError(undefined, { body: "Recording exceeds the 20 MB cap." });
  }

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > RECORDING_MAX_BYTES) {
    throw new ValidationError(undefined, { body: "Recording size out of range." });
  }

  await mkdir(RECORDINGS_ROOT, { recursive: true });
  // Task 27: the client uploads a clean 16 kHz mono WAV (exact duration,
  // seekable, plays everywhere); webm stays accepted as the fallback.
  const isWav = (req.headers.get("content-type") ?? "").includes("wav");
  const filename = `${call.id}${isWav ? ".wav" : ".webm"}`;
  const target = resolve(join(RECORDINGS_ROOT, filename));
  if (!target.startsWith(ROOT_WITH_SEP)) throw new NotFound(); // structural guard
  await writeFile(target, buf);

  await db.call.update({
    where: { id: call.id },
    data: { recordingUrl: filename, recordingBytes: buf.byteLength },
  });
  log("recording-upload", "saved", { bytes: buf.byteLength });
  return respond({ status: 201, data: { ok: true, bytes: buf.byteLength } });
}

/**
 * GET handler - stream the stored recording back.
 * @param {{ submissionId: string }} parts
 */
export async function getRecordingHandler({ submissionId }) {
  if (typeof submissionId !== "string" || submissionId.length === 0 || submissionId.length > 80) {
    throw new ValidationError();
  }
  const call = await db.call.findUnique({
    where: { submissionId },
    select: { recordingUrl: true },
  });
  if (!call || typeof call.recordingUrl !== "string" || call.recordingUrl.length === 0) {
    throw new NotFound();
  }
  // The stored name is server-generated (cuid + .wav/.webm); re-verify the
  // shape so even a hand-edited DB row cannot escape the recordings dir.
  if (!/^[A-Za-z0-9_-]+\.webm$/.test(call.recordingUrl) && !/^[A-Za-z0-9_-]+\.wav$/.test(call.recordingUrl)) {
    throw new NotFound();
  }
  const target = resolve(join(RECORDINGS_ROOT, call.recordingUrl));
  if (!target.startsWith(ROOT_WITH_SEP)) throw new NotFound();
  const file = Bun.file(target);
  if (!(await file.exists())) throw new NotFound();
  const isWavFile = call.recordingUrl.endsWith(".wav");
  return new Response(file, {
    headers: {
      "content-type": isWavFile ? "audio/wav" : "audio/webm",
      "accept-ranges": "none",
      "cache-control": "private, max-age=60",
      ...SECURITY_HEADERS,
    },
  });
}

/** Dispatch adapters - Bun passes (req, server, { submissionId }). */
export const uploadRecordingRoute = (req, _server, parts) =>
  uploadRecordingHandler({ req, submissionId: parts.submissionId });
export const getRecordingRoute = (_req, _server, parts) =>
  getRecordingHandler({ submissionId: parts.submissionId });
