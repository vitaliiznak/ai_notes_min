import {
  charLength,
  normalizeUserText,
  type AiField,
  type AiPreview,
  type Note,
  type NoteListItem,
} from "../../server/src/notes/limits";

export {
  canSummarize,
  charLength as noteLength,
  CONTENT_MAX,
  normalizeUserText,
  SUMMARY_MIN_CONTENT,
  TITLE_MAX,
  type AiField,
  type AiPreview,
  type Note,
  type NoteListItem,
} from "../../server/src/notes/limits";

export function clampText(value: string, max: number): string {
  const stored = normalizeUserText(value);
  if (charLength(stored) <= max) return value;
  return [...stored].slice(0, max).join("");
}

/** Identity of a create: the title and content the server will store. */
export function storedNoteText(title: string, content: string): string {
  return JSON.stringify([normalizeUserText(title), normalizeUserText(content)]);
}

/** The key for this save. A retry of the same stored text keeps the key it already sent. */
export function saveAttemptKey(
  previous: { text: string; key: string } | null,
  title: string,
  content: string,
  mint: () => string,
): { text: string; key: string } {
  const text = storedNoteText(title, content);
  if (previous?.text === text) return { text, key: previous.key };
  return { text, key: mint() };
}

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
const AI_ERROR_MESSAGES: Record<string, string> = {
  ai_timeout: "The AI took too long to answer. Try again.",
  ai_rate_limited: "The AI is busy right now. Wait a moment, then try again.",
  ai_unavailable: "The AI service isn't responding. Try again in a moment.",
  ai_invalid_output: "The AI's answer couldn't be used. Try again.",
  ai_refused: "The AI declined to work on this note.",
};

function throwApi(status: number, body: unknown): never {
  const error = (body as ErrorBody | null)?.error;
  const code = error?.code ?? "unknown";
  const detail = error?.issues?.map((i) => i.message).join(" ");
  throw new ApiError(status, code, AI_ERROR_MESSAGES[code] ?? (detail || error?.message || `Request failed (${status}).`));
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`/api${path}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Can't reach the server. Check your connection and try again.");
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throwApi(res.status, body);
  return body as T;
}

async function request<T>(path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<T> {
  const headers = init.body ? { "content-type": "application/json", ...init.headers } : init.headers;
  return readJson<T>(await send(path, { ...init, headers }));
}

function parseSse(chunk: string, onEvent: (event: string, data: unknown) => void): string {
  const normalised = chunk.replace(/\r\n/g, "\n");
  let rest = normalised;
  let split = rest.indexOf("\n\n");
  while (split !== -1) {
    const block = rest.slice(0, split);
    rest = rest.slice(split + 2);
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) onEvent(event, JSON.parse(data.join("\n")));
    split = rest.indexOf("\n\n");
  }
  return rest;
}

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
      headers: { "idempotency-key": idempotencyKey },
    }).then((r) => r.note),
  generate: async (
    id: string,
    field: AiField,
    regenerate: boolean,
    onPreview: (preview: AiPreview) => void,
    signal?: AbortSignal,
  ) => {
    const path = `/notes/${id}/${field}${regenerate ? "?regenerate=true" : ""}`;
    const res = await send(path, { method: "POST", headers: { accept: "text/event-stream" }, signal });
    // A failure before any text keeps its HTTP status and arrives as plain JSON.
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return (await readJson<{ note: Note }>(res)).note;
    if (!res.body) throw new ApiError(res.status, "unknown", "The AI response was empty.");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let note: Note | null = null;
    const onEvent = (event: string, data: unknown) => {
      if (event === "preview") onPreview(data as AiPreview);
      else if (event === "done") note = (data as { note: Note }).note;
      else if (event === "error") throwApi(res.status, data);
    };
    while (true) {
      const chunk = await reader.read();
      const text = chunk.value ? decoder.decode(chunk.value, { stream: !chunk.done }) : "";
      buffer = parseSse(buffer + text, onEvent);
      if (chunk.done) break;
    }
    parseSse(`${buffer}\n\n`, onEvent);
    if (!note) throw new ApiError(res.status, "unknown", "The AI response ended before a result.");
    return note;
  },
};

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");
