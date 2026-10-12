import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AiError } from "./ai/provider.js";
import { NoteError } from "./notes/errors.js";
import type { AiErrorCode, ErrorCode } from "./shared/error-codes.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

const AI_ERROR_STATUS: Record<AiErrorCode, number> = {
  timeout: 504,
  rate_limited: 503,
  unavailable: 502,
  invalid_output: 502,
  refused: 422,
};

const NOTE_ERROR_STATUS: Record<NoteError["code"], number> = {
  not_found: 404,
  note_too_short: 422,
};

// Every error response has the shape { error: { code, message, issues? } }.
const toResponse = (status: number, code: ErrorCode, message: string, issues?: HttpError["issues"]) => ({
  status,
  body: { error: { code, message, issues } },
});

/** The response for an error this API expects. Undefined for anything else, which is a bug. */
function expectedErrorResponse(err: unknown) {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return toResponse(400, "validation_failed", "The request body is invalid.", issues);
  }
  if (err instanceof HttpError) return toResponse(err.status, err.code, err.message, err.issues);
  if (err instanceof NoteError) return toResponse(NOTE_ERROR_STATUS[err.code], err.code, err.message);
  if (err instanceof AiError) return toResponse(AI_ERROR_STATUS[err.code], `ai_${err.code}`, err.message);
  // express.json() errors carry an HTTP status and a type.
  if (isEntityError(err, "entity.parse.failed")) return toResponse(400, "invalid_json", "The request body is not valid JSON.");
  if (isEntityError(err, "entity.too.large")) return toResponse(413, "payload_too_large", "The request body is too large.");
  return undefined;
}

export function errorResponse(err: unknown) {
  return expectedErrorResponse(err) ?? toResponse(500, "internal_error", "Something went wrong.");
}

// Expected errors already say what went wrong in their response. Only AI failures and unexpected errors are logged.
export function logServerError(err: unknown) {
  if (err instanceof AiError) console.warn(`AI request failed: ${err.code}: ${err.message}`, err.cause ?? "");
  else if (!expectedErrorResponse(err)) console.error(err);
}

function isEntityError(err: unknown, type: string): boolean {
  return typeof err === "object" && err !== null && "type" in err && err.type === type;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logServerError(err);
  const { status, body } = errorResponse(err);
  res.status(status).json(body);
};
