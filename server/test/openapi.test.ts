import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../src/db.js";
import {
  CONTENT_MAX,
  SUMMARY_MAX_CHARS,
  TAG_MAX_LENGTH,
  TAGS_MAX,
  TITLE_MAX,
} from "../src/notes/limits.js";
import { NoteSchema, openApiDocument } from "../src/openapi.js";
import { call, scriptedAi, startServer, TEST_DATABASE_URL, type TestServer } from "./helpers.js";

describe("OpenAPI document", () => {
  const doc = openApiDocument();

  it("uses the shared note limits", () => {
    expect(doc.components.schemas.CreateNote).toMatchObject({
      properties: {
        title: { maxLength: TITLE_MAX },
        content: { maxLength: CONTENT_MAX },
      },
    });
    expect(doc.components.schemas.Note).toMatchObject({
      properties: {
        title: { maxLength: TITLE_MAX },
        content: { maxLength: CONTENT_MAX },
        summary: { maxLength: SUMMARY_MAX_CHARS },
        tags: { maxItems: TAGS_MAX, items: { maxLength: TAG_MAX_LENGTH } },
      },
    });
    expect(doc.components.schemas.DeletedCount).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["deleted"],
      properties: { deleted: { type: "integer", minimum: 0 } },
    });
    expect(JSON.stringify(doc)).not.toContain("~standard");
  });

  it("covers every route", () => {
    expect(Object.fromEntries(Object.entries(doc.paths).map(([path, item]) => [path, Object.keys(item).sort()]))).toEqual({
      "/api/health": ["get"],
      "/api/notes": ["delete", "get", "post"],
      "/api/notes/{id}": ["delete", "get"],
      "/api/notes/{id}/summary": ["post"],
      "/api/notes/{id}/tags": ["post"],
    });
    expect(Object.keys(doc.components.schemas).sort()).toEqual([
      "CreateNote",
      "DeletedCount",
      "DeletedOne",
      "Error",
      "Health",
      "Note",
      "NoteBody",
      "NoteList",
      "NoteListItem",
      "SummaryPreview",
      "TagsPreview",
      "Uuid",
    ]);
  });
});

describe("GET /api/openapi.json", () => {
  const pool = createPool(TEST_DATABASE_URL);
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer(pool, scriptedAi().provider);
  });
  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it("returns the generated document", async () => {
    const res = await call(server.url, "GET", "/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(openApiDocument());
  });

  it("accepts a note the API stored", async () => {
    await pool.query("TRUNCATE notes");
    const created = await call(server.url, "POST", "/api/notes", { title: "Groceries", content: "Milk, eggs, coffee." });
    await server.idle();
    const stored = await call(server.url, "GET", `/api/notes/${created.body.note.id}`);

    expect(NoteSchema.parse(stored.body.note)).toEqual(stored.body.note);
  });
});
