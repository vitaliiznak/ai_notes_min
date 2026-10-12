import type { AiProvider, OnText, SummaryAndTagsOutput } from "../ai/provider.js";
import { logServerError } from "../errors.js";
import type { AiField, AiPreview, AiResult, Note } from "../shared/notes.js";
import { canSummarize, SUMMARY_MIN_CONTENT } from "../shared/rules.js";
import { acceptSummary, acceptTags, parsePartialField } from "./ai-output.js";
import { NoteError, noteNotFound } from "./errors.js";
import type { NotesRepo } from "./repo.js";

/** One field of a note as a request reads it: previews while the model writes it, then the field as stored. */
export interface FieldStream {
  /** Calls `onPreview` with the latest preview, if any, then with each new one. Returns a function that stops it. */
  watch(onPreview: (preview: AiPreview) => void): () => void;
  /** This call's value, or the one another writer stored first. */
  result: Promise<AiResult>;
}

const alreadyStored = (result: AiResult): FieldStream => ({ watch: () => () => {}, result: Promise.resolve(result) });

/** The field as this row stores it. Callers read a field only once it is written, and nothing clears one. */
function storedField(note: Note, field: AiField): AiResult {
  if (field === "summary" && note.summary !== null) return { summary: note.summary };
  if (field === "tags" && note.tags !== null) return { tags: note.tags };
  throw new Error(`Note ${note.id} has no stored ${field}.`);
}

interface PreviewFeed {
  /** Appends the next piece of the model's text. */
  push(delta: string): void;
  watch: FieldStream["watch"];
}

/**
 * Previews of one field, parsed from the model's text as it arrives. Each preview is the whole field so far,
 * so a request that joins late only needs the latest one.
 */
