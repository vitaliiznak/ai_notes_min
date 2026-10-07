import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, clampText, noteLength, normalizeUserText, saveAttemptKey, storedNoteText } from "./api";

const NOTE = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Café notes",
  content: "Long enough to summarize.",
  summary: "A summary.",
  tags: ["café", "ötto", "notes"],
  createdAt: "2026-10-07T09:00:00.000Z",
};

/** An SSE body delivered in fixed-size byte slices, so events and multi-byte characters split mid-chunk. */
function sseResponse(body: string, sliceBytes: number): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += sliceBytes) controller.enqueue(bytes.slice(at, at + sliceBytes));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.generate over a stream", () => {
  const body =
    `event: preview\ndata: {"tags":["café"]}\n\n` +
    `event: preview\ndata: {"tags":["café","ötto"]}\n\n` +
    `event: done\ndata: ${JSON.stringify({ note: NOTE })}\n\n`;

  it("reads every preview and the stored note from a body split at arbitrary byte boundaries", async () => {
    // 7 bytes at a time: no slice lines up with an event boundary, and the é and ö each split in two.
    stubFetch(sseResponse(body, 7));
    const previews: unknown[] = [];
    const note = await api.generate(NOTE.id, "tags", false, (preview) => previews.push(preview));
    expect(previews).toEqual([{ tags: ["café"] }, { tags: ["café", "ötto"] }]);
    expect(note).toEqual(NOTE);
  });

  it("reads the same events from a body that arrives in one piece with CRLF line endings", async () => {
    stubFetch(sseResponse(body.replace(/\n/g, "\r\n"), body.length * 2));
    const previews: unknown[] = [];
    const note = await api.generate(NOTE.id, "tags", false, (preview) => previews.push(preview));
    expect(previews).toEqual([{ tags: ["café"] }, { tags: ["café", "ötto"] }]);
    expect(note).toEqual(NOTE);
  });

  it("requests a regenerate with the query the server looks for", async () => {
    const fetch = stubFetch(sseResponse(body, 64));
    await api.generate(NOTE.id, "summary", true, () => {});
    expect(fetch.mock.calls[0]![0]).toBe(`/api/notes/${NOTE.id}/summary?regenerate=true`);
  });

  it("turns an error event into the message shown to the person", async () => {
    stubFetch(
      sseResponse(
        `event: preview\ndata: {"tags":["café"]}\n\n` +
          `event: error\ndata: {"error":{"code":"ai_invalid_output","message":"The AI model returned malformed output."}}\n\n`,
        9,
      ),
    );
    await expect(api.generate(NOTE.id, "tags", false, () => {})).rejects.toThrow(
      "The AI's answer couldn't be used. Try again.",
    );
  });

  it("throws when the stream ends without a result", async () => {
    stubFetch(sseResponse(`event: preview\ndata: {"tags":["café"]}\n\n`, 9));
    await expect(api.generate(NOTE.id, "tags", false, () => {})).rejects.toThrow(
      "The AI response ended before a result.",
    );
  });
});

describe("api error handling", () => {
  it("keeps the status and code when the request fails before any stream", async () => {
    stubFetch(jsonResponse({ error: { code: "note_too_short", message: "Notes under 500 characters are not summarized." } }, 422));
    const error = await api.generate(NOTE.id, "summary", false, () => {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: "note_too_short" });
  });

  it("reports an unreachable server as a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const error = await api.listNotes().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "network_error", message: "Can't reach the server. Check your connection and try again." });
  });

  it("shows the server's validation message", async () => {
    stubFetch(
      jsonResponse(
        { error: { code: "validation_failed", message: "The request body is invalid.", issues: [{ path: "title", message: "Title is required." }] } },
        400,
      ),
    );
    await expect(api.createNote({ title: "", content: "x" }, NOTE.id)).rejects.toThrow("Title is required.");
  });
});

describe("api.createNote", () => {
  it("sends the idempotency key with the create request", async () => {
    const fetch = stubFetch(jsonResponse({ note: NOTE }, 201));
    const note = await api.createNote({ title: NOTE.title, content: NOTE.content }, NOTE.id);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ "content-type": "application/json", "idempotency-key": NOTE.id });
    expect(note).toEqual(NOTE);
  });

  it("reuses the key for a retry of the same stored text, and mints a new one when the text changes", () => {
    const first = saveAttemptKey(null, "  Hello \u200b", "Body", () => "key-1");
    const retry = saveAttemptKey(first, "Hello", "Body", () => "key-2");
    const edited = saveAttemptKey(retry, "Hello", "Body changed", () => "key-3");

    expect(first).toEqual({ text: storedNoteText("Hello", "Body"), key: "key-1" });
    expect(retry).toEqual({ text: first.text, key: "key-1" });
    expect(edited.key).toBe("key-3");
    expect(edited.text).not.toBe(first.text);
  });
});

describe("limits shared with the server", () => {
  it("counts length in code points, so an emoji is one character", () => {
    expect(noteLength("\u{1f600}\u{1f600}")).toBe(2);
  });

  it("clamps the stored text to whole code points, and keeps padding while that text still fits", () => {
    expect(clampText("\u{1f600}\u{1f600}\u{1f600}", 2)).toBe("\u{1f600}\u{1f600}");
    expect(clampText(`${" ".repeat(50)}Hello`, 200)).toBe(`${" ".repeat(50)}Hello`);
    expect(clampText(`${" ".repeat(50)}${"a".repeat(250)}`, 200)).toBe("a".repeat(200));
  });

  it("binds a retry to the text the server stores", () => {
    expect(storedNoteText("  Hello \u200b", "Body")).toBe(storedNoteText("Hello", "Body"));
  });

  it("strips the edge padding the server strips, and keeps inner whitespace", () => {
    expect(normalizeUserText(" ​ Buy milk\nand bread ﻿")).toBe("Buy milk\nand bread");
  });
});
