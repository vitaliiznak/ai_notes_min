import { parse } from "partial-json";
import { AiError, type AiProvider, type OnText, type SummaryAndTagsOutput } from "../ai/provider.js";
import { HttpError, logServerError } from "../errors.js";
import type { NotesRepo } from "./repo.js";
import {
  canSummarize,
  charLength,
  normalizeUserText,
  SUMMARY_MAX_CHARS,
  SUMMARY_MIN_CONTENT,
  summaryCharLimit,
  TAG_MAX_LENGTH,
  TAGS_MAX,
  TAGS_MIN,
} from "./limits.js";
import type { AiField, AiPreview, Note } from "./types.js";

/**
 * Business rule: one non-blank text no longer than summaryCharLimit(content).
 * Applies to every provider. A miss is not stored, so the next request tries again.
 */
export function toSummary(output: { summary?: string }, content: string): string {
  const summary = normalizeUserText(output.summary ?? "");
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

// Lowercase, no leading "#" or padding, whitespace collapsed and trimmed.
function normalizeTag(raw: string): string {
  return normalizeUserText(normalizeUserText(raw).replace(/^#+/, "")).replace(/\s+/g, " ").toLowerCase();
}

const fitsTag = (tag: string) => charLength(tag) > 0 && charLength(tag) <= TAG_MAX_LENGTH;

/** Lowercase, strip #, collapse whitespace, drop empties and over-long tags, dedupe, keep 5. */
function normalizeTags(raw: string[]): string[] {
  return [...new Set(raw.map(normalizeTag).filter(fitsTag))].slice(0, TAGS_MAX);
}

/** Business rule: 1–5 distinct, normalized tags. Extras beyond 5 are dropped (the model ranks by relevance). */
export function toTags(output: { tags?: string[] }): string[] {
  const tags = normalizeTags(output.tags ?? []);
  if (tags.length < TAGS_MIN) {
    throw new AiError("invalid_output", `Expected at least ${TAGS_MIN} ${TAGS_MIN === 1 ? "tag" : "tags"}.`);
  }
  return tags;
}

/**
 * Readable slice of the model's JSON so far (partial-json also reads a string it is still writing),
 * normalized the way it will be stored. Not validated; the finished output still goes through toSummary/toTags.
 */
export function previewModelText(field: AiField, text: string): AiPreview | null {
  let value: unknown;
  try {
    value = parse(text)?.[field];
  } catch {
    return null;
  }
  if (field === "summary") {
    const summary = typeof value === "string" ? normalizeUserText(value) : "";
    return summary ? { summary } : null;
  }
  const tags = Array.isArray(value) ? normalizeTags(value.filter((tag) => typeof tag === "string")) : [];
  return tags.length > 0 ? { tags } : null;
}

/** One AI result: previews while the model writes it, then the note with the result saved. */
export interface AiRun {
  /** Calls `onPreview` with the latest preview, if any, then with each new one. Returns a function that stops it. */
  watch(onPreview: (preview: AiPreview) => void): () => void;
  /** Null when the note does not exist. */
  note: Promise<Note | null>;
}

const finished = (note: Note | null): AiRun => ({ watch: () => () => {}, note: Promise.resolve(note) });

/**
 * Previews of one field, built from the model's text as it arrives. Each preview is the whole field so far,
 * so a request that joins late only needs the latest one.
 */
function livePreviews(field: AiField) {
  let text = "";
  let latest: AiPreview | null = null;
  const listeners = new Set<(preview: AiPreview) => void>();
  return {
    onText(delta: string) {
      text += delta;
      const preview = previewModelText(field, text);
      if (!preview || JSON.stringify(preview) === JSON.stringify(latest)) return;
      latest = preview;
      listeners.forEach((listener) => listener(preview));
    },
    watch(listener: (preview: AiPreview) => void) {
      if (latest) listener(latest);
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export interface Enricher {
  /**
   * The note's stored result, or the run that produces it. A JSON client awaits `note`; a streaming one also
   * watches its previews. Resolves to a null note when the note does not exist.
   */
  open(noteId: string, field: AiField, opts: { regenerate: boolean }): Promise<AiRun>;
  /**
   * Starts what a new note gets: tags, plus a summary when it is long enough, from one model call.
   * Does not wait. A request for either field joins the running call. A failure is logged and not
   * stored, so the next request tries again.
   */
  start(note: Note): void;
  /** Resolves once no AI call is running. */
  idle(): Promise<void>;
}

/**
 * Generates and caches AI results on notes.
 *
 * Duplicate-call protection has two layers:
 * 1. In this process, requests for the same (field, note) share one run while it lasts (`runs` below).
 * 2. Across processes, the conditional write in repo.saveAiResult lets only the first result land;
 *    later writers get the stored value back instead of their own.
 */
export function createEnricher(repo: NotesRepo, ai: AiProvider): Enricher {
  const runs = new Map<string, AiRun>();
  const keyOf = (field: AiField, noteId: string) => `${field}:${noteId}`;

  /** The provider call that writes these fields. Both at once is what a new long note gets, so its input tokens are paid for once. */
  function generate(note: Note, fields: AiField[], onText: OnText): Promise<Partial<SummaryAndTagsOutput>> {
    if (fields.length === 2) return ai.summarizeAndTag(note, onText);
    return fields[0] === "summary" ? ai.summarize(note, onText) : ai.generateTags(note, onText);
  }

  /**
   * One model call for the given fields of a note. Each field gets its own run, its own rule and its own
   * conditional write, so a summary that breaks its rule does not cost the tags. A run stays listed until
   * it settles, so a request for the same result joins it.
   */
  function run(noteId: string, fields: AiField[], overwrite: boolean): AiRun[] {
    const previews = fields.map((field) => livePreviews(field));
    const generated = (async () => {
      // Read again: a run that ended while this request was looking up the note may have stored the result.
      const note = await repo.get(noteId);
      if (!note || (!overwrite && fields.every((field) => note[field] !== null))) return { note, output: null };
      const output = await generate(note, fields, (delta) => previews.forEach((preview) => preview.onText(delta)));
      return { note, output };
    })();

    return fields.map((field, i) => {
      const key = keyOf(field, noteId);
      const saved = generated.then(({ note, output }) => {
        if (!note || !output) return note;
        const result = field === "summary" ? { summary: toSummary(output, note.content) } : { tags: toTags(output) };
        return repo.saveAiResult(noteId, result, overwrite);
      });
      const run: AiRun = {
        watch: previews[i]!.watch,
        note: saved.finally(() => {
          if (runs.get(key) === run) runs.delete(key);
        }),
      };
      // Requests that read the run see its failure. One that nobody reads must not crash the process.
      void run.note.catch(() => {});
      runs.set(key, run);
      return run;
    });
  }

  return {
    async open(noteId, field, { regenerate }) {
      const note = await repo.get(noteId);
      if (!note) return finished(null);
      // Business rule: short notes get tags only. Mirrored by notes_summary_min_content_chk in table.ts.
      if (field === "summary" && !canSummarize(note.content)) {
        throw new HttpError(422, "note_too_short", `Notes under ${SUMMARY_MIN_CONTENT} characters are not summarized.`);
      }
      if (!regenerate && note[field] !== null) return finished(note);
      // A regenerate joins a running call too: the model is already writing a new result.
      return runs.get(keyOf(field, noteId)) ?? run(noteId, [field], regenerate)[0]!;
    },
    start(note) {
      // The note was just stored, so nothing is running for it yet. A short note gets tags only:
      // a summary of it would be about as long as the note, and the CHECK rejects storing one.
      const fields: AiField[] = canSummarize(note.content) ? ["summary", "tags"] : ["tags"];
      // A failed call fails each of its fields with the same error. Log each distinct failure once.
      void Promise.allSettled(run(note.id, fields, false).map((r) => r.note)).then((results) => {
        const failures = new Set(results.flatMap((r) => (r.status === "rejected" ? [r.reason] : [])));
        failures.forEach(logServerError);
      });
    },
    async idle() {
      while (runs.size > 0) await Promise.allSettled([...runs.values()].map((r) => r.note));
    },
  };
}