function createPreviewFeed(field: AiField): PreviewFeed {
  let text = "";
  let latest: AiPreview | null = null;
  const listeners = new Set<(preview: AiPreview) => void>();
  return {
    push(delta) {
      text += delta;
      const preview = parsePartialField(field, text);
      if (!preview || JSON.stringify(preview) === JSON.stringify(latest)) return;
      latest = preview;
      listeners.forEach((listener) => listener(preview));
    },
    watch(listener) {
      if (latest) listener(latest);
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The note a model call read, and what the model returned. No output when every field was already stored. */
interface CallOutcome {
  note: Note;
  output: Partial<SummaryAndTagsOutput> | null;
}

/** Why some of these promises rejected, each distinct reason once, after all of them have settled. */
async function distinctFailures(promises: Promise<unknown>[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(promises);
  return [...new Set(settled.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])))];
}

export interface Enricher {
  /**
   * The note's stored field (skipped when `regenerate`), else the call already writing that field, else a
   * new model call. A JSON client awaits `result`; a streaming one also watches its previews. Rejects with
   * a not_found NoteError when the note does not exist, or is deleted before the result is stored.
   */
  enrichField(noteId: string, field: AiField, opts: { regenerate: boolean }): Promise<FieldStream>;
  /**
   * Fills what a note gets: tags, plus a summary when it is long enough. Skips a field that is stored (unless
   * `regenerate`) or that a running call is writing; the rest come from one model call. Takes the note, not
   * its id, so a new note's call is listed before the create request responds and the note page joins it.
   * Does not wait. A failure is logged and not stored, so the next request tries again.
   */
  enrichNote(note: Note, opts: { regenerate: boolean }): void;
  /** Resolves once no model call is running. */
  idle(): Promise<void>;
}

/**
 * Generates and caches AI results on notes.
 *
 * Duplicate-call protection has two layers:
 * 1. In this process, each field a running call writes is listed in `inFlight` until it settles, and a
 *    request for that field joins it.
 * 2. Across processes, the conditional write in repo.saveAiResult lets only the first result land;
 *    later writers get the stored value back instead of their own.
 */
export function createEnricher(repo: NotesRepo, ai: AiProvider): Enricher {
  /** The field streams of running calls, under `${field}:${noteId}`. */
  const inFlight = new Map<string, FieldStream>();
  const keyOf = (field: AiField, noteId: string) => `${field}:${noteId}`;

  /**
   * Starts one model call for these fields of a note. Each field gets its own stream, its own rule and its
   * own write, so a summary that breaks its rule does not cost the tags. Returns the streams in field order.
   */
  function startCall(noteId: string, fields: AiField[], { regenerate }: { regenerate: boolean }): FieldStream[] {
    const feeds = new Map(fields.map((field) => [field, createPreviewFeed(field)]));
    const outcome = callModel(noteId, fields, regenerate, (delta) => feeds.forEach((feed) => feed.push(delta)));
    return [...feeds].map(([field, feed]) => {
      const stream: FieldStream = { watch: feed.watch, result: outcome.then((o) => storeField(field, o, regenerate)) };
      trackUntilSettled(keyOf(field, noteId), stream);
      return stream;
    });
  }

  /**
   * Reads the note again, then asks the model for these fields. A call that ended while this request was
   * looking up the note may have stored them already; then there is nothing to ask.
   */
  async function callModel(noteId: string, fields: AiField[], regenerate: boolean, onText: OnText): Promise<CallOutcome> {
    const note = await repo.get(noteId);
    if (!note) throw noteNotFound();
    if (!regenerate && fields.every((field) => note[field] !== null)) return { note, output: null };
    return { note, output: await askProvider(note, fields, onText) };
  }

  /** Both fields from one request when a new long note needs both, so its input tokens are paid for once. */
  function askProvider(note: Note, fields: AiField[], onText: OnText): Promise<Partial<SummaryAndTagsOutput>> {
    const summary = fields.includes("summary");
    const tags = fields.includes("tags");
    if (summary && tags) return ai.summarizeAndTag(note, onText);
    return summary ? ai.summarize(note, onText) : ai.generateTags(note, onText);
  }

  /** Checks one field of the output against its rule, and stores it. Resolves to the field as the row then holds it. */
  async function storeField(field: AiField, { note, output }: CallOutcome, regenerate: boolean): Promise<AiResult> {
    if (!output) return storedField(note, field);
    const value = field === "summary" ? { summary: acceptSummary(output, note.content) } : { tags: acceptTags(output) };
    const saved = await repo.saveAiResult(note.id, value, { overwrite: regenerate });
    // No row: the note was deleted while the model wrote.
    if (!saved) throw noteNotFound();
    return storedField(saved, field);
  }

  /** A field's stream without a new call: its stored value (unless `regenerate`), else the running call writing it. */
  function existingStream(note: Note, field: AiField, regenerate: boolean): FieldStream | undefined {
    if (!regenerate && note[field] !== null) return alreadyStored(storedField(note, field));
    // A regenerate joins a running call too: the model is already writing a new result.
    return inFlight.get(keyOf(field, note.id));
  }

  /** Lists a field's stream until it is stored or has failed, so a request for that field joins it. */
  function trackUntilSettled(key: string, stream: FieldStream) {
    const untrack = () => {
      if (inFlight.get(key) === stream) inFlight.delete(key);
    };
    inFlight.set(key, stream);
    // Handling both outcomes also keeps a failure that no request reads from crashing the process.
    void stream.result.then(untrack, untrack);
  }

  return {
    async enrichField(noteId, field, { regenerate }) {
      const note = await repo.get(noteId);
      if (!note) throw noteNotFound();
      // Business rule: short notes get tags only. Mirrored by notes_summary_min_content_chk in table.ts.
      if (field === "summary" && !canSummarize(note.content)) {
        throw new NoteError("note_too_short", `Notes under ${SUMMARY_MIN_CONTENT} characters are not summarized.`);
      }
      return existingStream(note, field, regenerate) ?? startCall(noteId, [field], { regenerate })[0]!;
    },
    enrichNote(note, { regenerate }) {
      // A short note gets tags only: a summary of it would be about as long as the note, and the CHECK
      // rejects storing one.
      const wanted: AiField[] = canSummarize(note.content) ? ["summary", "tags"] : ["tags"];
      const missing = wanted.filter((field) => !existingStream(note, field, regenerate));
      if (missing.length === 0) return;
      const streams = startCall(note.id, missing, { regenerate });
      // No request may be reading this call, so its failures are logged here. A failed call fails every
      // field with the same error, which is logged once. A joined call's failures are its readers' to log.
      void distinctFailures(streams.map((stream) => stream.result)).then((failures) => failures.forEach(logServerError));
    },
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()].map((stream) => stream.result));
    },
  };
}
