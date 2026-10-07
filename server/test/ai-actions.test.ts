import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiError, type AiErrorCode } from "../src/ai/provider.js";
import { createPool } from "../src/db.js";
import { SUMMARY_MAX_CHARS, SUMMARY_MIN_CONTENT } from "../src/notes/limits.js";
import { call, LONG_NOTE, scriptedAi, startServer, TEST_DATABASE_URL, type TestServer } from "./helpers.js";

const pool = createPool(TEST_DATABASE_URL);
const servers: TestServer[] = [];

async function serve(ai: ReturnType<typeof scriptedAi>) {
  const server = await startServer(pool, ai.provider);
  servers.push(server);
  const request = (method: string, path: string, body?: unknown) => call(server.url, method, path, body);
  return Object.assign(request, { url: server.url, idle: server.idle });
}

function parseSse(body: string): { event: string; data: any }[] {
  const events = [];
  for (const block of body.split(/\n\n/)) {
    if (!block.trim()) continue;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length > 0) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return events;
}

async function postStream(api: Awaited<ReturnType<typeof serve>>, path: string) {
  const res = await fetch(`${api.url}${path}`, {
    method: "POST",
    headers: { accept: "text/event-stream" },
  });
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    return { status: res.status, type, events: [{ event: "http", data: await res.json() }] };
  }
  return { status: res.status, type, events: parseSse(await res.text()) };
}

// Inserted directly: a note created over HTTP starts its own AI calls (tested below), and the
// endpoint tests count only the calls their own requests make.
async function createNote(note = LONG_NOTE): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO notes (title, content) VALUES ($1, $2) RETURNING id",
    [note.title, note.content],
  );
  return rows[0]!.id;
}

