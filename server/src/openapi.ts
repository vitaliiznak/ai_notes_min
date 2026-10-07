import { z } from "zod";
import {
  CONTENT_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_CONTENT,
  TAG_MAX_LENGTH,
  TAGS_MAX,
  TAGS_MIN,
  TITLE_MAX,
} from "./notes/limits.js";

// CreateNoteInput trims inside a transform, which JSON Schema cannot represent.
// These limits are the same constants the parser and the CHECK constraints use.
const registry = z.registry<{ id?: string; description?: string }>();

const Uuid = z.uuid();
const summary = z.string().min(1).max(SUMMARY_MAX_CHARS).nullable();
const tags = z.array(z.string().min(1).max(TAG_MAX_LENGTH)).min(TAGS_MIN).max(TAGS_MAX).nullable();

export const NoteSchema = z.object({
  id: Uuid,
  title: z.string().min(1).max(TITLE_MAX),
  content: z.string().min(1).max(CONTENT_MAX),
  summary,
  tags,
  createdAt: z.iso.datetime(),
});

const NoteListItem = NoteSchema.pick({ id: true, title: true, tags: true, createdAt: true });
const NoteBody = z.object({ note: NoteSchema });
const NoteList = z.object({ notes: z.array(NoteListItem) });
const CreateNote = z.object({
  title: z.string().min(1).max(TITLE_MAX),
  content: z.string().min(1).max(CONTENT_MAX),
});
const DeletedOne = z.object({ deleted: z.literal(1) });
const DeletedCount = z.object({ deleted: z.number().int().nonnegative() });
const Health = z.object({ status: z.literal("ok") });
const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
const SummaryPreview = z.object({ summary: z.string() });
const TagsPreview = z.object({ tags: z.array(z.string()) });

registry.add(Uuid, { id: "Uuid" });
registry.add(summary, {
  description: "Null until a summary is generated. A stored summary is at least 20% shorter than the note.",
});
registry.add(tags, { description: "Null until tags are generated." });
registry.add(NoteSchema, { id: "Note", description: "A stored note. Summary and tags stay null until generation finishes." });
registry.add(NoteListItem, { id: "NoteListItem" });
registry.add(NoteBody, { id: "NoteBody" });
registry.add(NoteList, { id: "NoteList" });
registry.add(CreateNote, {
  id: "CreateNote",
  description: "Leading and trailing whitespace is removed before the length is checked. The length is Unicode code points.",
});
registry.add(DeletedOne, { id: "DeletedOne" });
registry.add(DeletedCount, { id: "DeletedCount" });
registry.add(Health, { id: "Health" });
registry.add(ErrorBody, { id: "Error", description: "Every error response has this shape." });
registry.add(SummaryPreview, { id: "SummaryPreview", description: "Unchecked text while a summary is still being written." });
registry.add(TagsPreview, { id: "TagsPreview", description: "Unchecked tags while they are still being written." });

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface OpenApiDocument {
  openapi: "3.0.3";
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
}

function ref(name: string): Json {
  return { $ref: `#/components/schemas/${name}` };
}

function schemaOf(schema: z.ZodType): Json {
  return plainJson(z.toJSONSchema(schema, { target: "openapi-3.0", metadata: registry }));
}

function plainJson(value: unknown): Json {
  if (Array.isArray(value)) return value.map(plainJson);
  if (value === null || typeof value !== "object") return value as Json;
  const out: Record<string, Json> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "~standard" || key === "$id") continue;
    // Zod copies the registry id onto the schema. A property named id is an object, so it stays.
    if (key === "id" && typeof child === "string") continue;
    // z.int() adds JavaScript's safe-integer ceiling. The API has no such cap.
    if (key === "maximum" && child === Number.MAX_SAFE_INTEGER) continue;
    out[key] = plainJson(child);
  }
  return out;
}

function componentSchemas(): Record<string, Json> {
  const generated = z.toJSONSchema(registry, {
    target: "openapi-3.0",
    metadata: registry,
    uri: (id) => `#/components/schemas/${id}`,
    reused: "inline",
  });
  if ("__shared" in generated.schemas) {
    throw new Error("OpenAPI generation extracted a shared definition.");
  }
  return Object.fromEntries(Object.entries(generated.schemas).map(([name, schema]) => [name, plainJson(schema)]));
}

function json(description: string, schema: string): Json {
  return { description, content: { "application/json": { schema: ref(schema) } } };
}

const error = (description: string) => json(description, "Error");
const crossSite = error("cross_site_request when the request comes from another site.");

const noteId: Json = {
  name: "id",
  in: "path",
  required: true,
  description: "Note id. A malformed id is a 404, the same as an unknown one.",
  schema: ref("Uuid"),
};

const idempotencyKey: Json = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description: "A repeat with the same key returns the stored note and starts no AI calls.",
  schema: ref("Uuid"),
};

const regenerate: Json = {
  name: "regenerate",
  in: "query",
  required: false,
  description: "Pass true to replace the stored result. Any other value uses the cache.",
  schema: schemaOf(z.literal("true")),
};

