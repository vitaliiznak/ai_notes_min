import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AiError, type AiErrorCode } from "./ai/provider.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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

interface ErrorBody {
  error: { code: string; message: string; issues?: { path: string; message: string }[] };
}

// Every error response has the shape { error: { code, message, issues? } }.
export function errorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return { status: 400, body: { error: { code: "validation_failed", message: "The request body is invalid.", issues } } };
  }
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof AiError) {
    return { status: AI_ERROR_STATUS[err.code], body: { error: { code: `ai_${err.code}`, message: err.message } } };
  }
  // express.json() errors carry an HTTP status and a type.
  if (isEntityError(err, "entity.parse.failed")) {
    return { status: 400, body: { error: { code: "invalid_json", message: "The request body is not valid JSON." } } };
  }
  if (isEntityError(err, "entity.too.large")) {
    return { status: 413, body: { error: { code: "payload_too_large", message: "The request body is too large." } } };
  }
  return { status: 500, body: { error: { code: "internal_error", message: "Something went wrong." } } };
}

// Expected errors already say what went wrong in their response. Only AI failures and unknown errors are logged.
export function logServerError(err: unknown) {
  if (err instanceof AiError) console.warn(`AI request failed: ${err.code}: ${err.message}`, err.cause ?? "");
  else if (errorResponse(err).body.error.code === "internal_error") console.error(err);
}

function isEntityError(err: unknown, type: string): boolean {
  return typeof err === "object" && err !== null && "type" in err && err.type === type;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logServerError(err);
  const { status, body } = errorResponse(err);
  res.status(status).json(body);
};