beforeEach(async () => {
  await pool.query("TRUNCATE notes");
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
afterAll(async () => {
  await pool.end();
});

// Both AI actions are mutation paths with identical guarantees, so they run the same suite.
describe.each([
  {
    field: "summary",
    first: "Summary 1. Second sentence.",
    second: "Summary 2. Second sentence.",
    lastPreview: { summary: "Summary 1. Second sentence." },
  },
  {
    field: "tags",
    first: ["tag-1", "alpha", "beta"],
    second: ["tag-2", "alpha", "beta"],
    lastPreview: { tags: ["tag-1", "alpha", "beta"] },
  },
] as const)("POST /api/notes/:id/$field", ({ field, first, second, lastPreview }) => {
  const path = (id: string) => `/api/notes/${id}/${field}`;

  it("generates the result, stores it and returns the updated note", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);
    const id = await createNote();

    const res = await api("POST", path(id));

    expect(res.status).toBe(200);
    expect(res.body.note[field]).toEqual(first);
    expect((await api("GET", `/api/notes/${id}`)).body.note[field]).toEqual(first);
    expect(ai.calls[field]).toBe(1);
  });

  it("serves the stored result on later calls without calling the AI again", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);
    const id = await createNote();
    await api("POST", path(id));

    const res = await api("POST", path(id));

    expect(res.body.note[field]).toEqual(first);
    expect(ai.calls[field]).toBe(1);
  });

  it("replaces the stored result when ?regenerate=true", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);
    const id = await createNote();
    await api("POST", path(id));

    const res = await api("POST", `${path(id)}?regenerate=true`);

    expect(res.body.note[field]).toEqual(second);
    expect((await api("GET", `/api/notes/${id}`)).body.note[field]).toEqual(second);
    expect(ai.calls[field]).toBe(2);
  });

  it("returns 404 for an unknown note without calling the AI", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);

    const res = await api("POST", path("00000000-0000-4000-8000-000000000000"));

    expect(res.status).toBe(404);
    expect(ai.calls[field]).toBe(0);
  });

  it("returns JSON 404 for an unknown note when the client accepts event-stream", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);

    const res = await postStream(api, path("00000000-0000-4000-8000-000000000000"));

    expect(res.status).toBe(404);
    expect(res.type).toContain("application/json");
    expect(ai.calls[field]).toBe(0);
  });

  it("makes exactly one AI call for 10 concurrent requests, and all of them get its result", async () => {
    const ai = scriptedAi({ delayMs: 200 });
    const api = await serve(ai);
    const id = await createNote();

    const results = await Promise.all(Array.from({ length: 10 }, () => api("POST", path(id))));

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(results.map((r) => r.body.note[field])).toEqual(Array(10).fill(first));
    expect(ai.calls[field]).toBe(1);
  });

  it("makes exactly one AI call for 5 concurrent regenerate requests", async () => {
    const ai = scriptedAi({ delayMs: 200 });
    const api = await serve(ai);
    const id = await createNote();
    await api("POST", path(id));

    const results = await Promise.all(Array.from({ length: 5 }, () => api("POST", `${path(id)}?regenerate=true`)));

    expect(results.map((r) => r.status)).toEqual(Array(5).fill(200));
    expect(results.map((r) => r.body.note[field])).toEqual(Array(5).fill(second));
    expect(ai.calls[field]).toBe(2);
  });

  it("converges on one stored result when two server instances generate concurrently", async () => {
    // One provider shared by both instances, so their two calls return different outputs.
    const ai = scriptedAi({ delayMs: 200 });
    const apiA = await serve(ai);
    const apiB = await serve(ai);
    const id = await createNote();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? apiA : apiB)("POST", path(id))),
    );

    // Each instance makes one call (no shared memory), but only the first write lands
    // and every response reports the stored value, never its own losing result.
    expect(ai.calls[field]).toBe(2);
    const stored = (await apiA("GET", `/api/notes/${id}`)).body.note[field];
    expect(results.map((r) => r.body.note[field])).toEqual(Array(10).fill(stored));
  });

  it("returns each instance's own regenerate result, and later reads agree", async () => {
    const ai = scriptedAi({ delayMs: 200 });
    const apiA = await serve(ai);
    const apiB = await serve(ai);
    const id = await createNote();

    const [a, b] = await Promise.all([
      apiA("POST", `${path(id)}?regenerate=true`),
      apiB("POST", `${path(id)}?regenerate=true`),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(ai.calls[field]).toBe(2);
    const returned = [a.body.note[field], b.body.note[field]];
    expect(returned).toContainEqual(first);
    expect(returned).toContainEqual(second);
    const storedA = (await apiA("GET", `/api/notes/${id}`)).body.note[field];
    const storedB = (await apiB("GET", `/api/notes/${id}`)).body.note[field];
    expect(storedA).toEqual(storedB);
    expect(returned).toContainEqual(storedA);
  });

  it.each([
    ["timeout", 504],
    ["rate_limited", 503],
    ["unavailable", 502],
    ["invalid_output", 502],
    ["refused", 422],
  ] as [AiErrorCode, number][])("maps AI error %s to HTTP %i and stores nothing", async (code, status) => {
    const fail = () => {
      throw new AiError(code, `simulated ${code}`);
    };
    const api = await serve(scriptedAi({ summarize: fail, generateTags: fail }));
    const id = await createNote();

    const res = await api("POST", path(id));

    expect(res.status).toBe(status);
    expect(res.body.error).toEqual({ code: `ai_${code}`, message: `simulated ${code}` });
    expect((await api("GET", `/api/notes/${id}`)).body.note[field]).toBeNull();
  });

  it("does not cache failures: the next request calls the AI again", async () => {
    const failFirst = <T>(ok: T) => (n: number) => {
      if (n === 1) throw new AiError("unavailable", "simulated outage");
      return ok;
    };
    const ai = scriptedAi({
      summarize: failFirst({ summary: "Recovered. Second sentence." }),
      generateTags: failFirst({ tags: ["recovered", "alpha", "beta"] }),
    });
    const api = await serve(ai);
    const id = await createNote();

    expect((await api("POST", path(id))).status).toBe(502);
    const res = await api("POST", path(id));

    expect(res.status).toBe(200);
    expect(ai.calls[field]).toBe(2);
  });

  it("streams previews and then the stored note when the client accepts event-stream", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);
    const id = await createNote();

    const res = await postStream(api, path(id));

    expect(res.status).toBe(200);
    expect(res.type).toContain("text/event-stream");
    const previews = res.events.filter((event) => event.event === "preview");
    const opening = previews[0];
    const closing = previews[previews.length - 1];
    expect(opening).toBeDefined();
    expect(closing).toBeDefined();
    expect(JSON.stringify(opening?.data).length).toBeLessThan(JSON.stringify(closing?.data).length);
    expect(closing?.data).toEqual(lastPreview);
    expect(res.events.at(-1)).toMatchObject({ event: "done", data: { note: { [field]: first } } });
    expect((await api("GET", `/api/notes/${id}`)).body.note[field]).toEqual(first);
    expect(ai.calls[field]).toBe(1);
  });

  it("returns a cached result as a single done event and does not call the AI again", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);
    const id = await createNote();
    await api("POST", path(id));

    const res = await postStream(api, path(id));

    expect(res.events.map((event) => event.event)).toEqual(["done"]);
    expect(res.events[0]?.data.note[field]).toEqual(first);
    expect(ai.calls[field]).toBe(1);
  });

  it("streams the replacement when ?regenerate=true", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);
    const id = await createNote();
    await api("POST", path(id));

    const res = await postStream(api, `${path(id)}?regenerate=true`);

    expect(res.events.at(-1)).toMatchObject({ event: "done", data: { note: { [field]: second } } });
    expect(ai.calls[field]).toBe(2);
  });

  it("makes exactly one AI call for 10 concurrent streaming requests, and all of them get its result", async () => {
    const ai = scriptedAi({ delayMs: 200 });
    const api = await serve(ai);
    const id = await createNote();

    const results = await Promise.all(Array.from({ length: 10 }, () => postStream(api, path(id))));

    expect(results.map((result) => result.status)).toEqual(Array(10).fill(200));
    expect(results.map((result) => result.events.at(-1)?.data.note[field])).toEqual(Array(10).fill(first));
    expect(ai.calls[field]).toBe(1);
  });

  it("keeps the HTTP error status when the model fails before any text", async () => {
    const fail = () => {
      throw new AiError("unavailable", "simulated outage");
    };
    const api = await serve(scriptedAi({ summarize: fail, generateTags: fail }));
    const id = await createNote();

    const res = await postStream(api, path(id));

    expect(res.status).toBe(502);
    expect(res.type).toContain("application/json");
    expect(res.events).toEqual([{ event: "http", data: { error: { code: "ai_unavailable", message: "simulated outage" } } }]);
  });

  it("sends an error event and stores nothing when streamed text fails validation", async () => {
    const ai = scriptedAi({
      summarize: () => ({ summary: "x".repeat(SUMMARY_MAX_CHARS + 1) }),
      generateTags: () => ({ tags: [] }),
    });
    const api = await serve(ai);
    const id = await createNote({ title: "Long", content: "n".repeat(SUMMARY_MAX_CHARS * 2) });

    const res = await postStream(api, path(id));

    const failure =
      field === "summary"
        ? {
            status: 200,
            type: "text/event-stream",
            event: "error",
            error: { code: "ai_invalid_output", message: `Expected a summary of at most ${SUMMARY_MAX_CHARS} characters.` },
          }
        : {
            status: 502,
            type: "application/json",
            event: "http",
            error: { code: "ai_invalid_output", message: "Expected at least 1 tag." },
          };
    expect(res.status).toBe(failure.status);
    expect(res.type).toContain(failure.type);
    expect(res.events.some((event) => event.event === "preview")).toBe(field === "summary");
    expect(res.events.at(-1)).toMatchObject({ event: failure.event, data: { error: failure.error } });
    expect((await api("GET", `/api/notes/${id}`)).body.note[field]).toBeNull();
  });
});