function aiResponses(preview: "SummaryPreview" | "TagsPreview", field: "summary" | "tags"): Json {
  return {
    "200": {
      description: "The note with this field set. Accept: text/event-stream sends preview events, then done. A failure before any preview stays a JSON error; after a preview, the same body is an error event and the status is already 200.",
      content: {
        "application/json": { schema: ref("NoteBody") },
        "text/event-stream": {
          schema: {
            description: "Each data field is one of these JSON values. The event name is preview, done, or error.",
            oneOf: [ref(preview), ref("NoteBody"), ref("Error")],
          },
        },
      },
    },
    "403": crossSite,
    "404": error("not_found when no note has this id."),
    "422": error(
      field === "summary"
        ? `note_too_short when the note is under ${SUMMARY_MIN_CONTENT} characters, or ai_refused when the model declines.`
        : "ai_refused when the model declines.",
    ),
    "502": error("ai_unavailable or ai_invalid_output."),
    "503": error("ai_rate_limited."),
    "504": error("ai_timeout."),
  };
}

function build(): Omit<OpenApiDocument, "servers"> {
  return {
    openapi: "3.0.3",
    info: {
      title: "AI Notes",
      version: "1.0.0",
      description: "Saving a note generates tags, and a summary when the note is long enough. Either result can be regenerated.",
    },
    paths: {
      "/api/health": {
        get: {
          operationId: "health",
          summary: "Database health",
          tags: ["meta"],
          responses: {
            "200": json("The database answered.", "Health"),
            "503": error("database_unavailable when the database cannot be reached."),
          },
        },
      },
      "/api/notes": {
        get: {
          operationId: "listNotes",
          summary: "List notes",
          tags: ["notes"],
          responses: {
            "200": json("Newest first. Each item omits the body and the summary.", "NoteList"),
          },
        },
        post: {
          operationId: "createNote",
          summary: "Create a note",
          tags: ["notes"],
          description: "Stores the note and returns it with summary and tags null. Generation starts after the response. A repeat with the same Idempotency-Key returns the stored note and starts nothing.",
          parameters: [idempotencyKey],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("CreateNote") } },
          },
          responses: {
            "200": json("This Idempotency-Key already stored this note. Nothing new is generated.", "NoteBody"),
            "201": json("Created. Summary and tags are still null; generation starts after this response.", "NoteBody"),
            "400": error("validation_failed, invalid_json, or invalid_idempotency_key."),
            "403": crossSite,
            "413": error("payload_too_large when the body exceeds 256kb."),
            "422": error("idempotency_key_reused when this key already stored a different note."),
          },
        },
        delete: {
          operationId: "deleteAllNotes",
          summary: "Delete every note",
          tags: ["notes"],
          responses: {
            "200": json("How many notes were deleted.", "DeletedCount"),
            "403": crossSite,
          },
        },
      },
      "/api/notes/{id}": {
        get: {
          operationId: "getNote",
          summary: "Get a note",
          tags: ["notes"],
          parameters: [noteId],
          responses: {
            "200": json("The note, including body, summary, and tags.", "NoteBody"),
            "404": error("not_found when no note has this id."),
          },
        },
        delete: {
          operationId: "deleteNote",
          summary: "Delete a note",
          tags: ["notes"],
          parameters: [noteId],
          responses: {
            "200": json("The note was deleted.", "DeletedOne"),
            "403": crossSite,
            "404": error("not_found when no note has this id."),
          },
        },
      },
      "/api/notes/{id}/summary": {
        post: {
          operationId: "summarizeNote",
          summary: "Summarize a note",
          tags: ["notes"],
          description: "Cached after the first successful call. Joins the call a new note started, if it is still running.",
          parameters: [noteId, regenerate],
          responses: aiResponses("SummaryPreview", "summary"),
        },
      },
      "/api/notes/{id}/tags": {
        post: {
          operationId: "generateTags",
          summary: "Generate tags",
          tags: ["notes"],
          description: "Cached after the first successful call. Joins the call a new note started, if it is still running.",
          parameters: [noteId, regenerate],
          responses: aiResponses("TagsPreview", "tags"),
        },
      },
    },
    components: { schemas: componentSchemas() },
  };
}

let cached: Omit<OpenApiDocument, "servers"> | undefined;

// A relative URL is the fallback when the request has no usable host. Viewers resolve it
// against the document URL, so the same file still points at the API that served it.
export function openApiDocument(serverUrl = "/"): OpenApiDocument {
  cached ??= build();
  return { ...cached, servers: [{ url: serverUrl }] };
}

const SERVER_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;

/** The origin a client used to fetch the document, including the proxy's public host. */
export function serverUrlFromRequest(req: { protocol: string; get(name: string): string | undefined }): string {
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : req.protocol === "https" ? "https" : "http";
  const host = (req.get("x-forwarded-host") ?? req.get("host") ?? "").split(",")[0]?.trim() ?? "";
  if (!SERVER_HOST.test(host)) return "/";
  return `${proto}://${host}`;
}
