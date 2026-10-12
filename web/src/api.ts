import { EventSourceParserStream } from "eventsource-parser/stream";
import type { AiErrorCode, AiField, AiPreview, AiResult, Note, NoteListItem } from "./shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; issues?: { path: string; message: string }[] };
}

// The server's AI error messages are written for logs. These tell the person what to do.
// Keyed by every AI error code, so a new code fails the typecheck until it has a message here.
const AI_ERROR_MESSAGES: Record<`ai_${AiErrorCode}`, string> = {
  ai_timeout: "The AI took too long to answer. Try again.",
  ai_rate_limited: "The AI is busy right now. Wait a moment, then try again.",
  ai_unavailable: "The AI service isn't responding. Try again in a moment.",
  ai_invalid_output: "The AI's answer couldn't be used. Try again.",
  ai_refused: "The AI declined to work on this note.",
};

function throwApiError(status: number, body: unknown): never {
  const error = (body as ErrorBody | null)?.error;
  const code = error?.code ?? "unknown";
  const detail = error?.issues?.map((i) => i.message).join(" ");
  const forPerson = (AI_ERROR_MESSAGES as Record<string, string>)[code];
  throw new ApiError(status, code, forPerson ?? (detail || error?.message || `Request failed (${status}).`));
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the server. Check your connection and try again.");
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throwApiError(res.status, body);
  return body as T;
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => readJson<T>(await send(path, init));

export const api = {
  deleteNote: (id: string) => request<{ deleted: number }>(`/notes/${id}`, { method: "DELETE" }),
  deleteAllNotes: () => request<{ deleted: number }>("/notes", { method: "DELETE" }),
  listNotes: () => request<{ notes: NoteListItem[] }>("/notes").then((r) => r.notes),
  getNote: (id: string) => request<{ note: Note }>(`/notes/${id}`).then((r) => r.note),
  /** A repeat with the same idempotency key returns the note the first request stored. */
  createNote: (input: { title: string; content: string }, idempotencyKey: string) =>
    request<{ note: Note }>("/notes", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    }).then((r) => r.note),
  /** Resolves to the field as stored: { summary } or { tags }. `onPreview` gets the field so far while the model writes it. */
  generate: async (
    id: string,
    field: AiField,
    { regenerate = false, onPreview = () => {} }: { regenerate?: boolean; onPreview?: (preview: AiPreview) => void } = {},
  ): Promise<AiResult> => {
    const path = `/notes/${id}/${field}${regenerate ? "?regenerate=true" : ""}`;
    const res = await send(path, { method: "POST", headers: { accept: "text/event-stream" } });
    // A failure before any text keeps its HTTP status and arrives as plain JSON.
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return readJson<AiResult>(res);
    if (!res.body) throw new ApiError(res.status, "unknown", "The AI response was empty.");
    const events = res.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
    // Any number of previews, then one done or one error.
    try {
      while (true) {
        const next = await events.read();
        if (next.done) throw new ApiError(res.status, "unknown", "The AI response ended before a result.");
        const { event, data } = next.value;
        if (event === "preview") onPreview(JSON.parse(data) as AiPreview);
        if (event === "error") throwApiError(res.status, JSON.parse(data));
        if (event === "done") return JSON.parse(data) as AiResult;
      }
    } finally {
      // Done or error ends the exchange. Let the connection go instead of waiting for the server to close it.
      void events.cancel().catch(() => {});
    }
  },
};

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");
