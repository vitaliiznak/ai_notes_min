import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { errorResponse, HttpError, logServerError } from "../errors.js";
import type { AiField, Note } from "../shared/notes.js";
import type { Enricher, FieldStream } from "./enrichment.js";
import { noteNotFound } from "./errors.js";
import { CreateNoteInput } from "./input.js";
import type { NotesRepo } from "./repo.js";

// A malformed id can't name an existing note, so it's a 404 like any unknown id.
function parseNoteId(req: Request): string {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw noteNotFound();
  return id.data;
}

// Optional. A client that sends one can retry a create without storing the note twice.
function idempotencyKey(req: Request): string | undefined {
  const header = req.get("idempotency-key");
  if (header === undefined) return undefined;
  const key = z.uuid().safeParse(header);
  if (!key.success) throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be a UUID.");
  return key.data;
}

// A repeat of an Idempotency-Key must carry the note it stored. The issues name the fields that differ, not their text.
function assertSameNote(input: CreateNoteInput, stored: Note) {
  const labels = { title: "Title", content: "Content" } as const;
  const issues = (["title", "content"] as const)
    .filter((field) => input[field] !== stored[field])
    .map((field) => ({ path: field, message: `${labels[field]} does not match the note stored for this Idempotency-Key.` }));
  if (issues.length > 0) {
    throw new HttpError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different note.", issues);
  }
}

const wantsEvents = (req: Request) => req.get("accept")?.includes("text/event-stream") === true;

// Anything but true/false is a 400, so a typo like ?regenerate=1 can't pass for a cache hit.
function wantsRegenerate(req: Request): boolean {
  const flag = z.enum(["true", "false"]).optional().safeParse(req.query.regenerate);
  if (!flag.success) throw new HttpError(400, "invalid_regenerate", "regenerate must be true or false.");
  return flag.data === "true";
}

function beginEventStream(res: Response) {
  res.status(200).set({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
}

// Headers wait for the first event, so a failure before any text still gets its own HTTP status as JSON.
// Once an event is sent the status is 200, so a later failure becomes an error event.
async function sendAsEvents(res: Response, stream: FieldStream) {
  const writeEvent = (event: "preview" | "done" | "error", data: unknown) => {
    if (!res.headersSent) beginEventStream(res);
    if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const stop = stream.watch((preview) => writeEvent("preview", preview));
  try {
    writeEvent("done", await stream.result);
  } catch (err) {
    if (!res.headersSent) throw err;
    logServerError(err);
    writeEvent("error", errorResponse(err).body);
  } finally {
    stop();
  }
  res.end();
}

export function notesRouter(repo: NotesRepo, enricher: Enricher): Router {
  const router = Router();

  router.get("/notes", async (_req, res) => {
    res.json({ notes: await repo.list() });
  });

  // Responds as soon as the note is stored; its tags (and summary, if long enough) are generated after.
  // 201 the first time. A repeat of the same Idempotency-Key returns the stored note with 200 and starts nothing.
  router.post("/notes", async (req, res) => {
    const input = CreateNoteInput.parse(req.body);
    const { note, created } = await repo.create(input, idempotencyKey(req));
    // The model call outlives this handler's response, and the note page joins that same call.
    if (created) enricher.enrichNote(note, { regenerate: false });
    else assertSameNote(input, note);
    res.status(created ? 201 : 200).json({ note });
  });

  router.delete("/notes", async (_req, res) => {
    res.json({ deleted: await repo.removeAll() });
  });

  router.delete("/notes/:id", async (req, res) => {
    if (!await repo.remove(parseNoteId(req))) throw noteNotFound();
    res.json({ deleted: 1 });
  });

  router.get("/notes/:id", async (req, res) => {
    const note = await repo.get(parseNoteId(req));
    if (!note) throw noteNotFound();
    res.json({ note });
  });

  // Cached after the first call; ?regenerate=true forces a new one.
  // Joins the call a new note started, if it is still running.
  // Accept: text/event-stream sends preview events, then done. Anything else gets one JSON body.
  // Both carry only the field, { summary } or { tags }: the rest of the row may not be written yet.
  const aiFieldHandler = (field: AiField) => async (req: Request, res: Response) => {
    const stream = await enricher.enrichField(parseNoteId(req), field, { regenerate: wantsRegenerate(req) });
    if (wantsEvents(req)) await sendAsEvents(res, stream);
    else res.json(await stream.result);
  };

  router.post("/notes/:id/summary", aiFieldHandler("summary"));
  router.post("/notes/:id/tags", aiFieldHandler("tags"));

  return router;
}
