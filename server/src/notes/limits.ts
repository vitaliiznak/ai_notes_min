// Mirrored by the CHECK constraints in table.ts. Lengths are code points, like Postgres char_length.
// The web client imports this file so the form and the API measure a note the same way.
export const TITLE_MAX = 200;
export const CONTENT_MAX = 20_000; // ~5k tokens: bounds LLM cost and latency per call
// About a few sentences, with room for a long name or number. A longer text is not a summary.
// "A few sentences" is prompt guidance. Nothing counts sentences.
export const SUMMARY_MAX_CHARS = 590;
// At most 4/5 of the note, so a stored summary is at least 20% shorter. Anything longer is not stored.
export const SUMMARY_NOTE_NUMERATOR = 4;
export const SUMMARY_NOTE_DENOMINATOR = 5;
export const TAG_MAX_LENGTH = 40;
// A blank list is not a result. Up to a few; fewer is fine.
export const TAGS_MIN = 1;
export const TAGS_MAX = 5;
// Below this a note is about as long as a summary of it, so it gets tags only.
export const SUMMARY_MIN_CONTENT = 500;

// Spaces, newlines, and zero-width padding. ZWJ is included only so it can be stripped at the edges;
// a joiner in the middle of a family emoji is not at the edge and stays.
const EDGE_PAD = /[\s\u200b\u200c\u200d\u2060\ufeff]/u;

/** Counts code points, as Postgres char_length does, so these rules and the CHECKs in table.ts agree on emoji. */
export function charLength(text: string): number {
  return [...text].length;
}

function stripEdges(value: string, trimEnd: boolean): string {
  let start = 0;
  let end = value.length;
  while (start < end && EDGE_PAD.test(value[start]!)) start += 1;
  if (trimEnd) {
    while (end > start && EDGE_PAD.test(value[end - 1]!)) end -= 1;
  }
  return value.slice(start, end);
}

/** Drops leading and trailing whitespace and zero-width padding. The stored note is what the limits measure. */
export function normalizeUserText(value: string): string {
  return stripEdges(value, true);
}

/** Drops leading padding and keeps a trailing space, for text the model is still writing. */
export function stripLeadingPad(value: string): string {
  return stripEdges(value, false);
}

export function canSummarize(content: string): boolean {
  return charLength(content) >= SUMMARY_MIN_CONTENT;
}

/** Longest summary that can be stored for this note: the cap, and at most 4/5 of the note. */
export function summaryCharLimit(content: string): number {
  const atMostFourFifths = Math.floor((charLength(content) * SUMMARY_NOTE_NUMERATOR) / SUMMARY_NOTE_DENOMINATOR);
  return Math.min(SUMMARY_MAX_CHARS, atMostFourFifths);
}

export interface Note {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  tags: string[] | null;
  createdAt: string;
}

export type NoteListItem = Pick<Note, "id" | "title" | "tags" | "createdAt">;

/** The AI results a note can carry; also the column names that store them. */
export type AiField = "summary" | "tags";

/** A summary or tag list as shown while the model is still writing it. */
export type AiPreview = { summary: string } | { tags: string[] };
