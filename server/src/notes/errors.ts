import type { ErrorCode } from "../shared/error-codes.js";

/** A note request that cannot be served. errors.ts maps each code to its HTTP status, as it does for AiError. */
export class NoteError extends Error {
  constructor(
    readonly code: Extract<ErrorCode, "not_found" | "note_too_short">,
    message: string,
  ) {
    super(message);
    this.name = "NoteError";
  }
}

export const noteNotFound = () => new NoteError("not_found", "Note not found.");
