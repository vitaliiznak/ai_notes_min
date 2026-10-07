import { AiError, type AiProvider, type SummaryOutput, type TagsOutput } from "../ai/provider.js";
import { replayLog, type AiTextStream, type ReplayLog } from "../ai/stream.js";
import { HttpError, logServerError } from "../errors.js";
import type { NotesRepo } from "./repo.js";
import { partialJsonString, partialStringArray } from "./preview.js";
import {
  canSummarize,
  charLength,
  normalizeUserText,
  stripLeadingPad,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_CONTENT,
  summaryCharLimit,
  TAG_MAX_LENGTH,
  TAGS_MAX,
  TAGS_MIN,
  type AiField,
  type AiPreview,
  type Note,
} from "./limits.js";

/**
 * Business rule: one non-blank text no longer than summaryCharLimit(content).
 * Applies to every provider. A miss is not stored, so the next request tries again.
 */
export function toSummary(output: SummaryOutput, content: string): string {
  const summary = normalizeUserText(output.summary);
  if (charLength(summary) < 1) {
    throw new AiError("invalid_output", "Expected a summary.");
  }
  const limit = summaryCharLimit(content);
  if (charLength(summary) > limit) {
    throw new AiError(
      "invalid_output",
      limit < SUMMARY_MAX_CHARS
        ? "Expected a summary at least 20% shorter than the note."
        : `Expected a summary of at most ${SUMMARY_MAX_CHARS} characters.`,
    );
  }
  return summary;
}