describe("AI output rules (applied to every provider's output)", () => {
  async function summarizeWith(summary: string, content = LONG_NOTE.content) {
    const api = await serve(scriptedAi({ summarize: () => ({ summary }) }));
    const id = await createNote({ title: "Note", content });
    const res = await api("POST", `/api/notes/${id}/summary`);
    return { res, stored: (await api("GET", `/api/notes/${id}`)).body.note.summary };
  }

  async function tagWith(tags: string[]) {
    const api = await serve(scriptedAi({ generateTags: () => ({ tags }) }));
    const id = await createNote();
    const res = await api("POST", `/api/notes/${id}/tags`);
    return { res, stored: (await api("GET", `/api/notes/${id}`)).body.note.tags };
  }

  it("stores one trimmed summary, including a single sentence", async () => {
    const { res } = await summarizeWith("\u200b  Upgrade is Friday.  \u200b");

    expect(res.status).toBe(200);
    expect(res.body.note.summary).toBe("Upgrade is Friday.");
  });

  it("rejects a blank summary with 502 and stores nothing", async () => {
    const { res, stored } = await summarizeWith(" \u200b ");

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ai_invalid_output");
    expect(res.body.error.message).toBe("Expected a summary.");
    expect(stored).toBeNull();
  });

  it("normalises tags: strips #, lowercases, collapses spaces and removes duplicates", async () => {
    const { res } = await tagWith(["#Postgres", "postgres", "  Trip   Planning ", "Q3 BUDGET"]);

    expect(res.body.note.tags).toEqual(["postgres", "trip planning", "q3 budget"]);
  });

  it("keeps the 5 most relevant tags when the model returns more", async () => {
    const { res } = await tagWith(["a1", "b2", "c3", "d4", "e5", "f6", "g7"]);

    expect(res.body.note.tags).toEqual(["a1", "b2", "c3", "d4", "e5"]);
  });

  it("drops tags longer than 40 characters and keeps a tag of exactly 40", async () => {
    const exact = "t".repeat(40);
    const { res } = await tagWith(["postgres", exact, "x".repeat(41), "friday"]);

    expect(res.status).toBe(200);
    expect(res.body.note.tags).toEqual(["postgres", exact, "friday"]);
  });

  it("keeps a single tag when the others are too long to store", async () => {
    const { res } = await tagWith(["postgres", "x".repeat(41), "y".repeat(41)]);

    expect(res.status).toBe(200);
    expect(res.body.note.tags).toEqual(["postgres"]);
  });

  it("sends summary text before storing it, and catches a second client up", async () => {
    const ai = scriptedAi({ streamDelayMs: 80 });
    const api = await serve(ai);
    const id = await createNote();
    const target = `/api/notes/${id}/summary`;

    const first = await fetch(`${api.url}${target}`, { method: "POST", headers: { accept: "text/event-stream" } });
    const reader = first.body?.getReader();
    if (!reader) throw new Error("expected a response body");
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("event: preview")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
    }
    expect(seen).toContain("event: preview");
    expect((await api("GET", `/api/notes/${id}`)).body.note.summary).toBeNull();

    const second = await postStream(api, `/api/notes/${id}/summary`);
    while (!(await reader.read()).done) {}

    expect(ai.calls.summary).toBe(1);
    expect(second.events.some((event) => event.event === "preview" && typeof event.data.summary === "string")).toBe(true);
    expect(second.events.at(-1)).toMatchObject({
      event: "done",
      data: { note: { summary: "Summary 1. Second sentence." } },
    });
    expect((await api("GET", `/api/notes/${id}`)).body.note.summary).toBe("Summary 1. Second sentence.");
  });

  it("rejects a summary over the character cap with 502 and stores nothing", async () => {
    const { res, stored } = await summarizeWith("x".repeat(SUMMARY_MAX_CHARS + 1), "n".repeat(SUMMARY_MAX_CHARS * 2));

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ai_invalid_output");
    expect(res.body.error.message).toBe(`Expected a summary of at most ${SUMMARY_MAX_CHARS} characters.`);
    expect(stored).toBeNull();
  });

  it("rejects a summary that is not at least 20% shorter than the note and stores nothing", async () => {
    const content = "n".repeat(SUMMARY_MIN_CONTENT);
    const api = await serve(scriptedAi({ summarize: () => ({ summary: "a".repeat(401) }) }));
    const id = await createNote({ title: "Short", content });

    const res = await api("POST", `/api/notes/${id}/summary`);

    expect(res.status).toBe(502);
    expect(res.body.error.message).toBe("Expected a summary at least 20% shorter than the note.");
    expect((await api("GET", `/api/notes/${id}`)).body.note.summary).toBeNull();
  });

  it("stores a summary of exactly 80% of the note, counted in code points", async () => {
    const content = "😀".repeat(SUMMARY_MIN_CONTENT);
    const summary = "😀".repeat(400);
    const api = await serve(scriptedAi({ summarize: () => ({ summary }) }));
    const id = await createNote({ title: "Short", content });

    const res = await api("POST", `/api/notes/${id}/summary`);

    expect(res.status).toBe(200);
    expect(res.body.note.summary).toBe(summary);
  });

  it("stores a summary of exactly the character cap, counted in code points, when the note is long enough", async () => {
    const summary = "😀".repeat(SUMMARY_MAX_CHARS);
    const api = await serve(scriptedAi({ summarize: () => ({ summary }) }));
    const id = await createNote({ title: "Long", content: "n".repeat(SUMMARY_MAX_CHARS * 2) });

    const res = await api("POST", `/api/notes/${id}/summary`);

    expect(res.status).toBe(200);
    expect(res.body.note.summary).toBe(summary);
  });

  it("counts a tag's length in code points, so 40 emoji fit and 41 do not", async () => {
    const exact = "😀".repeat(40);
    const { res } = await tagWith(["postgres", exact, "😀".repeat(41), "friday"]);

    expect(res.status).toBe(200);
    expect(res.body.note.tags).toEqual(["postgres", exact, "friday"]);
  });

  it("stores one tag, and collapses duplicates without requiring more", async () => {
    const one = await tagWith(["Postgres"]);
    expect(one.res.status).toBe(200);
    expect(one.res.body.note.tags).toEqual(["postgres"]);

    const two = await tagWith(["postgres", "\u200b#Postgres", "upgrade"]);
    expect(two.res.status).toBe(200);
    expect(two.res.body.note.tags).toEqual(["postgres", "upgrade"]);
  });

  it("rejects a result with no usable tags and stores nothing", async () => {
    const { res, stored } = await tagWith(["x".repeat(41), "#", "   "]);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ai_invalid_output");
    expect(res.body.error.message).toBe("Expected at least 1 tag.");
    expect(stored).toBeNull();
  });
});

