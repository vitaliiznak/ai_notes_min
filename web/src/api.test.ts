import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, charLength, normalizeUserText } from "./api";

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

  it.each([
    // 7 bytes at a time: no slice lines up with an event boundary, and the é and ö each split in two.
    ["split at arbitrary byte boundaries", body, 7],
    ["in one piece with CRLF line endings", body.replace(/\n/g, "\r\n"), body.length * 2],
  ])("reads every preview and the stored note from a body %s", async (_, text, sliceBytes) => {
    stubFetch(sseResponse(text, sliceBytes));
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
});

describe("limits shared with the server", () => {
  it("counts length in code points, so an emoji is one character", () => {
    expect(charLength("\u{1f600}\u{1f600}")).toBe(2);
  });

  it("strips the edge padding the server strips, and keeps inner whitespace", () => {
    expect(normalizeUserText(" ​ Buy milk\nand bread ﻿")).toBe("Buy milk\nand bread");
  });
});
