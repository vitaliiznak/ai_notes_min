import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../src/db.js";
import { call, LONG_NOTE, scriptedAi, startServer, TEST_DATABASE_URL, type TestServer } from "./helpers.js";

const pool = createPool(TEST_DATABASE_URL);
let server: TestServer;
// Creating a note tags it in the background. Fixed output keeps those tags predictable.
const CREATED_TAGS = ["alpha", "beta", "gamma"];
const api = (method: string, path: string, body?: unknown) => call(server.url, method, path, body);
const countNotes = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM notes")).rows[0]!.n;

beforeAll(async () => {
  server = await startServer(pool, scriptedAi({ generateTags: () => ({ tags: CREATED_TAGS }) }).provider);
});
afterAll(async () => {
  await server.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE notes");
});
afterEach(async () => {
  await server.idle();
});

describe("POST /api/notes", () => {
  it("creates a note with a trimmed title and no AI results yet", async () => {
    const res = await api("POST", "/api/notes", { title: "  Groceries  ", content: "Milk, eggs, coffee." });

    expect(res.status).toBe(201);
    expect(res.body.note).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      title: "Groceries",
      content: "Milk, eggs, coffee.",
      summary: null,
      tags: null,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("accepts a title and content at exactly the size limits", async () => {
    const res = await api("POST", "/api/notes", { title: "t".repeat(200), content: "c".repeat(20_000) });

    expect(res.status).toBe(201);
    expect(res.body.note.content).toHaveLength(20_000);
  });

  it("counts the caps in code points, so an emoji is one character", async () => {
    const accepted = await api("POST", "/api/notes", { title: "😀".repeat(200), content: "😀".repeat(10_001) });
    const rejected = await api("POST", "/api/notes", { title: "x", content: "😀".repeat(20_001) });

    expect(accepted.status).toBe(201);
    expect(accepted.body.note.title).toBe("😀".repeat(200));
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(["content"]);
  });

  it("stores content with edge spaces and zero-width padding removed", async () => {
    const res = await api("POST", "/api/notes", { title: "Pad", content: " \u200b hi \n\u200b " });

    expect(res.status).toBe(201);
    expect(res.body.note.content).toBe("hi");
  });

  it.each([
    ["missing title", { content: "x" }, "title"],
    ["blank title", { title: "   ", content: "x" }, "title"],
    ["title over 200 chars", { title: "t".repeat(201), content: "x" }, "title"],
    ["missing content", { title: "x" }, "content"],
    ["whitespace-only content", { title: "x", content: " \n\t " }, "content"],
    ["content over 20,000 chars", { title: "x", content: "c".repeat(20_001) }, "content"],
    ["non-string content", { title: "x", content: 42 }, "content"],
    ["a null byte in the title", { title: "bad\u0000title", content: "x" }, "title"],
    ["a null byte in the content", { title: "x", content: "bad\u0000note" }, "content"],
    ["an unpaired surrogate in the title", { title: "bad\uD800title", content: "x" }, "title"],
    ["an unpaired surrogate in the content", { title: "x", content: "bad\uD800note" }, "content"],
  ])("rejects %s with 400", async (_case, body, field) => {
    const res = await api("POST", "/api/notes", body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_failed");
    expect(res.body.error.issues.map((i: { path: string }) => i.path)).toEqual([field]);
    expect((await api("GET", "/api/notes")).body.notes).toEqual([]);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await api("POST", "/api/notes", '{"title": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
  });
});

describe("POST /api/notes with an Idempotency-Key", () => {
  it("stores one note and starts one set of AI calls for 10 concurrent requests across two instances", async () => {
    // One provider shared by both instances, so its counts cover every AI call either one makes.
    const ai = scriptedAi({ delayMs: 100 });
    const a = await startServer(pool, ai.provider);
    const b = await startServer(pool, ai.provider);
    const key = randomUUID();
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          call((i % 2 === 0 ? a : b).url, "POST", "/api/notes", LONG_NOTE, { "idempotency-key": key }),
        ),
      );
      await Promise.all([a.idle(), b.idle()]);

      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([...Array(9).fill(200), 201]);
      const ids = new Set(results.map((r) => r.body.note.id));
      expect(ids.size).toBe(1);
      expect(await countNotes()).toBe(1);
      // Only the request that stored the note starts its call; repeats on the other instance do not.
      expect(ai.calls).toEqual({ summary: 0, tags: 0, summaryAndTags: 1 });
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("returns the stored note with 200 when the same key repeats, including padding the server strips", async () => {
    const key = randomUUID();
    const first = await call(server.url, "POST", "/api/notes", { title: "Plan", content: "Ship v1." }, { "idempotency-key": key });

    const repeat = await call(server.url, "POST", "/api/notes", { title: "Plan", content: "Ship v1." }, { "idempotency-key": key });
    const padded = await call(
      server.url,
      "POST",
      "/api/notes",
      { title: "  Plan  ", content: " \u200bShip v1. " },
      { "idempotency-key": key },
    );

    expect(first.status).toBe(201);
    expect(repeat.status).toBe(200);
    expect(padded.status).toBe(200);
    expect(repeat.body.note).toMatchObject({ id: first.body.note.id, title: "Plan", content: "Ship v1." });
    expect(padded.body.note.id).toBe(first.body.note.id);
    expect(await countNotes()).toBe(1);
  });

  it("rejects the same key with a different note with 422 and keeps the first", async () => {
    const key = randomUUID();
    const first = await call(server.url, "POST", "/api/notes", { title: "Plan", content: "Ship v1." }, { "idempotency-key": key });

    const res = await call(server.url, "POST", "/api/notes", { title: "Plan", content: "Ship v2." }, { "idempotency-key": key });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("idempotency_key_reused");
    expect((await api("GET", "/api/notes")).body.notes.map((n: { id: string }) => n.id)).toEqual([first.body.note.id]);
  });

  it("rejects a key that is not a UUID with 400 and stores nothing", async () => {
    const res = await call(server.url, "POST", "/api/notes", { title: "Plan", content: "Ship v1." }, { "idempotency-key": "retry-1" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_idempotency_key");
    expect(await countNotes()).toBe(0);
  });
});

describe("GET /api/notes", () => {
  it("lists notes newest first, without their content", async () => {
    for (const title of ["first", "second", "third"]) {
      await api("POST", "/api/notes", { title, content: `${title} body` });
    }

    const res = await api("GET", "/api/notes");

    expect(res.status).toBe(200);
    expect(res.body.notes.map((n: { title: string }) => n.title)).toEqual(["third", "second", "first"]);
    expect(Object.keys(res.body.notes[0]).sort()).toEqual(["createdAt", "id", "tags", "title"]);
  });
});

describe("GET /api/notes/:id", () => {
  it("returns the full note, with the tags its creation generated", async () => {
    const created = (await api("POST", "/api/notes", { title: "Plan", content: "Ship v1 on Friday." })).body.note;
    await server.idle();

    const res = await api("GET", `/api/notes/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.body.note).toEqual({ ...created, tags: CREATED_TAGS });
  });

  it.each([
    ["an unknown id", "00000000-0000-4000-8000-000000000000"],
    ["a malformed id", "not-a-uuid"],
  ])("returns 404 for %s", async (_case, id) => {
    const res = await api("GET", `/api/notes/${id}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("GET /api/health", () => {
  it("returns ok when the database answers", async () => {
    const res = await api("GET", "/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns the error envelope when the database rejects the connection", async () => {
    const dead = createPool("postgres://notes:notes@localhost:5432/notes_missing");
    const server = await startServer(dead, scriptedAi().provider);
    try {
      const res = await call(server.url, "GET", "/api/health");

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: { code: "database_unavailable", message: "The database is not available." },
      });
    } finally {
      await server.close();
      await dead.end();
    }
  });
});