describe("POST /api/notes starts the AI results", () => {
  it("stores tags and a summary for a long note from one AI call, with no further request", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);

    const created = await api("POST", "/api/notes", LONG_NOTE);
    await api.idle();

    expect(created.status).toBe(201);
    expect(created.body.note).toMatchObject({ summary: null, tags: null });
    expect((await api("GET", `/api/notes/${created.body.note.id}`)).body.note).toMatchObject({
      summary: "Summary 1. Second sentence.",
      tags: ["tag-1", "alpha", "beta"],
    });
    expect(ai.calls).toEqual({ summary: 0, tags: 0, summaryAndTags: 1 });
  });

  const tagsOnly = { summary: 0, tags: 1, summaryAndTags: 0 };
  const both = { summary: 0, tags: 0, summaryAndTags: 1 };
  it.each([
    ["one character under the limit", "n".repeat(SUMMARY_MIN_CONTENT - 1), null, tagsOnly],
    // 998 UTF-16 units but 499 characters, as Postgres counts them for the CHECK.
    ["of emoji one character under the limit", "😀".repeat(SUMMARY_MIN_CONTENT - 1), null, tagsOnly],
    ["exactly at the limit", "n".repeat(SUMMARY_MIN_CONTENT), "Summary 1. Second sentence.", both],
    [
      "padded past the limit with spaces and zero-width characters",
      `${"n".repeat(SUMMARY_MIN_CONTENT - 1)} ${"\u200b".repeat(20)}`,
      null,
      tagsOnly,
    ],
  ])("stores tags for a note %s, and a summary only from the limit up", async (_case, content, summary, calls) => {
    const ai = scriptedAi();
    const api = await serve(ai);

    const created = await api("POST", "/api/notes", { title: "Limit", content });
    await api.idle();

    expect((await api("GET", `/api/notes/${created.body.note.id}`)).body.note).toMatchObject({
      summary,
      tags: ["tag-1", "alpha", "beta"],
    });
    expect(ai.calls).toEqual(calls);
  });

  it("logs a failed generation, stores nothing, and lets the next request try again", async () => {
    const ai = scriptedAi({
      summarizeAndTag: () => {
        throw new AiError("unavailable", "simulated outage");
      },
    });
    const api = await serve(ai);

    const created = await api("POST", "/api/notes", LONG_NOTE);
    await api.idle();
    const id = created.body.note.id;
    expect((await api("GET", `/api/notes/${id}`)).body.note).toMatchObject({ summary: null, tags: null });

    const res = await api("POST", `/api/notes/${id}/summary`);

    expect(res.body.note.summary).toBe("Summary 1. Second sentence.");
    expect(ai.calls).toEqual({ summary: 1, tags: 0, summaryAndTags: 1 });
  });

  it("stores the tags when the summary breaks its rule, and the next summary request retries only the summary", async () => {
    const ai = scriptedAi({
      summarizeAndTag: () => ({ tags: ["postgres", "upgrade", "friday"], summary: "x".repeat(SUMMARY_MAX_CHARS + 1) }),
    });
    const api = await serve(ai);

    const id = (await api("POST", "/api/notes", LONG_NOTE)).body.note.id;
    await api.idle();
    expect((await api("GET", `/api/notes/${id}`)).body.note).toMatchObject({
      summary: null,
      tags: ["postgres", "upgrade", "friday"],
    });

    const res = await api("POST", `/api/notes/${id}/summary`);

    expect(res.body.note).toMatchObject({ summary: "Summary 1. Second sentence.", tags: ["postgres", "upgrade", "friday"] });
    expect(ai.calls).toEqual({ summary: 1, tags: 0, summaryAndTags: 1 });
  });

  it("stores the summary when the tags break their rule, and the next tags request retries only the tags", async () => {
    const ai = scriptedAi({
      summarizeAndTag: () => ({ tags: ["x".repeat(41), "#", "   "], summary: "Upgrade is Friday. Second sentence." }),
    });
    const api = await serve(ai);

    const id = (await api("POST", "/api/notes", LONG_NOTE)).body.note.id;
    await api.idle();
    expect((await api("GET", `/api/notes/${id}`)).body.note).toMatchObject({
      summary: "Upgrade is Friday. Second sentence.",
      tags: null,
    });

    const res = await api("POST", `/api/notes/${id}/tags`);

    expect(res.status).toBe(200);
    expect(res.body.note).toMatchObject({
      summary: "Upgrade is Friday. Second sentence.",
      tags: ["tag-1", "alpha", "beta"],
    });
    expect(ai.calls).toEqual({ summary: 0, tags: 1, summaryAndTags: 1 });
  });

  it("keeps a summary another instance stored first, and stores its own tags", async () => {
    // A's call for the new note outlasts B's summary call, so B's summary is stored first.
    const slow = scriptedAi({ delayMs: 200 });
    const fast = scriptedAi({ summarize: () => ({ summary: "From B. Stored first." }) });
    const apiA = await serve(slow);
    const apiB = await serve(fast);
    const id = (await apiA("POST", "/api/notes", LONG_NOTE)).body.note.id;

    const fromB = await apiB("POST", `/api/notes/${id}/summary`);
    await apiA.idle();

    expect(fromB.body.note.summary).toBe("From B. Stored first.");
    expect((await apiA("GET", `/api/notes/${id}`)).body.note).toMatchObject({
      summary: "From B. Stored first.",
      tags: ["tag-1", "alpha", "beta"],
    });
    expect(slow.calls).toEqual({ summary: 0, tags: 0, summaryAndTags: 1 });
  });
});