// A leading "#" can sit on the padding normalizeUserText strips, so strip it and normalise the edges again.
function normaliseTag(raw: string): string {
  return normalizeUserText(normalizeUserText(raw).replace(/^#+/, "")).replace(/\s+/g, " ").toLowerCase();
}

/** Lowercase, strip #, collapse whitespace, drop empties and over-long tags, dedupe, keep 5. */
function normaliseTags(raw: string[]): string[] {
  const normalised = raw
    .map(normaliseTag)
    .filter((t) => charLength(t) > 0 && charLength(t) <= TAG_MAX_LENGTH);
  return [...new Set(normalised)].slice(0, TAGS_MAX);
}

// Same cleaning as a finished tag, except a trailing space stays: the model may still be writing the next word.
function normaliseOpenTag(raw: string): string {
  const started = stripLeadingPad(stripLeadingPad(raw).replace(/^#+/, "")).replace(/\s+/g, " ").toLowerCase();
  const stored = normalizeUserText(started);
  if (charLength(stored) < 1 || charLength(stored) > TAG_MAX_LENGTH) return "";
  return started;
}

function previewTags(done: string[], tail: string): string[] {
  const tags = normaliseTags(done);
  if (tags.length >= TAGS_MAX) return tags;
  const open = normaliseOpenTag(tail);
  if (!open || tags.includes(open)) return tags;
  return [...tags, open];
}

/** Business rule: 1–5 distinct, normalised tags. Extras beyond 5 are dropped (the model ranks by relevance). */
export function toTags(output: TagsOutput): string[] {
  const tags = normaliseTags(output.tags);
  if (tags.length < TAGS_MIN) {
    throw new AiError("invalid_output", `Expected at least ${TAGS_MIN} ${TAGS_MIN === 1 ? "tag" : "tags"}.`);
  }
  return tags;
}

/**
 * Readable slice of the model's JSON so far. Not validated; the finished output still goes through toSummary/toTags.
 * A closed string is trimmed the way it will be stored. An open one keeps its trailing space so the next word does not flicker.
 */
export function previewModelText(field: AiField, text: string): AiPreview | null {
  if (field === "summary") {
    const partial = partialJsonString(text, "summary");
    if (partial === null) return null;
    const summary = partial.closed ? normalizeUserText(partial.value) : stripLeadingPad(partial.value);
    return charLength(normalizeUserText(summary)) > 0 ? { summary } : null;
  }
  const partial = partialStringArray(text, "tags");
  if (!partial) return null;
  const tags = previewTags(partial.done, partial.tail);
  return tags.length > 0 ? { tags } : null;
}

export interface LiveEnrichment {
  previews: AsyncIterable<AiPreview>;
  note: Promise<Note | null>;
}

export interface Enricher {
  /**
   * The note's stored result, or the call that produces it. A JSON client awaits `note`; a streaming one also
   * reads `previews`. Resolves to a null note when the note does not exist.
   */
  open(noteId: string, field: AiField, opts: { regenerate: boolean }): Promise<LiveEnrichment>;
  /**
   * Starts what a new note gets: tags, plus a summary when it is long enough, from one model call.
   * Does not wait. A request for either field joins the running call. A failure is logged and not
   * stored, so the next request for that field tries again.
   */
  start(note: Note): void;
  /** Resolves once no AI call is running. Shutdown waits for it before closing the pool. */
  idle(): Promise<void>;
}

/** Business rule: short notes get tags only. Mirrored by notes_summary_min_content_chk in table.ts. */
function assertSummarizable(note: Note) {
  if (!canSummarize(note.content)) {
    throw new HttpError(422, "note_too_short", `Notes under ${SUMMARY_MIN_CONTENT} characters are not summarized.`);
  }
}

const noPreviews: AsyncIterable<AiPreview> = { async *[Symbol.asyncIterator]() {} };

/** Reads the model's text as it arrives, passing on the text so far, and resolves with the parsed output. */
async function follow<T>(streamed: AiTextStream<T>, onText: (text: string) => void): Promise<T> {
  let accumulated = "";
  for await (const delta of streamed.deltas) {
    accumulated += delta;
    onText(accumulated);
  }
  return streamed.output;
}

/** Adds a preview to `log`, skipping a missing one and one that repeats the last. */
function previewWriter(log: ReplayLog<AiPreview>): (preview: AiPreview | null) => void {
  let last = "";
  return (preview) => {
    if (!preview) return;
    const encoded = JSON.stringify(preview);
    if (encoded === last) return;
    last = encoded;
    log.push(preview);
  };
}

/**
 * Generates and caches AI results on notes.
 *
 * Duplicate-call protection has two layers:
 * 1. In this process, concurrent requests for the same (field, note) share one
 *    in-flight LLM call (single-flight map below). A streaming client that joins
 *    late is caught up from the previews already produced.
 * 2. Across processes, the conditional write in repo.saveAiResult lets only the
 *    first result land; later writers return the stored value instead of their own.
 *
 * A new long note gets both results from one call, listed under both fields' keys,
 * so the UI's first request for its summary or tags joins that call instead of making another.
 */
export function createEnricher(repo: NotesRepo, ai: AiProvider): Enricher {
  const inFlight = new Map<string, LiveEnrichment>();
  const keyOf = (field: AiField, noteId: string) => `${field}:${noteId}`;

  /** Lists a running result under `key` until it settles, so requests for the same result join it. */
  function track(key: string, previews: ReplayLog<AiPreview>, note: Promise<Note | null>): LiveEnrichment {
    const flight = {
      previews,
      note: note.finally(() => {
        previews.close();
        inFlight.delete(key);
      }),
    };
    void flight.note.catch(() => {});
    inFlight.set(key, flight);
    return flight;
  }

  async function generate(
    noteId: string,
    field: AiField,
    overwrite: boolean,
    onText: (text: string) => void,
  ): Promise<Note | null> {
    const note = await repo.get(noteId);
    if (!note || (!overwrite && note[field] !== null)) return note;
    if (field === "summary") {
      const output = await follow(ai.summarize(note), onText);
      return repo.saveAiResult(noteId, { summary: toSummary(output, note.content) }, overwrite);
    }
    const output = await follow(ai.generateTags(note), onText);
    return repo.saveAiResult(noteId, { tags: toTags(output) }, overwrite);
  }

  function join(current: Note, field: AiField, regenerate: boolean): LiveEnrichment {
    if (!regenerate && current[field] !== null) return { previews: noPreviews, note: Promise.resolve(current) };

    const key = keyOf(field, current.id);
    const running = inFlight.get(key);
    if (running) return running;

    const previews = replayLog<AiPreview>();
    const write = previewWriter(previews);
    return track(key, previews, generate(current.id, field, regenerate, (text) => write(previewModelText(field, text))));
  }

  /**
   * One model call for both results of a new note, so its input tokens are paid for once.
   * Each result still has its own key, its own rule and its own conditional write,
   * so a summary that breaks its rule does not cost the tags.
   */
  function joinBoth(note: Note): LiveEnrichment[] {
    const summaryPreviews = replayLog<AiPreview>();
    const tagsPreviews = replayLog<AiPreview>();
    const writeSummary = previewWriter(summaryPreviews);
    const writeTags = previewWriter(tagsPreviews);
    const output = follow(ai.summarizeAndTag(note), (text) => {
      writeTags(previewModelText("tags", text));
      writeSummary(previewModelText("summary", text));
    });
    return [
      track(
        keyOf("summary", note.id),
        summaryPreviews,
        output.then((o) => repo.saveAiResult(note.id, { summary: toSummary(o, note.content) }, false)),
      ),
      track(keyOf("tags", note.id), tagsPreviews, output.then((o) => repo.saveAiResult(note.id, { tags: toTags(o) }, false))),
    ];
  }

  return {
    async open(noteId, field, { regenerate }) {
      const current = await repo.get(noteId);
      if (!current) return { previews: noPreviews, note: Promise.resolve(null) };
      if (field === "summary") assertSummarizable(current);
      return join(current, field, regenerate);
    },
    start(note) {
      // The note was just stored, so nothing is running for it yet.
      const flights = canSummarize(note.content) ? joinBoth(note) : [join(note, "tags", false)];
      // A failed call fails both of its results with the same error. Log it once.
      void Promise.allSettled(flights.map((flight) => flight.note)).then((results) => {
        new Set(results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []))).forEach(logServerError);
      });
    },
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()].map((flight) => flight.note));
    },
  };
}
