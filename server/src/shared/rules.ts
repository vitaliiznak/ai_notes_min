// Note limits and the text rules they are measured by. The web client imports this file too, so the form and
// the API measure a note the same way: no Node or server-only imports here.
// Mirrored by the CHECK constraints in notes/table.ts. Lengths are code points, like Postgres char_length.
export const TITLE_MAX = 200;
export const CONTENT_MAX = 50_000; // ~12k tokens: bounds LLM cost and latency per call
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

// Spaces, newlines, and zero-width padding (ZWSP, ZWNJ, word joiner, BOM). ZWJ is outside the class
// so it is not glued to the next character. It is included only so it can be stripped at the edges;
// a joiner in the middle of a family emoji is not at the edge and stays.
const EDGE_PAD = /(?:[\s\u200b\u200c\u2060\ufeff]|\u200d)/u;

/** Counts code points, as Postgres char_length does, so these rules and the CHECKs in table.ts agree on emoji. */
export function charLength(text: string): number {
  return [...text].length;
}

/**
 * Drops leading and trailing whitespace and zero-width padding, from the user's text and the model's alike.
 * The stored text is what the limits measure.
 */
export function trimPadding(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && EDGE_PAD.test(value[start]!)) start += 1;
  while (end > start && EDGE_PAD.test(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

export function canSummarize(content: string): boolean {
  return charLength(content) >= SUMMARY_MIN_CONTENT;
}

/** Longest summary that can be stored for this note: the cap, and at most 4/5 of the note. */
export function summaryCharLimit(content: string): number {
  const atMostFourFifths = Math.floor((charLength(content) * SUMMARY_NOTE_NUMERATOR) / SUMMARY_NOTE_DENOMINATOR);
  return Math.min(SUMMARY_MAX_CHARS, atMostFourFifths);
}