describe.each([
  { field: "summary", first: "Summary 1. Second sentence." },
  { field: "tags", first: ["tag-1", "alpha", "beta"] },
] as const)("POST /api/notes/:id/$field while the new note is still generating it", ({ field, first }) => {
  it("joins that call: 10 concurrent requests and one AI call", async () => {
    const ai = scriptedAi({ delayMs: 200 });
    const api = await serve(ai);
    const id = (await api("POST", "/api/notes", LONG_NOTE)).body.note.id;

    const results = await Promise.all(Array.from({ length: 10 }, () => api("POST", `/api/notes/${id}/${field}`)));

    expect(results.map((r) => r.body.note[field])).toEqual(Array(10).fill(first));
    expect(ai.calls).toEqual({ summary: 0, tags: 0, summaryAndTags: 1 });
  });

  it("streams that call's text to the client that asks", async () => {
    const ai = scriptedAi({ delayMs: 200 });
    const api = await serve(ai);
    const id = (await api("POST", "/api/notes", LONG_NOTE)).body.note.id;

    const res = await postStream(api, `/api/notes/${id}/${field}`);

    expect(res.events.some((event) => event.event === "preview")).toBe(true);
    expect(res.events.at(-1)).toMatchObject({ event: "done", data: { note: { [field]: first } } });
    expect(ai.calls).toEqual({ summary: 0, tags: 0, summaryAndTags: 1 });
  });
});

describe("POST /api/notes/:id/summary and /tags while the new note is still generating them", () => {
  it("joins the one call: 5 concurrent requests for each and one AI call", async () => {
    const ai = scriptedAi({ delayMs: 200 });
    const api = await serve(ai);
    const id = (await api("POST", "/api/notes", LONG_NOTE)).body.note.id;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => api("POST", `/api/notes/${id}/${i % 2 === 0 ? "summary" : "tags"}`)),
    );

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(results.filter((_, i) => i % 2 === 0).map((r) => r.body.note.summary)).toEqual(
      Array(5).fill("Summary 1. Second sentence."),
    );
    expect(results.filter((_, i) => i % 2 === 1).map((r) => r.body.note.tags)).toEqual(
      Array(5).fill(["tag-1", "alpha", "beta"]),
    );
    expect(ai.calls).toEqual({ summary: 0, tags: 0, summaryAndTags: 1 });
  });
});

describe("summary of a short note", () => {
  const short = { title: "Groceries", content: "Milk, eggs, coffee." };
  const refusal = {
    code: "note_too_short",
    message: `Notes under ${SUMMARY_MIN_CONTENT} characters are not summarized.`,
  };

  it.each(["", "?regenerate=true"])("is refused with 422 for POST /summary%s, with no AI call", async (query) => {
    const ai = scriptedAi();
    const api = await serve(ai);
    const id = await createNote(short);

    const res = await api("POST", `/api/notes/${id}/summary${query}`);

    expect(res.status).toBe(422);
    expect(res.body.error).toEqual(refusal);
    expect(ai.calls.summary).toBe(0);
  });

  it("is refused as JSON 422 when the client accepts event-stream", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);
    const id = await createNote(short);

    const res = await postStream(api, `/api/notes/${id}/summary`);

    expect(res.status).toBe(422);
    expect(res.type).toContain("application/json");
    expect(res.events).toEqual([{ event: "http", data: { error: refusal } }]);
    expect(ai.calls.summary).toBe(0);
  });

  it("does not stop the note from being tagged", async () => {
    const ai = scriptedAi();
    const api = await serve(ai);
    const id = await createNote(short);

    const res = await api("POST", `/api/notes/${id}/tags`);

    expect(res.status).toBe(200);
    expect(res.body.note.tags).toEqual(["tag-1", "alpha", "beta"]);
  });
});
